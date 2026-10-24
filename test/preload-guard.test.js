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

// 用给定的 hostname 跑 preload，返回它是否调用了 exposeInMainWorld
function runWithHost(hostname) {
  let exposed = false;
  const fakeRequire = (id) => {
    if (id === "electron") {
      return {
        contextBridge: { exposeInMainWorld: () => { exposed = true; } },
        ipcRenderer: { on: () => {}, invoke: () => Promise.resolve({}), send: () => {} }
      };
    }
    if (id === "./package.json") return { version: "1.1.0" };
    return {};
  };
  const sandbox = {
    require: fakeRequire,
    console: { log() {}, warn() {}, error() {} },
    location: { hostname, origin: "https://" + hostname, href: "https://" + hostname + "/" },
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    // 门控放行后 init() 会碰 DOM；给最少的桩让「是否暴露桥」这个判断先完成
    document: {
      addEventListener: () => {}, readyState: "complete",
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
      createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, classList: { add() {}, remove() {} }, dataset: {} }),
      body: null, documentElement: { dataset: {}, style: {} }
    },
    MutationObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    WeakSet, Set, Map, JSON, Math, Date, Buffer, Promise, String, Number, Object, Array, RegExp, Error,
    process: { platform: "win32", versions: {} }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const wrapped = "(function (exports, require, module, __filename, __dirname) {\n" + SRC + "\n})";
  let fn;
  try {
    fn = vm.runInNewContext(wrapped, sandbox, { filename: "preload.js" });
  } catch (e) {
    return { exposed, error: "包装失败: " + e.message };
  }
  try {
    fn.call(sandbox, {}, fakeRequire, { exports: {} }, "preload.js", ".");
  } catch (e) {
    // 门控之后的 DOM 桩不完整会抛错，那是预期的；我们只关心 expose 有没有发生
    return { exposed, error: e.message };
  }
  return { exposed };
}

console.log("\n== 非 DeepSeek 站点：必须完全不注入 ==");
for (const host of ["www.bing.com", "bing.com", "evil.example.net", "localhost",
                    "deepseek.com.evil.net", "chat.deepseek.com.evil.io"]) {
  const r = runWithHost(host);
  ok(r.exposed === false, `未暴露桥接对象: ${host}` + (r.error ? `（后续抛错属预期: ${r.error.slice(0, 40)}）` : ""));
}

console.log("\n== DeepSeek 官方域名：正常放行 ==");
for (const host of ["deepseek.com", "chat.deepseek.com", "www.deepseek.com"]) {
  const r = runWithHost(host);
  ok(r.exposed === true, `已暴露桥接对象: ${host}`);
}

console.log("\n== 空/异常 hostname：按不可信处理 ==");
{
  const sandboxEmpty = runWithHost("");
  ok(sandboxEmpty.exposed === false, "空 hostname 不注入");
}

console.log("\n==================================================");
if (failed === 0) console.log(`全部通过（${passed} 项）`);
else { console.log(`失败 ${failed} 项 / 通过 ${passed} 项`); process.exit(1); }
