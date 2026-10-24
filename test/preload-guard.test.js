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

console.log("\n==================================================");
if (failed === 0) console.log(`全部通过（${passed} 项）`);
else { console.log(`失败 ${failed} 项 / 通过 ${passed} 项`); process.exit(1); }
