// preload.js 的域名门控测试
//
// 地址栏可以导航到任意站点，而 preload 绑在 webContents 上、换站点后照样加载。
// 门控失效的后果不是「界面少了个按钮」，而是任何页面只要在 DOM 里放一个
// <pre>dir</pre> 就能触发本地执行并把结果回传。所以这条边界必须有自动化断言。
//
// preload 是 CommonJS，Electron 实际执行时外面套了函数包装（顶层 return 合法），
// 这里用同样的包装方式跑它，否则 vm.runInContext 会因顶层 return 报语法错误。

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = fs.readFileSync(path.join(__dirname, "..", "preload.js"), "utf-8");

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log("  ✓ " + msg); }
  else { failed++; console.log("  ✗ " + msg); }
}

// 用给定的 protocol + hostname 跑 preload，记录所有对外副作用
function runWith(proto, hostname) {
  const exposed = [];        // [{ name, keys }]
  let ipcOnCalls = 0;
  let observers = 0;

  const fakeIpcRenderer = {
    on: () => { ipcOnCalls++; },
    invoke: () => Promise.resolve({}),
    send: () => {}
  };
  const fakeRequire = (id) => {
    if (id === "electron") {
      return {
        contextBridge: {
          exposeInMainWorld: (name, api) => {
            exposed.push({ name, keys: Object.keys(api || {}) });
          }
        },
        ipcRenderer: fakeIpcRenderer
      };
    }
    if (id === "./package.json") return { version: "9.9.9" };
    return {};
  };

  const stubEl = () => ({
    style: {}, dataset: {}, classList: { add() {}, remove() {}, contains: () => false },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    appendChild() {}, addEventListener() {}, remove() {}, querySelector: () => null,
    querySelectorAll: () => [], closest: () => null, contains: () => false
  });
  const sandbox = {
    require: fakeRequire,
    console: { log() {}, warn() {}, error() {} },
    location: { protocol: proto, hostname, origin: proto + "//" + hostname, href: proto + "//" + hostname + "/" },
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: {
      addEventListener() {}, removeEventListener() {}, readyState: "complete",
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
      createElement: stubEl, createTextNode: () => ({}), body: null,
      documentElement: { dataset: {}, style: {} }
    },
    MutationObserver: function () {
      observers++;
      this.observe = () => {}; this.disconnect = () => {};
    },
    WeakSet, Set, Map, JSON, Math, Date, Buffer, Promise, String, Number, Object, Array, RegExp, Error,
    process: { platform: "win32", versions: {}, env: {} }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const wrapped = "(function (exports, require, module, __filename, __dirname) {\n" + SRC + "\n})";
  let fn = null, error = null;
  try {
    fn = vm.runInNewContext(wrapped, sandbox, { filename: "preload.js" });
  } catch (e) {
    return { exposed, ipcOnCalls, observers, error: "包装失败: " + e.message };
  }
  try {
    fn.call(sandbox, {}, fakeRequire, { exports: {} }, "preload.js", ".");
  } catch (e) {
    error = e.message;   // 门控放行后 DOM 桩不完整会抛错，属预期
  }
  return { exposed, ipcOnCalls, observers, error };
}

const BAD_HOSTS = [
  // 常规第三方
  "www.bing.com", "bing.com", "evil.example.net", "localhost", "127.0.0.1",
  // 后缀伪造：抓 endsWith("deepseek.com") 这种丢掉点号的退化
  "deepseek.com.evil.net", "chat.deepseek.com.evil.io",
  "evildeepseek.com", "fakedeepseek.com", "not-deepseek.com", "deepseek.comx.io"
];

console.log("\n== 非 DeepSeek 域名：必须零副作用 ==");
for (const host of BAD_HOSTS) {
  const r = runWith("https:", host);
  // 不只是"没暴露桥"，还要没注册监听、没建 observer、没在门控之后抛错
  ok(r.exposed.length === 0 && r.ipcOnCalls === 0 && r.observers === 0 && r.error === null,
     `零注入: ${host}` + (r.error ? `（意外抛错: ${r.error.slice(0, 50)}）` : ""));
}

console.log("\n== 明文 http 的 DeepSeek 站点：也必须关闭 ==");
// 主进程放开地址栏后 http://chat.deepseek.com 也能加载；明文连接上的中间人
// 可以直接往页面塞代码块来触发本地执行，所以协议必须是 https
for (const host of ["chat.deepseek.com", "deepseek.com"]) {
  const r = runWith("http:", host);
  ok(r.exposed.length === 0 && r.ipcOnCalls === 0 && r.observers === 0 && r.error === null,
     `零注入（http 明文）: ${host}`);
}

console.log("\n== https 的 DeepSeek 官方域名：正常放行 ==");
for (const host of ["deepseek.com", "chat.deepseek.com", "www.deepseek.com"]) {
  const r = runWith("https:", host);
  ok(r.exposed.length === 1 && r.exposed[0].name === "deepseekDesktop", `已暴露桥接对象: ${host}`);
}

console.log("\n== 暴露内容不得扩权 ==");
// 桥面上只允许 version / platform。加任何新键都等于把能力交给远程页面，
// 必须显式改这条断言并说明理由，不能顺手塞。
{
  const r = runWith("https:", "chat.deepseek.com");
  const keys = (r.exposed[0] && r.exposed[0].keys || []).slice().sort();
  ok(JSON.stringify(keys) === JSON.stringify(["platform", "version"]),
     "桥面键集合仍只有 platform/version，实际: " + JSON.stringify(keys));
}

console.log("\n== 空 / 异常来源：按不可信处理 ==");
for (const h of ["", "undefined"]) {
  const r = runWith("https:", h);
  ok(r.exposed.length === 0 && r.ipcOnCalls === 0, `不注入: hostname="${h}"`);
}

console.log("\n== 自动执行不再有人为次数上限 ==");
// 用户明确要求取消「单链最多自动执行 3 次」。白名单分级与危险确认仍是硬边界，
// 这里只守住配额机制没有被无意恢复。
const srcCode = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
ok(!/MAX_CHAIN/.test(srcCode), "没有 MAX_CHAIN 常量");
ok(!/自动执行上限/.test(srcCode), "不再注入「已达自动执行上限」提示");
ok(!/autoChain/.test(srcCode), "没有自动执行链计数残留");

console.log("\n== 历史会话不得重放旧代码块 ==");
// 打开应用即可落在某个历史会话上；切会话时也会整段重渲染。旧实现把这些
// 历史代码块当新块，会重新自动执行（实测直接弹「AI 请求执行危险操作」）。
// 只靠时间窗不够：消息列表虚拟化，历史块滚到才挂载，可能几秒后才出现。
// ↓ 这四条原本是永真的：正则能匹配到「声明」而不是「行为」，把真正做事的那行
//   删掉测试照样全绿（2026-10-25 审查点名）。现在都改成按出现次数与数值判定。
const guardMs = (srcCode.match(/HISTORY_GUARD_MS\s*=\s*(\d+)/) || [])[1];
ok(guardMs && Number(guardMs) >= 3000, "历史静默窗存在且不短于 3 秒（改成 0/1 就等于关掉机制）");
ok((srcCode.match(/historyGuardUntil\s*=\s*Date\.now\(\)\s*\+\s*HISTORY_GUARD_MS/g) || []).length === 2,
  "开屏与切会话两处都开启静默窗（少一处就漏一条重放路径）");
ok((srcCode.match(/lastUserActionAt\s*=\s*0/g) || []).length >= 2,
  "「本次请求」标记既有声明也有切会话时的清零（只匹配声明会永真）");
const histFn = (srcCode.match(/function isHistoricalBlock\(pre\) \{[\s\S]*?\n\}/) || [""])[0];
ok(histFn.length > 0, "找到 isHistoricalBlock 函数体");
ok(/Date\.now\(\) < historyGuardUntil/.test(histFn), "静默窗内的块算历史");
ok(/lastUserActionAt/.test(histFn), "没有「用户发过消息」信号时算历史");
ok(/all\[all\.length - 1\] !== msgEl/.test(histFn), "不在最后一条消息里的块算历史");
const histBranch = (srcCode.match(/if \(isHistoricalBlock\(pre\)\) \{[\s\S]*?\n  \}/) || [""])[0];
ok(histBranch.length > 0, "找到 scanPre 里的历史分支体（抽取失败时反向断言会永真）");
ok(/markProcessed\(pre, id\)/.test(histBranch) && /markProcessed\(null, codeKey\)/.test(histBranch),
  "历史块按元素与内容双重记账");
ok(/injectButton\(pre, codeText, id/.test(histBranch), "历史块只保留手动执行入口");
ok(!/scheduleExecute/.test(histBranch), "历史块不进入自动执行调度");
// 内容哈希去重必须真的参与判定，只验函数定义存在没有意义
ok(/function codeKeyFor\(code\)/.test(srcCode), "有跨渲染的内容哈希去重函数");
ok(/isProcessed\(null, codeKey\)/.test(srcCode), "去重键真的用于判定（不只是定义了 codeKeyFor）");
// 虚拟列表重挂载：元素记账丢了、内容哈希还在，此时若直接 return，
// 历史块连「手动执行」入口都会消失（实测过的回归）
const remountBranch = (srcCode.match(/if \(isProcessed\(null, codeKey\)\) \{[\s\S]*?\n  \}/) || [""])[0];
ok(remountBranch.length > 0 && /injectButton\(pre, codeText, id/.test(remountBranch),
  "重挂载的历史块仍然补回手动执行入口");

console.log("\n== 第三批复审（2026-10-25）：伪造信号、在飞定时器、扫描作用域 ==");
// 「本次请求」信号必须只认真人。页面自己的脚本 dispatchEvent 一个假 Enter
// 就能把 lastUserActionAt 刷成刚刚，让 isHistoricalBlock 判假，
// 于是伪造出来的 DOM 块会被当新回复自动执行。
ok((srcCode.match(/if \(!e\.isTrusted\) return;/g) || []).length === 2,
  "键盘与点击两处监听都要求 e.isTrusted（合成事件不能冒充用户）");
// 800ms 的排队窗口足够用户切会话；定时器开火前必须复核现场
ok(/href: location\.href/.test(srcCode), "排队时记下当时的会话地址");
ok(/if \(entry\.href !== location\.href\) return;/.test(srcCode), "开火时会话已换 → 作废");
ok(/isConnected === false\) return;/.test(srcCode), "块已脱离文档 → 作废");
ok(/function clearPendingBlocks\(\)/.test(srcCode), "有清空在飞定时器的手段");
const urlChangeBlock = (srcCode.match(/if \(location\.href !== lastHref\) \{[\s\S]*?\n    \}/) || [""])[0];
ok(urlChangeBlock.length > 0 && /clearPendingBlocks\(\)/.test(urlChangeBlock),
  "切会话时真的调用 clearPendingBlocks（只定义不调用等于没修）");
// 扫描作用域：向上 4~5 层会走到消息列表根，既强制重排，又让同一条回复里的
// 「用法示例：」把真正要执行的块整块丢掉
ok(/closest\("\.md-code-block"\)/.test(srcCode), "代码块外壳用宿主稳定类名定位");
ok(!/for \(var up2 = 0; up2 < 5; up2\+\+\)/.test(srcCode), "不再向上 5 层取整条消息文本判 skipMarkers");
ok(!/for \(var up = 0; up < 4; up\+\+\)/.test(srcCode), "不再向上 4 层读祖先 innerText 找 cuckoo");
// 回传目标不能是注入层自己的输入框（GLM 侧栏收起态的 offsetParent 并不为 null）
const findInputBody = (srcCode.match(/function findInput\(\) \{[\s\S]*?\n\}/) || [""])[0];
ok(findInputBody.length > 0 && /isInjectedUI\(tas\[i\]\)/.test(findInputBody),
  "findInput 排除注入层自己的 textarea");
ok(/#adshield-glm-container/.test((srcCode.match(/function isInjectedUI\(el\)[\s\S]*?\n\}/) || [""])[0]),
  "isInjectedUI 覆盖悬浮球容器");
// API Key：contextIsolation 不隔离 DOM，明文留在远程页面的 input 里就等于可读
const saveBody = (srcCode.match(/saveBtn\.onclick = async function\(\) \{[\s\S]*?\n  \};/) || [""])[0];
ok(saveBody.length > 0 && /apikeyInput\.value = "";/.test(saveBody),
  "保存成功后立刻抹掉 input 里的明文 Key");

console.log("\n==================================================");
if (failed === 0) console.log(`全部通过（${passed} 项）`);
else { console.log(`失败 ${failed} 项 / 通过 ${passed} 项`); process.exit(1); }
