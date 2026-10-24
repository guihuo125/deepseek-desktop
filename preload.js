
const { contextBridge, ipcRenderer } = require("electron");

// 只暴露无害的元信息。
// executeCode / checkCode / setGlmConfig 这些能力接口曾经也挂在这里，
// 但页面里没有任何代码调用它们 —— 全部由本文件的 preload 代码直接用 ipcRenderer 完成。
// 把它们暴露给 chat.deepseek.com 这个远程上下文，等于给一次 DeepSeek 端 XSS
// 递上「读本地任意文件 + 改写 GLM API Key」的能力，收益为零、风险极高。
contextBridge.exposeInMainWorld("deepseekDesktop", {
  version: require("./package.json").version,
  platform: process.platform
});

// ============ 状态 ============
var autoChain = 0;              // 当前自动执行链的计数（只有自动执行消耗配额，手动点击不算）
var MAX_CHAIN = 3;              // 单链最多自动执行 3 次
var pendingBlocks = {};         // { id: { code, block, timer } }

// 已处理过的代码块。
// 用 WeakSet 按 <pre> 元素记账：元素随对话被 React 回收时记录自动消失。
// 旧实现用普通对象 + "攒够 100 条整表清空"，清空之后已经执行过的块
// 会在下一轮扫描里被重新执行一遍 —— 长对话下必然触发。
var processedEls = new WeakSet();
var processedIds = new Map();   // 兜底：没有 DOM 元素的调用路径
var MAX_PROCESSED_IDS = 300;

// 只扫正在变化的 <pre>，不再每 2 秒全量扫 document.body
var activePres = new Set();
var scanTimer = null;
var __stylesInjected = false;

function markProcessed(block, id) {
  if (block) { processedEls.add(block); return; }
  processedIds.set(id, true);
  if (processedIds.size > MAX_PROCESSED_IDS) {
    // 只淘汰最旧的一条，不整表清空
    processedIds.delete(processedIds.keys().next().value);
  }
}

function isProcessed(block, id) {
  if (block) return processedEls.has(block);
  return processedIds.has(id);
}

// ============ 注入 CSS 动画（仅一次）============
function ensureStyles() {
  if (__stylesInjected) return;
  __stylesInjected = true;
  var style = document.createElement("style");
  style.setAttribute("data-adshield-styles", "1");
  style.textContent =
    "@keyframes adshield-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }" +
    ".adshield-run-status.loading::before {" +
    "  content: \"\";" +
    "  display: inline-block;" +
    "  width: 10px; height: 10px;" +
    "  border: 2px solid #4f46e5;" +
    "  border-top-color: transparent;" +
    "  border-radius: 50%;" +
    "  margin-right: 6px;" +
    "  vertical-align: -1px;" +
    "  animation: adshield-spin 0.8s linear infinite;" +
    "}" +
    ".adshield-run-btn:disabled { cursor: wait; }";
  document.head.appendChild(style);
}

// ============ 用户手动输入监听（重置自动执行链）============
document.addEventListener("input", function(e) {
  if (e.target && e.target.tagName === "TEXTAREA" && !window.__adshieldSelfSend) {
    autoChain = 0;
  }
}, true);

// ============ 初始化 ============
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

function init() {
  injectGLMUI();
  console.log("[DeepSeek Desktop] preload 注入成功 (自动模式)");
  ensureStyles();

  // ★ 网络 hook 触发已禁用（DeepSeek 分片 XHR 无法可靠累积）
  //   保留 probe.js 继续打印日志（研究用），但不用它触发执行
  // initNetworkListener();

  // 增量扫描：只处理 MutationObserver 报告有变化的 <pre>。
  // 旧实现是「MutationObserver 打个标记 + 每 2 秒全量扫 document.body」，
  // 而全量扫描会对每个 <pre> 向上遍历 4~5 层父节点并读 innerText（触发强制重排）。
  // DeepSeek 长对话里有几百个 <pre>，等于每 2 秒把整页重排一次。
  var observer = new MutationObserver(function(mutations) {
    for (var i = 0; i < mutations.length; i++) collectPresFromMutation(mutations[i]);
    scheduleScan();
  });
  // characterData 必须监听：流式输出时 DeepSeek 常常只改已有 <pre> 里的文本节点，
  // 不新增元素，只听 childList 会漏掉正在增长中的代码块
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  // 首屏兜底：注入时页面上可能已经渲染好了历史代码块
  setTimeout(function() { scan(document.body); }, 2000);
}

// GLM 面板和它的设置弹层是注入层自己的 DOM，不是 AI 回复里的代码块。
// 它们混进扫描环有两个代价：白烧 CPU（面板每次渲染都触发 characterData），
// 以及万一 GLM 回复里写了 bash(...) 示例，会被当成待执行代码自动跑起来。
function isInjectedUI(el) {
  return !!(el && el.closest && el.closest("#adshield-ai-sidebar, #adshield-glm-settings"));
}

// 从一条 mutation 记录里收集受影响的 <pre>
function collectPresFromMutation(m) {
  var t = m.target;
  // characterData 的 target 是文本节点（没有 closest），要用 parentElement
  var el = (t && t.nodeType === 1) ? t : (t && t.parentElement);
  if (isInjectedUI(el)) return;
  if (el && el.closest) {
    var p = el.closest("pre");
    if (p) activePres.add(p);
  }
  var added = m.addedNodes;
  for (var i = 0; added && i < added.length; i++) {
    var node = added[i];
    if (node.nodeType !== 1) continue;
    if (isInjectedUI(node)) continue;
    if (node.tagName === "PRE") activePres.add(node);
    var inner = node.querySelectorAll ? node.querySelectorAll("pre") : null;
    for (var j = 0; inner && j < inner.length; j++) activePres.add(inner[j]);
  }
  var removed = m.removedNodes;
  for (var k = 0; removed && k < removed.length; k++) {
    var rn = removed[k];
    if (rn.nodeType === 1 && rn.tagName === "PRE") activePres.delete(rn);
  }
}

function scheduleScan() {
  if (activePres.size === 0) return;
  if (scanTimer) clearTimeout(scanTimer);
  scanTimer = setTimeout(flushScan, 600);
}

function flushScan() {
  scanTimer = null;
  var list = Array.from(activePres);
  activePres.clear();
  for (var i = 0; i < list.length; i++) {
    if (list[i].isConnected) scanPre(list[i]);
  }
  // 内容还在变的话，characterData 会把它重新塞回 activePres，
  // 页面静止时这里就是空转一次，不再有常驻的定时全量扫描
}

// ============ 从纯文本提取 cuckoo 代码块（网络 hook 版）============
function extractCuckooBlock(text) {
  if (!text) return null;
  // 匹配 ```cuckoo ... ``` （含大小写）
  var re = /```cuckoo\s*([\s\S]*?)```/i;
  var m = text.match(re);
  if (!m) return null;
  var code = (m[1] || "").trim();
  if (!code) return null;
  // 检查是否含工具调用
  var tools = ["bash(", "pwsh(", "python(", "read(", "write(", "edit(", "glob(", "grep("];
  var hasTool = false;
  for (var t = 0; t < tools.length; t++) {
    if (code.indexOf(tools[t]) !== -1) { hasTool = true; break; }
  }
  if (!hasTool) return null;
  return code;
}

// ============ 从网络 hook 收到的 AI 回复文本触发执行 ============
function onNetworkReply(fullText) {
  var code = extractCuckooBlock(fullText);
  if (!code) {
    console.log("[DeepSeek Desktop] 网络回复无 cuckoo 代码块");
    return;
  }
  console.log("[DeepSeek Desktop] 从网络回复提取到代码块:", JSON.stringify(code.substring(0, 150)));

  // 尝试从 DOM 找到对应的 pre（用于状态栏注入）
  var block = findPreByCode(code);
  if (!block) {
    console.log("[DeepSeek Desktop] 未找到对应 DOM 元素，状态栏不可见（但代码会执行）");
  }

  // 消息级去重：用完整文本 hash 作为"消息ID"
  var msgId = hashStr("net-" + fullText.substring(0, 300));
  var id = hashStr("block-" + code);
  if (isProcessed(block, id)) {
    console.log("[DeepSeek Desktop] 代码块已处理，跳过");
    return;
  }

  scheduleExecute(block, code, id);
}

// 用代码文本模糊匹配 DOM 里的 <pre>
function findPreByCode(code) {
  var pres = document.querySelectorAll("pre");
  var needle = code.substring(0, 60);
  for (var i = 0; i < pres.length; i++) {
    var el = pres[i].querySelector("code") || pres[i];
    var t = (el.innerText || el.textContent || "").trim();
    if (t.indexOf(needle) !== -1 || needle.indexOf(t.substring(0, 60)) !== -1) {
      return pres[i];
    }
  }
  return null;
}

// ============ 监听主世界 postMessage ============
function initNetworkListener() {
  window.addEventListener("message", function(ev) {
    if (!ev.data || typeof ev.data !== "object") return;
    if (ev.data.__adshield_ai_reply) {
      console.log("[DeepSeek Desktop] 收到网络回复，长度:", (ev.data.text || "").length);
      onNetworkReply(ev.data.text || "");
    }
  });
}

// ============ 扫描 cuckoo 代码块 ============

// 全量扫描，只在首屏兜底时调用一次
function scan(root) {
  if (!root || !root.querySelectorAll) return;
  var pres = root.querySelectorAll("pre");
  for (var i = 0; i < pres.length; i++) scanPre(pres[i]);
}

// 单个 <pre> 的判定与调度。增量扫描时只对变化过的元素调用这个。
function scanPre(pre) {
  if (!pre || pre.nodeType !== 1 || pre.tagName !== "PRE") return;
  if (isInjectedUI(pre)) return;

  // 廉价前置：真正的 cuckoo 块里 codeText 必然含 "bash(" 这类工具调用，
  // 而工具名的字母本体在任何编码变形下都存在（实体化的 bash&#40;、
  // 全角括号的 bash（ 都含 "bash"），所以只查名字不会漏判，最多让少数提到
  // 工具名的说明文本多走一遍后面的完整判定。
  // 这一步把绝大多数普通代码块挡在祖先遍历与全量清洗之前。
  // 先摘掉零宽字符和 &nbsp;：语法高亮可能在 token 之间插它们，
  // 后面的 sanitizeCode 会清，前置判定若不清就会漏掉 ba<零宽>sh( 这种块。
  var preText = (pre.textContent || "").replace(/[\u200B-\u200D\uFEFF\u00A0]/g, "");
  var TOOL_WORDS = ["bash", "pwsh", "python", "read", "write", "edit", "glob", "grep", "log", "sleep"];
  var maybeTool = false;
  for (var tw = 0; tw < TOOL_WORDS.length; tw++) {
    if (preText.indexOf(TOOL_WORDS[tw]) !== -1) { maybeTool = true; break; }
  }
  if (!maybeTool) return;

  // 检查父元素（往上 4 层）是否含 "cuckoo"
  var hasCuckoo = false;
  var node = pre;
  for (var up = 0; up < 4; up++) {
    if (!node.parentElement) break;
    node = node.parentElement;
    var t = (node.innerText || node.textContent || "");
    if (t.toLowerCase().indexOf("cuckoo") !== -1) { hasCuckoo = true; break; }
  }
  if (!hasCuckoo) return;

  // 提取代码（优先 code 子元素，否则用 pre 本身）
  var codeEl = pre.querySelector("code") || pre;
  var codeText = (codeEl.innerText || codeEl.textContent || "").trim();
  // 解码 HTML 实体（避免 &quot; 等污染代码）
  codeText = decodeHtmlEntities(codeText);
  // 清理零宽字符 + 全角标点
  codeText = sanitizeCode(codeText);
  console.log("[DeepSeek Desktop] 提取代码:", JSON.stringify(codeText.substring(0, 200)));

  // ★ 过滤：跳过系统提示 / 说明性代码块
  var blockContainer = pre;
  for (var up2 = 0; up2 < 5; up2++) {
    if (!blockContainer.parentElement) break;
    blockContainer = blockContainer.parentElement;
  }
  var containerText = (blockContainer.innerText || blockContainer.textContent || "");
  var skipMarkers = [
    "你是由 Cuckoo Code 驱动",
    "你是由Cuckoo",
    "你有完整的本地执行权限",
    "核心机制",
    "可用工具：",
    "可用工具:",
    "bash(命令)",
    "bash(命令）",
    "pwsh(命令)",
    "python(代码)",
    "示例：",
    "示例:",
    "规则：只输出安全",
    "规则: 只输出安全",
    "代码块最后请用"
  ];
  for (var sm = 0; sm < skipMarkers.length; sm++) {
    if (containerText.indexOf(skipMarkers[sm]) !== -1) {
      console.log("[DeepSeek Desktop] 跳过系统提示块");
      return;
    }
  }

  // ★ 严格过滤：代码必须真的"像代码"
  var TOOL_MARKERS = ["bash(", "pwsh(", "python(", "read(", "write(", "edit(", "glob(", "grep(", "log(", "sleep("];
  var looksLikeCode = false;
  for (var tt = 0; tt < TOOL_MARKERS.length; tt++) {
    if (codeText.indexOf(TOOL_MARKERS[tt]) !== -1) { looksLikeCode = true; break; }
  }
  if (!looksLikeCode) {
    console.log("[DeepSeek Desktop] 跳过（无工具调用）:", JSON.stringify(codeText.substring(0, 80)));
    return;
  }
  if (codeText.length < 10) {
    console.log("[DeepSeek Desktop] 跳过（太短）:", JSON.stringify(codeText));
    return;
  }
  if (!/[;{}(=]/.test(codeText) && codeText.indexOf("\\n") === -1) {
    console.log("[DeepSeek Desktop] 跳过（无代码特征）:", JSON.stringify(codeText.substring(0, 80)));
    return;
  }

  // 去掉可能的包裹符号
  var prefix = "```cuckoo";
  if (codeText.indexOf(prefix) === 0) codeText = codeText.substring(prefix.length).trim();
  var suffix = "```";
  if (codeText.lastIndexOf(suffix) === codeText.length - 3) codeText = codeText.substring(0, codeText.length - 3).trim();

  // 去掉按钮文字
  var junk = ["复制", "下载", "Copy", "Download", "cuckoo"];
  for (var j = 0; j < junk.length; j++) {
    if (codeText.indexOf(junk[j]) === 0) codeText = codeText.substring(junk[j].length).trim();
  }
  if (!codeText) return;

  // ★ 消息级去重：只检查（不设置，等执行时设置）
  var msgEl = pre.closest && pre.closest(".ds-message");
  if (msgEl && msgEl.getAttribute("data-adshield-done") === "1") {
    console.log("[DeepSeek Desktop] 同一消息已有代码块在执行，跳过");
    return;
  }

  // ★ 用 pre 元素 ID（内容变了也用同一个 id，debounce 会重置 timer）
  if (!pre.getAttribute("data-adshield-id")) {
    window.__adshield_seq = (window.__adshield_seq || 0) + 1;
    pre.setAttribute("data-adshield-id", "pre-" + window.__adshield_seq);
  }
  var id = pre.getAttribute("data-adshield-id");
  if (isProcessed(pre, id)) return;
  scheduleExecute(pre, codeText, id);
}

// ============ Debounce：等内容稳定 800ms 后执行 ============
function scheduleExecute(block, code, id) {
  if (pendingBlocks[id]) {
    if (pendingBlocks[id].code === code) {
      return;
    }
    clearTimeout(pendingBlocks[id].timer);
  }
  pendingBlocks[id] = {
    code: code,
    block: block,
    timer: setTimeout(function() {
      delete pendingBlocks[id];
      autoExecute(block, code, id);
    }, 800)
  };
}

// ============ 自动执行 ============
function statusForResult(result, verb) {
  if (result && result.ok) return "✅ " + verb + "，已通知 AI";
  if (result && /未设置工作区/.test(String(result.error || ""))) {
    return "⚠ 请先选择工作区（左上角文件夹图标）";
  }
  return "❌ 执行失败，已发送错误报告";
}

async function autoExecute(block, code, id, force) {
  if (!force && isProcessed(block, id)) return;
  markProcessed(block, id);

  // ★ 执行前设置消息标记（防止同消息的后续代码块也执行）
  if (!force && block) {
    var msgEl = block.closest && block.closest(".ds-message");
    if (msgEl) {
      if (msgEl.getAttribute("data-adshield-done") === "1") {
        console.log("[DeepSeek Desktop] 消息已被其他代码块占用，跳过");
        return;
      }
      msgEl.setAttribute("data-adshield-done", "1");
    }
  }

  // 链上限只在自动执行时消耗，用户手点"手动执行"不计入配额
  if (!force) {
    if (autoChain >= MAX_CHAIN) {
      injectButton(block, code, id, "已达自动执行上限（" + MAX_CHAIN + "），请手动点击");
      return;
    }
    autoChain++;
  }

  // 检查危险等级
  var check;
  try {
    check = await ipcRenderer.invoke("check-cuckoo", { code: code });
  } catch (e) {
    injectButton(block, code, id, "检查失败: " + e.message);
    return;
  }

  if (check.level === "forbidden") {
    injectButton(block, code, id, "禁止的命令: " + (check.reasons[0] || ""));
    return;
  }

  if (check.level === "dangerous") {
    // 危险命令 → 弹窗确认
    var confirmResult = await ipcRenderer.invoke("execute-cuckoo", {
      code: code, blockId: id + "-confirm", reasons: check.reasons
    });
    if (confirmResult.status === "cancelled") {
      injectButton(block, code, id, "已取消");
      return;
    }
    injectButton(block, code, id, statusForResult(confirmResult, "完成"));
    await sendToInput(formatResult(confirmResult));
    return;
  }

  // 安全命令 → 直接执行
  var statusEl = block ? injectButton(block, code, id, "自动执行中...") : null;

  try {
    var result = await ipcRenderer.invoke("execute-cuckoo", { code: code, blockId: id });
    updateStatus(statusEl, statusForResult(result, "已执行"));
    await sendToInput(formatResult(result));
  } catch (e) {
    updateStatus(statusEl, "❌ 调用异常，已发送错误报告");
    await sendToInput("【JS 执行结果汇总】\n—— 脚本 1 ——\n❌ 失败\n错误原因: " + e.message);
  }

  // 更新按钮文字为"再次执行"
  try {
    var wrap = statusEl && statusEl.parentElement;
    if (wrap) {
      var mb = wrap.querySelector(".adshield-run-btn");
      if (mb) {
        var txt = (statusEl.textContent || "");
        if (/已执行|已完成|已取消/.test(txt)) {
          mb.textContent = mb.textContent.indexOf("▶") === 0 ? "↻ 再次执行" : "再次执行";
        }
      }
    }
  } catch (e) {}
}

// ============ 在代码块下方插入状态栏 ============
function injectButton(block, code, id, statusText) {
  if (!block) return null;
  var parent = block.closest("pre") || block.parentElement;
  if (!parent) return null;
  var grandparent = parent.parentElement;
  if (!grandparent) return null;

  // wrapper 可能被注入到原生操作栏（不在 grandparent 内），改为全局查找。
  // id 形如 pre-<序号>，用属性选择器直接命中，不必遍历页面上所有已注入的块
  var existing = document.querySelector('[data-cuckoo-id="' + id + '"]');
  if (existing) {
    var existingStatus = existing.querySelector(".adshield-run-status");
    if (existingStatus && statusText) existingStatus.textContent = statusText;
    return existingStatus;
  }

  // ★ 找 DeepSeek 原生操作栏（含赞/踩/复制的容器）
  var actionBar = findDeepSeekActionBar(parent);

  if (actionBar) {
    // 融入原生操作栏：只插入状态文字 + 小图标按钮
    var wrapper = document.createElement("span");
    wrapper.setAttribute("data-cuckoo-id", id);
    wrapper.className = "adshield-run-bar";
    wrapper.style.cssText = "display:inline-flex;align-items:center;gap:6px;margin-left:auto;align-self:center;flex-shrink:0;vertical-align:middle;";

    var status = document.createElement("span");
    status.className = "adshield-run-status";
    status.style.cssText = "color:#6b7280;font-size:12px;line-height:1;white-space:nowrap;";
    status.textContent = statusText || "";
    if (/执行中/.test(statusText || "")) status.classList.add("loading");

    // 手动执行按钮（融入操作栏样式）
    var btn = document.createElement("button");
    btn.className = "adshield-run-btn";
    btn.textContent = "手动执行";
    btn.style.cssText = "padding:2px 8px;background:transparent;color:#4f46e5;border:1px solid #4f46e5;border-radius:12px;cursor:pointer;font-size:11px;line-height:1.4;";
    btn.onclick = async function() {
      btn.disabled = true;
      btn.textContent = "执行中";
      btn.style.opacity = "0.5";
      btn.style.cursor = "wait";
      try {
        await autoExecute(block, code, id, true);
      } finally {
        // ★ 无论成功/失败/提前 return，都恢复按钮
        btn.disabled = false;
        btn.style.opacity = "";
        btn.style.cursor = "";
        // 已执行过 → "再次执行"，否则 → "手动执行"
        var stText = (status.textContent || "");
        btn.textContent = /已执行|已完成|已取消/.test(stText) ? "再次执行" : "手动执行";
      }
    };

    wrapper.appendChild(status);
    wrapper.appendChild(btn);

    try {
      actionBar.appendChild(wrapper);
    } catch (e) {
      console.error("[DeepSeek Desktop] 插入操作栏失败:", e);
    }
    return status;
  }

  // 兜底：原生操作栏找不到 → 用旧方案（代码块下方）
  var btnBar = document.createElement("div");
  btnBar.setAttribute("data-cuckoo-id", id);
  btnBar.className = "adshield-run-bar";
  btnBar.style.cssText = "display:flex;gap:8px;margin:8px 0;align-items:center;font-size:12px;";

  var status2 = document.createElement("span");
  status2.className = "adshield-run-status";
  status2.style.cssText = "color:#6b7280;font-size:12px;";
  status2.textContent = statusText || "";
  if (/执行中/.test(statusText || "")) status2.classList.add("loading");

  var btn2 = document.createElement("button");
  btn2.className = "adshield-run-btn";
  btn2.textContent = "▶ 手动执行";
  btn2.style.cssText = "padding:4px 10px;background:#4f46e5;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;";
  btn2.onclick = async function() {
    btn2.disabled = true;
    btn2.textContent = "执行中";
    btn2.style.opacity = "0.5";
    btn2.style.cursor = "wait";
    try {
      await autoExecute(block, code, id, true);
    } finally {
      btn2.disabled = false;
      btn2.style.opacity = "";
      btn2.style.cursor = "";
      var stText2 = (status2.textContent || "");
      btn2.textContent = /已执行|已完成|已取消/.test(stText2) ? "↻ 再次执行" : "▶ 手动执行";
    }
  };

  btnBar.appendChild(status2);
  btnBar.appendChild(btn2);
  try {
    grandparent.insertBefore(btnBar, parent.nextSibling);
  } catch (e) {
    console.error("[DeepSeek Desktop] 插入状态栏失败:", e);
  }
  return status2;
}

// ★ 查找 DeepSeek 原生操作栏（含赞/踩/复制图标）
// 找 DeepSeek 原生操作栏所在的那一行（含复制/重试/点赞/朗读等图标按钮的 flex 行）
// 真实 DOM 结构（2026-10 实测）：
//   <div class="_4f9bf79 ...">                ← 消息体 body
//     <div class="ds-message">…markdown（含 <pre>）…</div>
//     <div class="ds-flex _0a3d93b">         ← 整行容器（宽 758，含下面的图标行）
//       <div class="ds-flex _965abe9 …">     ← 图标按钮行（仅 218 宽）
//   </div>
// 说明：图标按钮是 div[role=button]（不是 <button>）；代码块的复制/下载在 md-code-block
// 内部，必须排除，否则会插错位置。优先选"宽度接近整行"的容器，这样状态栏能用
// margin-left:auto 贴到该行右端；找不到再退回最深容器。
function findDeepSeekActionBar(preEl) {
  var msgEl = (preEl && preEl.closest) ? preEl.closest(".ds-message") : null;
  if (!msgEl) return null;
  var body = msgEl.parentElement;
  if (!body) return null;

  // node.querySelector(...) 在这个 DFS 里对每个节点重扫一遍子树，整棵树是 O(n²)；
  // 长回答里消息容器子树很大，定位一次操作栏能触发上百次子树查询。
  // 预先算出「子树含 pre」「子树含按钮」两个集合：
  // node.querySelector(x) 命中 ⟺ node 是某个 x 本身或它的祖先，严格等价。
  var hasPre = new Set();
  var pres = body.querySelectorAll("pre");
  for (var pi = 0; pi < pres.length; pi++) {
    for (var an = pres[pi]; an; an = an.parentElement) { hasPre.add(an); if (an === body) break; }
  }
  var hasBtn = new Set();
  var btns = body.querySelectorAll('[role="button"]');
  for (var bi = 0; bi < btns.length; bi++) {
    for (var bn = btns[bi]; bn; bn = bn.parentElement) { hasBtn.add(bn); if (bn === body) break; }
  }

  var candidates = [];
  var stack = [{ node: body, depth: 0 }];
  while (stack.length) {
    var item = stack.pop();
    var node = item.node, depth = item.depth;
    // 排除消息内容子树（含代码块按钮区）和任何含 pre 的节点
    if (!msgEl.contains(node) && !hasPre.has(node) && hasBtn.has(node)) {
      candidates.push({ node: node, depth: depth });
    }
    for (var i = 0; i < node.children.length; i++) {
      stack.push({ node: node.children[i], depth: depth + 1 });
    }
  }

  // display 与 height 要读计算样式和几何信息，原来在整棵树上逐个触发；
  // 过滤条件不变，只是挪到候选收集之后，对小批量节点各算一次
  var sizedCandidates = [];
  for (var ci = 0; ci < candidates.length; ci++) {
    var cnode = candidates[ci].node;
    if (getComputedStyle(cnode).display !== "flex") continue;
    var ch = cnode.getBoundingClientRect().height;
    if (ch > 0 && ch < 80) sizedCandidates.push(candidates[ci]);
  }
  candidates = sizedCandidates;

  var bodyW = body.getBoundingClientRect().width;
  var chosen = null;
  // 1) 优先：宽度接近整行的最浅容器（能贴到行右端）
  for (var k = 0; k < candidates.length; k++) {
    var c = candidates[k];
    var w = c.node.getBoundingClientRect().width;
    if (bodyW > 0 && w >= bodyW * 0.6) {
      if (!chosen || c.depth < chosen.depth) chosen = c;
    }
  }
  // 2) 退而求其次：层数最深（最贴近图标行）
  if (!chosen) {
    for (var m = 0; m < candidates.length; m++) {
      if (!chosen || candidates[m].depth > chosen.depth) chosen = candidates[m];
    }
  }
  if (chosen) return chosen.node;

  // 3) 最终兜底：旧启发式（向上找含 3+ 图标按钮的容器）
  var node2 = preEl;
  for (var d = 0; d < 10 && node2; d++) {
    var iconBtns = node2.querySelectorAll(".ds-button--icon");
    if (iconBtns.length >= 3) {
      var commonParent = iconBtns[0].parentElement;
      for (var j = 1; j < iconBtns.length; j++) {
        while (commonParent && !commonParent.contains(iconBtns[j])) {
          commonParent = commonParent.parentElement;
        }
      }
      if (commonParent && commonParent.children.length >= 3) return commonParent;
    }
    node2 = node2.parentElement;
  }
  return null;
}

function updateStatus(el, text) {
  if (!el) return;
  el.textContent = text;
  if (el.classList) {
    if (/执行中/.test(text)) {
      el.classList.add("loading");
    } else {
      el.classList.remove("loading");
    }
  }
}

// ============ 自动发送结果 ============
async function sendToInput(text) {
  if (text === undefined || text === null) text = "";
  text = String(text);
  var ta = findInput();
  if (!ta) {
    console.warn("[DeepSeek Desktop] 找不到输入框");
    return false;
  }

  window.__adshieldSelfSend = true;

  try {
    // 填入 textarea（React 兼容）
    var setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(ta, text);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.focus();

    // 等 React 更新（发送按钮从 disabled → 可点击）
    await new Promise(function(r) { setTimeout(r, 500); });

    // 找发送按钮并点击
    var sendBtn = findSendButton();
    if (sendBtn) {
      sendBtn.click();
      console.log("[DeepSeek Desktop] 已自动发送");
    } else {
      // 备用：模拟 Enter
      ta.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter", code: "Enter", keyCode: 13, which: 13,
        bubbles: true, cancelable: true
      }));
    }
    return true;
  } catch (e) {
    console.error("[DeepSeek Desktop] 发送失败:", e);
    return false;
  } finally {
    setTimeout(function() { window.__adshieldSelfSend = false; }, 1000);
  }
}

// ============ DOM 工具 ============
function findInput() {
  var tas = document.querySelectorAll("textarea");
  for (var i = 0; i < tas.length; i++) {
    if (tas[i].offsetParent !== null) return tas[i];
  }
  return null;
}

function findSendButton() {
  // DeepSeek 发送按钮：ds-button--circle + primary/filled
  var sels = [
    ".ds-button--circle.ds-button--primary.ds-button--filled",
    ".ds-button--circle.ds-button--primary",
    ".ds-button--circle.ds-button--filled"
  ];
  for (var s = 0; s < sels.length; s++) {
    var btns = document.querySelectorAll(sels[s]);
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].offsetParent !== null) return btns[i];
    }
  }
  return null;
}

// ============ 结果格式化 ============
function formatResult(result) {
  let text = "【JS 执行结果汇总】(共 1 个脚本)\n\n";
  text += "—— 脚本 1 ——\n";
  
  if (result.ok) {
    text += "✅ 成功\n";
    // 如果代码中有 log() 输出，一并带上
    if (result.logs && result.logs.length > 0) {
      text += result.logs.join("\n") + "\n";
    }
    if (result.hasOutput === false) {
      // 无输出时保持简洁，不再附加冗余提示文字
    } else {
      let out = result.result;
      if (typeof out !== "string") {
        try { out = JSON.stringify(out, null, 2); } catch (e) { out = String(out); }
      }
      if (out && out.length > 8000) out = out.substring(0, 8000) + "\n...(已截断)";
      text += out;
    }
  } else {
    text += "❌ 失败\n";
    text += "错误原因: " + (result.error || "未知错误") + "\n";
  }
  return text;
}

// ============ 工具函数 ============
function decodeHtmlEntities(s) {
  if (!s) return "";
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ");
}

// 清理零宽字符 + 全角标点（避免语法错误）
function sanitizeCode(s) {
  if (!s) return "";
  return String(s)
    // 零宽字符
    .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, "")
    // 全角标点 → 半角
    .replace(/\u201C/g, '"').replace(/\u201D/g, '"')
    .replace(/\u2018/g, "'").replace(/\u2019/g, "'")
    .replace(/\uFF08/g, "(").replace(/\uFF09/g, ")")
    .replace(/\uFF1B/g, ";").replace(/\uFF0C/g, ",")
    .replace(/\uFF1A/g, ":").replace(/\uFF1D/g, "=")
    .replace(/\uFF0E/g, ".").replace(/\uFF01/g, "!")
    .replace(/\uFF1F/g, "?");
}

function hashStr(s) {
  if (s === undefined || s === null) s = "";
  s = String(s);
  var h = 0;
  for (var i = 0; i < s.length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return "cb-" + Math.abs(h);
}

// ============ GLM 面板 ============
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function renderMarkdown(text) {
  text = escapeHtml(text);
  var codeBlocks = [];
  text = text.replace(/```([\s\S]*?)```/g, function(m, code) {
    var idx = codeBlocks.length;
    codeBlocks.push("<pre><code>" + code + "</code></pre>");
    return "\u0000CODE" + idx + "\u0000";
  });
  text = text.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/\u0000CODE(\d+)\u0000/g, function(m, i) { return codeBlocks[Number(i)]; });
  return text;
}

var GLM_CSS = [

  "#adshield-ai-sidebar{position:fixed;top:0;right:-440px;width:420px;height:100vh;background:rgba(252,253,255,0.95);backdrop-filter:blur(24px) saturate(180%);-webkit-backdrop-filter:blur(24px) saturate(180%);box-shadow:-8px 0 32px rgba(15,23,42,0.08);border-left:1px solid rgba(226,232,240,0.6);z-index:999999;transition:right .4s cubic-bezier(.16,1,.3,1);display:flex;flex-direction:column;font-family:-apple-system,Segoe UI,Microsoft YaHei,sans-serif;color:#0f172a}",
  "#adshield-ai-sidebar .glm-header{padding:16px 20px;background:rgba(255,255,255,0.7);border-bottom:1px solid rgba(226,232,240,0.8);display:flex;justify-content:space-between;align-items:center}",
  "#adshield-ai-sidebar .glm-title{display:flex;align-items:center;gap:10px;font-weight:600;font-size:15px}",
  "#adshield-ai-sidebar .glm-title-icon{width:26px;height:26px;border-radius:8px;background:linear-gradient(135deg,#4f46e5,#7c3aed);display:flex;align-items:center;justify-content:center;color:#fff}",
  "#adshield-ai-sidebar .glm-header-actions{display:flex;gap:4px}",
  "#adshield-ai-sidebar .glm-btn-icon{background:transparent;border:none;cursor:pointer;color:#64748b;width:30px;height:30px;border-radius:8px;display:flex;align-items:center;justify-content:center;transition:all .15s;font-size:18px;padding:0}",
  "#adshield-ai-sidebar .glm-btn-icon:hover{background:rgba(15,23,42,0.06);color:#0f172a}",
  "#adshield-ai-sidebar .glm-chat-area{flex:1;padding:20px;overflow-y:auto;display:flex;flex-direction:column;gap:20px}",
  "#adshield-ai-sidebar .glm-chat-area::-webkit-scrollbar{width:6px}",
  "#adshield-ai-sidebar .glm-chat-area::-webkit-scrollbar-thumb{background:#cbd5e1;border-radius:10px}",
  "#adshield-ai-sidebar .glm-msg-user{align-self:flex-end;background:#0f172a;color:#f8fafc;padding:10px 16px;border-radius:16px 16px 4px 16px;font-size:14px;max-width:85%;line-height:1.6;word-break:break-word;box-shadow:0 4px 12px rgba(15,23,42,0.12)}",
  "#adshield-ai-sidebar .glm-msg-bot{align-self:flex-start;background:#f1f5f9;border:1px solid #e2e8f0;color:#334155;padding:12px 16px;border-radius:16px 16px 16px 4px;font-size:14px;max-width:92%;line-height:1.7;word-break:break-word;white-space:pre-wrap}",
  "#adshield-ai-sidebar .glm-msg-bot code{background:rgba(15,23,42,0.06);padding:2px 6px;border-radius:4px;font-family:SF Mono,Monaco,Consolas,monospace;font-size:.9em;color:#be185d}",
  "#adshield-ai-sidebar .glm-msg-bot pre{background:#1e293b;color:#f1f5f9;padding:14px;border-radius:10px;overflow-x:auto;margin:8px 0;font-family:SF Mono,Monaco,Consolas,monospace;font-size:13px;line-height:1.5}",
  "#adshield-ai-sidebar .glm-msg-bot pre code{background:transparent;color:inherit;padding:0}",
  "#adshield-ai-sidebar .glm-typing::after{content:'▋';animation:codex-blink 1s step-end infinite;color:#4f46e5;margin-left:2px}",
  "#adshield-ai-sidebar .glm-input-area{padding:16px 20px 20px}",
  "#adshield-ai-sidebar .glm-input-box{display:flex;align-items:flex-end;background:#fff;border:1.5px solid #e2e8f0;border-radius:14px;padding:10px 12px 10px 16px;box-shadow:0 4px 24px rgba(15,23,42,0.04);transition:all .2s}",
  "#adshield-ai-sidebar .glm-input-box:focus-within{border-color:#4f46e5;box-shadow:0 4px 24px rgba(79,70,229,0.12),0 0 0 3px rgba(79,70,229,0.08)}",
  "#adshield-ai-sidebar .glm-textarea{width:100%;border:none;resize:none;outline:none;background:transparent;padding:4px 0;margin:0;min-height:24px;height:24px;max-height:120px;font-size:14px;color:#0f172a;line-height:1.5;font-family:inherit}",
  "#adshield-ai-sidebar .glm-textarea::placeholder{color:#94a3b8}",
  "#adshield-ai-sidebar .glm-send-btn{width:32px;height:32px;border-radius:10px;background:#0f172a;color:#fff;display:flex;justify-content:center;align-items:center;flex-shrink:0;margin-left:10px;cursor:pointer;transition:all .15s;border:none;padding:0}",
  "#adshield-ai-sidebar .glm-send-btn:hover:not(:disabled){background:#4f46e5}",
  "#adshield-ai-sidebar .glm-send-btn:disabled{background:#e2e8f0;color:#94a3b8;cursor:not-allowed}",
  "#adshield-ai-sidebar .glm-empty-state{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:#64748b;text-align:center;padding:0 20px}",
  "#adshield-ai-sidebar .glm-empty-icon{width:64px;height:64px;border-radius:20px;background:linear-gradient(135deg,#4f46e5,#7c3aed);display:flex;align-items:center;justify-content:center;color:#fff;margin-bottom:20px;box-shadow:0 8px 24px rgba(79,70,229,0.25)}",
  "#adshield-ai-sidebar .glm-empty-title{font-size:16px;font-weight:600;color:#0f172a;margin-bottom:8px}",
  "#adshield-ai-sidebar .glm-empty-desc{font-size:13px;line-height:1.6;color:#64748b}",
  "@keyframes codex-blink{0%,100%{opacity:1}50%{opacity:0}}",
  "#adshield-glm-settings{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(15,23,42,0.4);backdrop-filter:blur(4px);z-index:9999999;display:none;align-items:center;justify-content:center}",
  "#adshield-glm-settings.active{display:flex}",
  "#adshield-glm-settings .settings-card{width:440px;max-width:90vw;max-height:85vh;background:#faf9f5;border-radius:16px;box-shadow:0 24px 64px rgba(15,23,42,0.25);display:flex;flex-direction:column;overflow:hidden}",
  "#adshield-glm-settings .settings-header{padding:18px 22px;border-bottom:1px solid #e8e6dc;display:flex;justify-content:space-between;align-items:center}",
  "#adshield-glm-settings .settings-title{font-size:16px;font-weight:600;color:#141413}",
  "#adshield-glm-settings .settings-close{width:28px;height:28px;border-radius:8px;border:none;background:transparent;cursor:pointer;color:#b0aea5;display:flex;align-items:center;justify-content:center;transition:all .15s;padding:0;font-size:20px;line-height:1}",
  "#adshield-glm-settings .settings-close:hover{background:#e8e6dc;color:#141413}",
  "#adshield-glm-settings .settings-body{padding:22px;overflow-y:auto;flex:1}",
  "#adshield-glm-settings .settings-field{margin-bottom:18px}",
  "#adshield-glm-settings .settings-field:last-child{margin-bottom:0}",
  "#adshield-glm-settings .settings-label{display:block;font-size:12px;font-weight:600;color:#141413;margin-bottom:6px}",
  "#adshield-glm-settings .settings-hint{font-size:11px;color:#b0aea5;margin-top:4px;line-height:1.5}",
  "#adshield-glm-settings .settings-warn{color:#b45309;background:#fef3c7;border:1px solid #fde68a;border-radius:6px;padding:6px 8px;margin-top:6px}",
  "#adshield-glm-settings .settings-input,#adshield-glm-settings .settings-select{width:100%;padding:9px 12px;border-radius:8px;border:1px solid #e8e6dc;background:#fff;font-size:13px;color:#141413;font-family:inherit;outline:none;box-sizing:border-box;transition:border-color .15s,box-shadow .15s}",
  "#adshield-glm-settings .settings-input:focus,#adshield-glm-settings .settings-select:focus{border-color:#d97757;box-shadow:0 0 0 3px rgba(217,119,87,0.12)}",
  "#adshield-glm-settings .settings-password-wrap{position:relative}",
  "#adshield-glm-settings .settings-password-wrap .settings-input{padding-right:60px}",
  "#adshield-glm-settings .settings-toggle-pwd{position:absolute;right:8px;top:50%;transform:translateY(-50%);background:transparent;border:none;cursor:pointer;font-size:11px;color:#d97757;padding:4px 8px;border-radius:4px}",
  "#adshield-glm-settings .settings-toggle-pwd:hover{background:rgba(217,119,87,0.1)}",
  "#adshield-glm-settings .settings-range-wrap{display:flex;align-items:center;gap:12px}",
  "#adshield-glm-settings .settings-range{flex:1;height:4px;border-radius:2px;background:#e8e6dc;outline:none;-webkit-appearance:none}",
  "#adshield-glm-settings .settings-range::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:#d97757;cursor:pointer;box-shadow:0 2px 6px rgba(217,119,87,0.3)}",
  "#adshield-glm-settings .settings-range-value{min-width:36px;text-align:center;font-size:12px;font-weight:600;color:#d97757;font-variant-numeric:tabular-nums}",
  "#adshield-glm-settings .settings-footer{padding:16px 22px;border-top:1px solid #e8e6dc;display:flex;justify-content:flex-end;gap:8px}",
  "#adshield-glm-settings .settings-btn{padding:8px 18px;border-radius:8px;border:none;font-size:13px;font-weight:500;cursor:pointer;transition:all .15s;font-family:inherit}",
  "#adshield-glm-settings .settings-btn-cancel{background:transparent;color:#b0aea5}",
  "#adshield-glm-settings .settings-btn-cancel:hover{background:#e8e6dc;color:#141413}",
  "#adshield-glm-settings .settings-btn-save{background:#d97757;color:#fff;box-shadow:0 2px 8px rgba(217,119,87,0.25)}",
  "#adshield-glm-settings .settings-btn-save:hover{background:#c96a47;transform:translateY(-1px)}",
  "#adshield-glm-settings .settings-btn-save:disabled{background:#e8e6dc;color:#b0aea5;cursor:not-allowed;transform:none;box-shadow:none}"
].join("\n");

var GLM_PANEL_HTML = [
  "<div class=\"glm-header\">",
  "  <div class=\"glm-title\">",
  "    <div class=\"glm-title-icon\"><svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\"><path d=\"M8 8L16 8L12 12L16 16L8 16L12 12Z\" fill=\"white\"/></svg></div>",
  "    <span>智谱 GLM 助手</span>",
  "  </div>",
  "  <div class=\"glm-header-actions\">",
  "    <button id=\"adshield-glm-config\" class=\"glm-btn-icon\" title=\"设置\">⚙️</button>",
  "    <button id=\"adshield-glm-close\" class=\"glm-btn-icon\" title=\"关闭\">×</button>",
  "  </div>",
  "</div>",
  "<div class=\"glm-chat-area\" id=\"glm-chat-area\">",
  "  <div class=\"glm-empty-state\">",
  "    <div class=\"glm-empty-icon\"><svg width=\"32\" height=\"32\" viewBox=\"0 0 24 24\" fill=\"none\"><path d=\"M8 8L16 8L12 12L16 16L8 16L12 12Z\" fill=\"white\"/></svg></div>",
  "    <div class=\"glm-empty-title\">有什么我可以帮忙的？</div>",
  "    <div class=\"glm-empty-desc\">点击右上角 ⚙️ 配置 API Key 即可开始对话。</div>",
  "  </div>",
  "</div>",
  "<div class=\"glm-input-area\">",
  "  <div class=\"glm-input-box\">",
  "    <textarea class=\"glm-textarea\" placeholder=\"向 GLM 提问... (Ctrl+Enter 发送)\" rows=\"1\"></textarea>",
  "    <button class=\"glm-send-btn\" disabled><svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.5\"><line x1=\"22\" y1=\"2\" x2=\"11\" y2=\"13\"/><polygon points=\"22 2 15 22 11 13 2 9 22 2\"/></svg></button>",
  "  </div>",
  "</div>",
].join("\n");

var GLM_SETTINGS_HTML = [
  "<div class=\"settings-card\">",
  "  <div class=\"settings-header\">",
  "    <div class=\"settings-title\">设置</div>",
  "    <button class=\"settings-close\" id=\"settings-close\">×</button>",
  "  </div>",
  "  <div class=\"settings-body\">",
  "    <div class=\"settings-field\">",
  "      <label class=\"settings-label\">API Key</label>",
  "      <div class=\"settings-password-wrap\">",
  "        <input class=\"settings-input\" id=\"settings-apikey\" type=\"password\" placeholder=\"粘贴智谱 API Key\" autocomplete=\"off\" spellcheck=\"false\">",
  "        <button class=\"settings-toggle-pwd\" id=\"settings-toggle-pwd\">显示</button>",
  "      </div>",
  "      <div class=\"settings-hint\">在 open.bigmodel.cn 免费获取</div>",
  "      <div class=\"settings-hint settings-warn\" id=\"settings-key-warn\" style=\"display:none\">当前系统不支持加密存储，API Key 将以明文保存在本机配置文件中</div>",
  "    </div>",
  "    <div class=\"settings-field\">",
  "      <label class=\"settings-label\">模型</label>",
  "      <select class=\"settings-select\" id=\"settings-model\">",
  "        <option value=\"glm-4-flash\">GLM-4-Flash（最快，免费）</option>",
  "        <option value=\"glm-4-air\">GLM-4-Air（推荐）</option>",
  "        <option value=\"glm-4-plus\">GLM-4-Plus（最强）</option>",
  "        <option value=\"glm-4\">GLM-4（标准）</option>",
  "        <option value=\"glm-4-long\">GLM-4-Long（长上下文）</option>",
  "      </select>",
  "    </div>",
  "    <div class=\"settings-field\">",
  "      <label class=\"settings-label\">温度</label>",
  "      <div class=\"settings-range-wrap\">",
  "        <input type=\"range\" class=\"settings-range\" id=\"settings-temp\" min=\"0\" max=\"1\" step=\"0.1\" value=\"0.7\">",
  "        <span class=\"settings-range-value\" id=\"settings-temp-value\">0.7</span>",
  "      </div>",
  "      <div class=\"settings-hint\">越低越确定，越高越有创意</div>",
  "    </div>",
  "    <div class=\"settings-field\">",
  "      <label class=\"settings-label\">最大 Token</label>",
  "      <input class=\"settings-input\" id=\"settings-maxtokens\" type=\"number\" min=\"256\" max=\"8192\" step=\"256\" value=\"1024\">",
  "      <div class=\"settings-hint\">单次回复的最大长度</div>",
  "    </div>",
  "    <div class=\"settings-field\">",
  "      <label class=\"settings-label\">系统提示词</label>",
  "      <textarea class=\"settings-input\" id=\"settings-system\" rows=\"3\" placeholder=\"定义 GLM 的角色或行为（可选）\"></textarea>",
  "      <div class=\"settings-hint\">留空则使用默认：辅助用户进行 AI 协作</div>",
  "    </div>",
  "  </div>",
  "  <div class=\"settings-footer\">",
  "    <button class=\"settings-btn settings-btn-cancel\" id=\"settings-cancel\">取消</button>",
  "    <button class=\"settings-btn settings-btn-save\" id=\"settings-save\">保存</button>",
  "  </div>",
  "</div>",
].join("\n");

function injectGLMUI() {
  if (document.getElementById("adshield-ai-sidebar")) return;
  var ipcRenderer = require("electron").ipcRenderer;
  if (!document.getElementById("glm-panel-styles")) {
    var style = document.createElement("style");
    style.id = "glm-panel-styles";
    style.textContent = GLM_CSS;
    document.head.appendChild(style);
  }
  var container = document.createElement("div");
  container.id = "adshield-ai-sidebar";
  container.innerHTML = GLM_PANEL_HTML;
  document.body.appendChild(container);
  var settingsPanel = document.createElement("div");
  settingsPanel.id = "adshield-glm-settings";
  settingsPanel.innerHTML = GLM_SETTINGS_HTML;
  document.body.appendChild(settingsPanel);

  var openBtn = document.getElementById("adshield-glm-container");
  if (!openBtn) {
    var FLOAT_SIZE = 56;
    openBtn = document.createElement("div");
    openBtn.id = "adshield-glm-container";

    // 初始位置（localStorage 恢复，边界裁剪到窗口内）
    var initPos = (function() {
      try {
        var raw = localStorage.getItem("glm_float_pos");
        if (raw) {
          var p = JSON.parse(raw);
          if (typeof p.left === "number" && typeof p.top === "number") {
            var maxL = Math.max(0, window.innerWidth - FLOAT_SIZE);
            var maxT = Math.max(0, window.innerHeight - FLOAT_SIZE);
            return { left: Math.max(0, Math.min(p.left, maxL)), top: Math.max(0, Math.min(p.top, maxT)) };
          }
        }
      } catch (e) {}
      return {
        left: Math.max(0, window.innerWidth - 24 - FLOAT_SIZE),
        top: Math.max(0, window.innerHeight - 80 - FLOAT_SIZE)
      };
    })();

    openBtn.style.cssText =
      "position:fixed;" +
      "left:" + initPos.left + "px;" +
      "top:" + initPos.top + "px;" +
      "width:" + FLOAT_SIZE + "px;" +
      "height:" + FLOAT_SIZE + "px;" +
      "border-radius:50%;" +
      "background:linear-gradient(135deg,#8B5CF6,#6D28D9);" +
      "display:flex;align-items:center;justify-content:center;color:#fff;" +
      "cursor:grab;" +
      "box-shadow:0 8px 24px rgba(109,40,217,0.35);" +
      "z-index:99999;" +
      "transition:transform .2s,box-shadow .2s,opacity .2s;" +
      "user-select:none;touch-action:none;";

    // ZAI 沙漏图标
    openBtn.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 6 L15 6 L12 12 L15 18 L9 18 L12 12 Z" fill="white"/></svg>';

    // 拖动逻辑
    var dragState = { active: false, moved: false, sx: 0, sy: 0, sl: 0, st: 0, maxL: 0, maxT: 0 };

    openBtn.addEventListener("mousedown", function(e) {
      if (e.button !== 0) return;
      var rect = openBtn.getBoundingClientRect();
      dragState.active = true;
      dragState.moved = false;
      dragState.sx = e.clientX;
      dragState.sy = e.clientY;
      dragState.sl = rect.left;
      dragState.st = rect.top;
      // 可拖拽边界一次算好：拖动过程中窗口尺寸不变，不必每个 mousemove 再读
      dragState.maxL = Math.max(0, window.innerWidth - FLOAT_SIZE);
      dragState.maxT = Math.max(0, window.innerHeight - FLOAT_SIZE);
      openBtn.style.cursor = "grabbing";
      openBtn.style.transition = "none";
      e.preventDefault();
    });

    // mousemove 一帧能来几十次，每次都写 left/top 会连续触发布局。
    // 只保留最新坐标，合到一帧里写一次。
    var dragRaf = null;
    var lastMoveEvent = null;
    document.addEventListener("mousemove", function(e) {
      if (!dragState.active) return;
      lastMoveEvent = e;
      if (dragRaf) return;
      dragRaf = requestAnimationFrame(function() {
        dragRaf = null;
        if (!dragState.active || !lastMoveEvent) return;
        var dx = lastMoveEvent.clientX - dragState.sx;
        var dy = lastMoveEvent.clientY - dragState.sy;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragState.moved = true;
        var nl = Math.max(0, Math.min(dragState.sl + dx, dragState.maxL));
        var nt = Math.max(0, Math.min(dragState.st + dy, dragState.maxT));
        openBtn.style.left = nl + "px";
        openBtn.style.top = nt + "px";
      });
    });

    document.addEventListener("mouseup", function() {
      if (!dragState.active) return;
      dragState.active = false;
      openBtn.style.cursor = "grab";
      openBtn.style.transition = "transform .2s,box-shadow .2s,opacity .2s";
      if (dragState.moved) {
        try {
          var rect = openBtn.getBoundingClientRect();
          localStorage.setItem("glm_float_pos", JSON.stringify({ left: rect.left, top: rect.top }));
        } catch (e) {}
      }
    });

    openBtn.addEventListener("mouseenter", function() {
      if (dragState.active) return;
      openBtn.style.transform = "scale(1.06)";
    });
    openBtn.addEventListener("mouseleave", function() {
      if (dragState.active) return;
      openBtn.style.transform = "scale(1)";
    });

    openBtn.addEventListener("click", function(e) {
      if (dragState.moved) {
        dragState.moved = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      container.style.right = "0";
      openBtn.style.opacity = "0";
      openBtn.style.pointerEvents = "none";
    });

    document.body.appendChild(openBtn);
  }

  container.querySelector("#adshield-glm-close").onclick = function() {
    container.style.right = "-440px";
    openBtn.style.opacity = "1";
    openBtn.style.pointerEvents = "auto";
  };

  var apikeyInput = document.getElementById("settings-apikey");
  var saveBtn = document.getElementById("settings-save");
  var tempSlider = document.getElementById("settings-temp");
  var tempValue = document.getElementById("settings-temp-value");
  var togglePwdBtn = document.getElementById("settings-toggle-pwd");
  var settingsPanelEl = document.getElementById("adshield-glm-settings");

  container.querySelector("#adshield-glm-config").onclick = async function() {
    var cfg = {};
    try { cfg = await ipcRenderer.invoke("glm-get-config"); } catch (e) {}
    if (cfg.hasApiKey) {
      apikeyInput.value = "••••••••••••••••";
      apikeyInput.dataset.masked = "1";
    } else {
      apikeyInput.value = "";
      delete apikeyInput.dataset.masked;
    }
    apikeyInput.type = "password";
    togglePwdBtn.textContent = "显示";
    document.getElementById("settings-model").value = cfg.model || "glm-4-air";
    var temp = (typeof cfg.temperature === "number") ? cfg.temperature : 0.7;
    tempSlider.value = temp;
    tempValue.textContent = temp;
    document.getElementById("settings-maxtokens").value = cfg.maxTokens || 1024;
    document.getElementById("settings-system").value = cfg.systemPrompt || "";
    var keyWarn = document.getElementById("settings-key-warn");
    if (keyWarn) keyWarn.style.display = (cfg.encrypted === false) ? "block" : "none";
    settingsPanel.classList.add("active");
  };

  apikeyInput.addEventListener("input", function() {
    if (apikeyInput.dataset.masked) {
      apikeyInput.value = "";
      delete apikeyInput.dataset.masked;
    }
  });

  document.getElementById("settings-close").onclick = function() { settingsPanel.classList.remove("active"); };
  document.getElementById("settings-cancel").onclick = function() { settingsPanel.classList.remove("active"); };
  // 点击背景不关闭设置面板，需点击关闭或取消按钮

  togglePwdBtn.onclick = function() {
    if (apikeyInput.type === "password") { apikeyInput.type = "text"; togglePwdBtn.textContent = "隐藏"; }
    else { apikeyInput.type = "password"; togglePwdBtn.textContent = "显示"; }
  };

  tempSlider.oninput = function() { tempValue.textContent = tempSlider.value; };

  saveBtn.onclick = async function() {
    var wasMasked = !!apikeyInput.dataset.masked;
    var apiKeyVal = apikeyInput.value.trim();
    // 掩码未被动过 = 保持原 Key；被清空 = 用户要删掉已存的 Key
    var keepOld = wasMasked;
    var clearKey = !wasMasked && !apiKeyVal;
    if (clearKey && !confirm("确定要删除已保存的 API Key 吗？")) return;
    var tRaw = parseFloat(tempSlider.value);
    var mtRaw = parseInt(document.getElementById("settings-maxtokens").value, 10);
    var cfg = {
      apiKey: keepOld ? "" : apiKeyVal,
      clearApiKey: clearKey,
      model: document.getElementById("settings-model").value,
      temperature: Number.isFinite(tRaw) ? tRaw : 0.7,
      maxTokens: (Number.isFinite(mtRaw) && mtRaw > 0) ? mtRaw : 1024,
      systemPrompt: document.getElementById("settings-system").value.trim()
    };
    saveBtn.disabled = true; saveBtn.textContent = "保存中...";
    try {
      var res = await ipcRenderer.invoke("glm-set-config", cfg);
      if (res && res.ok === false) { alert("保存失败: " + (res.error || "未知错误")); return; }
      if (res && res.encrypted === false) {
        alert("已保存。当前系统不支持加密存储，API Key 以明文保存在本机配置文件中。");
      }
      settingsPanel.classList.remove("active");
    } catch (e) { alert("保存失败: " + e.message); }
    finally { saveBtn.disabled = false; saveBtn.textContent = "保存"; }
  };

  var textarea = container.querySelector(".glm-textarea");
  var sendBtn = container.querySelector(".glm-send-btn");
  var chatArea = container.querySelector("#glm-chat-area");
  var chatHistory = [];
  var currentBotMsg = null;
  var currentReqId = null;
  var sending = false;
  var MAX_HISTORY_MSGS = 40;
  // 流式文本用闭包变量累积。原来挂在 dataset.rawText 上，每个 chunk 都要
  // 序列化整个已累积字符串再写回 DOM 属性，长回复是 O(n²)。
  var glmRawText = "";
  var glmFirstChunk = true;
  var glmScrollRaf = null;

  textarea.addEventListener("input", function() {
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 120) + "px";
    sendBtn.disabled = !textarea.value.trim() || textarea.disabled;
  });

  function appendToHistory(role, content) {
    chatHistory.push({ role: role, content: content });
    while (chatHistory.length > MAX_HISTORY_MSGS) chatHistory.shift();
  }

  ipcRenderer.on("glm-stream-chunk", function(event, payload) {
    if (!currentBotMsg || !payload || payload.reqId !== currentReqId) return;
    var delta = payload.delta || "";
    if (glmFirstChunk) {
      currentBotMsg.textContent = "";
      currentBotMsg.classList.add("glm-typing");
      glmFirstChunk = false;
    }
    glmRawText += delta;
    // 只追加增量文本节点，不重建整段内容；markdown 仍只在 stream-end 渲染一次
    currentBotMsg.appendChild(document.createTextNode(delta));
    // 自动跟随滚动要读 scrollHeight/clientHeight，合到一帧一次，
    // 不必每个 chunk 都强制一次布局计算
    if (glmScrollRaf) return;
    glmScrollRaf = requestAnimationFrame(function() {
      glmScrollRaf = null;
      var distance = chatArea.scrollHeight - chatArea.scrollTop - chatArea.clientHeight;
      if (distance < 80) chatArea.scrollTop = chatArea.scrollHeight;
    });
  });
  ipcRenderer.on("glm-stream-retry", function(event, payload) {
    if (!currentBotMsg || !payload || payload.reqId !== currentReqId) return;
    currentBotMsg.textContent = "服务繁忙，正在重试 (" + payload.attempt + "/" + payload.max + ")...";
  });
  ipcRenderer.on("glm-stream-end", function(event, payload) {
    if (!payload || payload.reqId !== currentReqId) return;
    if (currentBotMsg) {
      currentBotMsg.classList.remove("glm-typing");
      var rawText = glmRawText;
      currentBotMsg.innerHTML = renderMarkdown(rawText);
      appendToHistory("assistant", rawText);
      currentBotMsg = null;
    }
    currentReqId = null;
    sending = false;
    sendBtn.disabled = !textarea.value.trim();
    textarea.disabled = false;
    textarea.focus();
  });
  ipcRenderer.on("glm-stream-error", function(event, payload) {
    if (!payload || payload.reqId !== currentReqId) return;
    if (currentBotMsg) {
      currentBotMsg.classList.remove("glm-typing");
      var partial = glmRawText;
      currentBotMsg.innerHTML = (partial ? renderMarkdown(partial) + "<br>" : "") +
        '<span style="color:#ef4444;">❌ 错误: ' + escapeHtml(payload.error) + '</span>';
      currentBotMsg = null;
    }
    currentReqId = null;
    sending = false;
    sendBtn.disabled = !textarea.value.trim();
    textarea.disabled = false;
  });

  async function sendMessage() {
    if (sending) return;
    var text = textarea.value.trim();
    if (!text) return;

    var glmConfig = { hasApiKey: false, model: "glm-4-air" };
    try { glmConfig = await ipcRenderer.invoke("glm-get-config"); } catch (e) {}
    if (!glmConfig.hasApiKey) { alert("请先点击右上角 ⚙️ 配置 API Key！"); return; }

    sending = true;
    var empty = chatArea.querySelector(".glm-empty-state");
    if (empty) empty.remove();

    var userMsg = document.createElement("div");
    userMsg.className = "glm-msg-user";
    userMsg.textContent = text;
    chatArea.appendChild(userMsg);

    textarea.value = "";
    textarea.style.height = "24px";
    textarea.disabled = true;
    sendBtn.disabled = true;

    currentBotMsg = document.createElement("div");
    currentBotMsg.className = "glm-msg-bot glm-typing";
    glmFirstChunk = true;
    glmRawText = "";
    currentBotMsg.textContent = "正在思考";
    chatArea.appendChild(currentBotMsg);
    chatArea.scrollTop = chatArea.scrollHeight;

    appendToHistory("user", text);
    currentReqId = "r" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);

    try {
      var res = await ipcRenderer.invoke("call-glm", {
        messages: chatHistory,
        model: glmConfig.model || "glm-4-air",
        temperature: (typeof glmConfig.temperature === "number") ? glmConfig.temperature : 0.7,
        maxTokens: glmConfig.maxTokens || 1024,
        systemPrompt: glmConfig.systemPrompt || "",
        reqId: currentReqId
      });
      if (!res || !res.ok) {
        if (currentBotMsg) {
          currentBotMsg.classList.remove("glm-typing");
          currentBotMsg.innerHTML = '<span style="color:#ef4444;">❌ 错误: ' + escapeHtml((res && res.error) || "未知错误") + '</span>';
          currentBotMsg = null;
        }
        currentReqId = null;
        sending = false;
        sendBtn.disabled = !textarea.value.trim();
        textarea.disabled = false;
      }
    } catch (e) {
      if (currentBotMsg) {
        currentBotMsg.classList.remove("glm-typing");
        currentBotMsg.innerHTML = '<span style="color:#ef4444;">❌ 异常: ' + escapeHtml(e.message) + '</span>';
        currentBotMsg = null;
      }
      currentReqId = null;
      sending = false;
      sendBtn.disabled = !textarea.value.trim();
      textarea.disabled = false;
    }
  }

  sendBtn.onclick = sendMessage;
  textarea.onkeydown = function(e) {
    if (e.ctrlKey && e.key === "Enter") { e.preventDefault(); sendMessage(); }
  };
}