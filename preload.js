
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("deepseekDesktop", {
  version: "1.2.0",
  platform: process.platform,
  executeCode: function(code, blockId) { return ipcRenderer.invoke("execute-cuckoo", { code: code, blockId: blockId }); },
  checkCode: function(code) { return ipcRenderer.invoke("check-cuckoo", { code: code }); },
  selectWorkspace: function() { return ipcRenderer.invoke("select-workspace"); },
  getWorkspace: function() { return ipcRenderer.invoke("get-workspace"); }
});

// ============ 状态 ============
var autoChain = 0;              // 当前自动执行链的计数
var MAX_CHAIN = 3;              // 单链最多自动执行 3 次
var pendingBlocks = {};         // { id: { code, timer } }
var processedBlocks = {};       // 已执行的代码块
var processedCount = 0;         // 计数，用于清理
var __stylesInjected = false;

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
  console.log("[DeepSeek Desktop] preload 注入成功 (自动模式)");
  ensureStyles();

  // ★ 网络 hook 触发已禁用（DeepSeek 分片 XHR 无法可靠累积）
  //   保留 probe.js 继续打印日志（研究用），但不用它触发执行
  // initNetworkListener();
  var observer = new MutationObserver(function(mutations) {
    var hasNew = false;
    for (var i = 0; i < mutations.length; i++) {
      var m = mutations[i];
      for (var j = 0; j < m.addedNodes.length; j++) {
        var node = m.addedNodes[j];
        if (node.nodeType === 1) {
          hasNew = true;
          break;
        }
      }
      if (hasNew) break;
    }
    if (hasNew) {
      window.__adshield_dom_changed = true;
      setTimeout(function() { scan(document.body); }, 800);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  setTimeout(function() { scan(document.body); }, 2000);

  // ★ 定时轮询兜底（每 2 秒），防止流式渲染漏掉代码块
  var lastScanTime = Date.now();
  setInterval(function() {
    if (document.hidden) return; // 页面不可见时不扫，省性能
    // 仅当最近有 DOM 变化（通过 MutationObserver 更新标记）或超过 5 秒没扫时，才执行全量扫描
    if (window.__adshield_dom_changed || Date.now() - lastScanTime > 5000) {
      scan(document.body);
      lastScanTime = Date.now();
      window.__adshield_dom_changed = false;
    }
  }, 2000);
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
  if (processedBlocks[id]) {
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

// ============ 扫描 cuckoo 代码块（v3：父级检测）【fallback】============
function scan(root) {
  if (!root || !root.querySelectorAll) return;
  var pres = root.querySelectorAll("pre");
  for (var i = 0; i < pres.length; i++) {
    var pre = pres[i];
    // ★ 用 DOM 属性标记，避免重复处理
    if (pre.getAttribute("data-adshield-processed") === "1") continue;
    // 检查父元素（往上 4 层）是否含 "cuckoo"
    var hasCuckoo = false;
    var node = pre;
    for (var up = 0; up < 4; up++) {
      if (!node.parentElement) break;
      node = node.parentElement;
      var t = (node.innerText || node.textContent || "");
      if (t.toLowerCase().indexOf("cuckoo") !== -1) { hasCuckoo = true; break; }
    }
    if (!hasCuckoo) continue;

    // 提取代码（优先 code 子元素，否则用 pre 本身）
    var codeEl = pre.querySelector("code") || pre;
    var codeText = (codeEl.innerText || codeEl.textContent || "").trim();
    // 解码 HTML 实体（避免 &quot; 等污染代码）
    codeText = decodeHtmlEntities(codeText);
    // 清理零宽字符 + 全角标点
    codeText = sanitizeCode(codeText);
    // 日志：方便定位
    console.log("[DeepSeek Desktop] 提取代码:", JSON.stringify(codeText.substring(0, 200)));
    // 打印非 ASCII 字符的 charCode（定位隐藏字符）
    var badChars = [];
    for (var ci = 0; ci < codeText.length; ci++) {
      var cc = codeText.charCodeAt(ci);
      if (cc > 127 && cc !== 0xFEFF) {
        badChars.push(ci + ":U+" + cc.toString(16).toUpperCase().padStart(4, "0"));
        if (badChars.length > 20) break;
      }
    }
    if (badChars.length > 0) {
      console.log("[DeepSeek Desktop] 非 ASCII 字符:", badChars.join(", "));
    }

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
    var skip = false;
    for (var sm = 0; sm < skipMarkers.length; sm++) {
      if (containerText.indexOf(skipMarkers[sm]) !== -1) { skip = true; break; }
    }
    if (skip) { console.log("[DeepSeek Desktop] 跳过系统提示块"); continue; }

    // ★ 严格过滤：代码必须真的"像代码"
    var looksLikeCode = false;
    var tools0 = ["bash(", "pwsh(", "python(", "read(", "write(", "edit(", "glob(", "grep("];
    for (var tt = 0; tt < tools0.length; tt++) {
      if (codeText.indexOf(tools0[tt]) !== -1) { looksLikeCode = true; break; }
    }
    if (!looksLikeCode) {
      console.log("[DeepSeek Desktop] 跳过（无工具调用）:", JSON.stringify(codeText.substring(0, 80)));
      continue;
    }
    if (codeText.length < 10) {
      console.log("[DeepSeek Desktop] 跳过（太短）:", JSON.stringify(codeText));
      continue;
    }
    var hasCodeFeature = /[;{}(=]/.test(codeText) || codeText.indexOf("\\n") !== -1;
    if (!hasCodeFeature) {
      console.log("[DeepSeek Desktop] 跳过（无代码特征）:", JSON.stringify(codeText.substring(0, 80)));
      continue;
    }

    // 去掉可能的包裹符号
    var prefix = "```cuckoo";
    if (codeText.indexOf(prefix) === 0) codeText = codeText.substring(prefix.length).trim();
    var suffix = "```";
    if (codeText.lastIndexOf(suffix) === codeText.length - 3) codeText = codeText.substring(0, codeText.length - 3).trim();

    // 去掉按钮文字
    var junk = ["复制", "下载", "Copy", "Download", "cuckoo"];
    for (var j = 0; j < junk.length; j++) {
      var w = junk[j];
      if (codeText.indexOf(w) === 0) codeText = codeText.substring(w.length).trim();
    }
    if (!codeText) continue;

    // 检查是否含工具调用
    var hasTool = false;
    var tools = ["bash(", "pwsh(", "python(", "read(", "write(", "edit(", "glob(", "grep("];
    for (var t = 0; t < tools.length; t++) {
      if (codeText.indexOf(tools[t]) !== -1) { hasTool = true; break; }
    }
    if (!hasTool) continue;

    // ★ 消息级去重：只检查（不设置，等执行时设置）
    var msgEl = pre.closest && pre.closest(".ds-message");
    if (msgEl && msgEl.getAttribute("data-adshield-done") === "1") {
      console.log("[DeepSeek Desktop] 同一消息已有代码块在执行，跳过");
      continue;
    }

    // ★ 用 pre 元素 ID（内容变了也用同一个 id，debounce 会重置 timer）
    if (!pre.getAttribute("data-adshield-id")) {
      window.__adshield_seq = (window.__adshield_seq || 0) + 1;
      pre.setAttribute("data-adshield-id", "pre-" + window.__adshield_seq);
    }
    var id = pre.getAttribute("data-adshield-id");
    if (processedBlocks[id]) continue;
    scheduleExecute(pre, codeText, id);
    processedCount++;
    if (processedCount > 100) {
      // 防止内存泄漏：当数量超过 100 时，清理一半的旧记录
      processedBlocks = {};
      processedCount = 0;
      console.log("[DeepSeek Desktop] 清理历史执行记录缓存");
    }
  }
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
async function autoExecute(block, code, id, force) {
  if (!force && processedBlocks[id]) return;
  processedBlocks[id] = true;

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

  // 超过链上限 → 显示按钮让用户手动点
  if (autoChain >= MAX_CHAIN) {
    injectButton(block, code, id, "已达自动执行上限（" + MAX_CHAIN + "），请手动点击");
    return;
  }
  autoChain++;

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
    if (confirmResult.ok) {
      injectButton(block, code, id, "✅ 执行完成，已通知 AI");
    } else {
      injectButton(block, code, id, "❌ 执行失败，已发送错误报告");
    }
    await sendToInput(formatResult(confirmResult));
    return;
  }

  // 安全命令 → 直接执行
  var statusEl = block ? injectButton(block, code, id, "自动执行中...") : null;

  try {
    var result = await ipcRenderer.invoke("execute-cuckoo", { code: code, blockId: id });
    if (result.ok) {
      updateStatus(statusEl, "✅ 已执行，已通知 AI");
    } else {
      updateStatus(statusEl, "❌ 执行失败，已发送错误报告");
    }
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

  // wrapper 可能被注入到原生操作栏（不在 grandparent 内），改为全局查找
  var existing = null;
  var foundBars = document.querySelectorAll("[data-cuckoo-id]");
  for (var fi = 0; fi < foundBars.length; fi++) {
    if (foundBars[fi].getAttribute("data-cuckoo-id") === id) { existing = foundBars[fi]; break; }
  }
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

  var candidates = [];
  var stack = [{ node: body, depth: 0 }];
  while (stack.length) {
    var item = stack.pop();
    var node = item.node, depth = item.depth;
    // 排除消息内容子树（含代码块按钮区）和任何含 pre 的节点
    if (!msgEl.contains(node) && !node.querySelector("pre")) {
      if (node.querySelector('[role="button"]') && getComputedStyle(node).display === "flex") {
        var h = node.getBoundingClientRect().height;
        if (h > 0 && h < 80) candidates.push({ node: node, depth: depth });
      }
    }
    for (var i = 0; i < node.children.length; i++) {
      stack.push({ node: node.children[i], depth: depth + 1 });
    }
  }

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




// ============ 工作区 UI ============
function injectWorkspaceUI() {
  const btnId = 'adshield-workspace-btn';
  setInterval(async () => {
    // 通过文本内容或者类名查找“开启新对话”按钮
    const btn = Array.from(document.querySelectorAll('button, .ds-button, div')).find(el => {
      return el.textContent.trim() === '开启新对话' || el.innerHTML.includes('开启新对话');
    });

    if (!btn || !btn.parentElement) return;
    
    // 如果已经有按钮了，检查是不是紧跟在后面，不是的话重新挂载
    let existing = document.getElementById(btnId);
    if (existing) {
      if (existing.previousSibling !== btn) {
        btn.parentElement.insertBefore(existing, btn.nextSibling);
      }
      return;
    }

    // 创建新按钮
    const container = document.createElement('div');
    container.id = btnId;
    container.style.cssText = "display:flex; align-items:center; margin: 8px 12px; padding: 8px 12px; background: rgba(79, 70, 229, 0.08); border: 1px dashed rgba(79, 70, 229, 0.4); border-radius: 8px; cursor: pointer; transition: all 0.2s; user-select: none;";

    const icon = document.createElement('span');
    icon.innerHTML = '📁';
    icon.style.cssText = "margin-right: 8px; font-size: 14px;";

    const text = document.createElement('span');
    text.id = 'adshield-workspace-text';
    text.style.cssText = "color: #4f46e5; font-size: 13px; font-weight: 500; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
    text.textContent = "选择工作区";

    container.appendChild(icon);
    container.appendChild(text);

    container.onclick = async () => {
      text.textContent = "请选择...";
      try {
        const res = await window.deepseekDesktop.selectWorkspace();
        if (res && res.path) {
          updateWorkspaceText(res.path);
        } else {
          const old = await window.deepseekDesktop.getWorkspace();
          updateWorkspaceText(old);
        }
      } catch (e) {
        text.textContent = "选择失败";
      }
    };

    btn.parentElement.insertBefore(container, btn.nextSibling);
    window.deepseekDesktop.getWorkspace().then(updateWorkspaceText);
  }, 1000);
}

function updateWorkspaceText(path) {
  const textEl = document.getElementById('adshield-workspace-text');
  if (!textEl) return;
  const container = document.getElementById('adshield-workspace-btn');
  if (path) {
    const folderName = path.split(/[\\/]/).filter(Boolean).pop() || path;
    textEl.textContent = folderName;
    textEl.title = path;
    if (container) container.style.border = "1px solid rgba(79, 70, 229, 0.6)";
  } else {
    textEl.textContent = "选择工作区";
    textEl.title = "点击选择项目文件夹";
    if (container) container.style.border = "1px dashed rgba(79, 70, 229, 0.4)";
  }
}
