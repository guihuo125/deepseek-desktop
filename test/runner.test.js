// runner.js 回归测试
//
// 跑法：node test/runner.test.js
//
// 重点验证两件事：
//   1. vm 沙箱的逃逸通道确实被堵住了（.constructor / require / process 都拿不到）
//   2. 正常工具调用没被加固动作搞坏，且 edit() 的 $& 替换、safePath 越界拦截都对

const fs = require("fs");
const os = require("os");
const path = require("path");
const runner = require("../runner.js");

let failures = 0;
let total = 0;

function check(name, cond, detail) {
  total++;
  if (cond) {
    console.log("  ✓ " + name);
  } else {
    failures++;
    console.log("  ✗ " + name);
    if (detail !== undefined) console.log("      " + detail);
  }
}

// 临时工作区
const WS = fs.mkdtempSync(path.join(os.tmpdir(), "cuckoo-test-"));

async function run(code, workspace) {
  return runner.runCuckooCode(code, {
    workspace: workspace === undefined ? WS : workspace,
    deadline: 20000
  });
}

(async function main() {
  // ============ 一、沙箱逃逸必须失败 ============
  console.log("=== 沙箱逃逸必须失败 ===");

  // 判定逃逸是否成功的唯一标准：沙箱代码能否摸到宿主 realm 的 process / require。
  // 注意「沙箱里能拿到 Function 构造器」本身不算逃逸 —— vm.createContext 会给新 realm
  // 自己的一套内建对象，沙箱的 Function 造出来的函数仍然跑在沙箱 realm 里，
  // 那里没有 process。真正的逃逸是拿到「宿主的」Function。
  const ESCAPES = [
    ["Array.prototype.constructor → 宿主 Function",
      'const F = Array.prototype.constructor; return String(F("return typeof process")());'],
    ["Promise.constructor → 宿主 Function",
      'const F = Promise.constructor; return String(F("return typeof process")());'],
    ["Object.constructor → 宿主 Function",
      'return String(Object.constructor("return typeof require")());'],
    ["catch 到的 Error 顺 constructor 链上行",
      'try { null.x; } catch (e) { return String(e.constructor.constructor("return typeof process")()); }'],
    ["工具抛错后顺 Error 链上行",
      'try { await read("../nope.txt"); } catch (e) { return String(e.constructor.constructor("return typeof require")()); }'],
    ["await 得到的 Promise 的 constructor",
      'const p = bash("dir"); return String(p.constructor.constructor("return typeof process")());'],
    ["工具函数自身的 .constructor",
      'return String(typeof bash.constructor);'],
    ["工具函数的 .__proto__",
      'return String(bash.__proto__);'],
    ["直接访问 require",
      'return String(typeof require);'],
    ["直接访问 process",
      'return String(typeof process);'],
    ["直接访问 global（Node 宿主全局）",
      'return String(typeof global);'],
    ["globalThis 是沙箱自己的全局，上面没有 process/require",
      'return String(typeof globalThis.process) + "," + String(typeof globalThis.require);'],
    ["从 globalThis 顺 constructor 链上行",
      'return String(globalThis.constructor.constructor("return typeof process")());'],
    ["setTimeout 返回宿主 Timeout 对象",
      'return String(typeof setTimeout);'],
    ["String/Number/Boolean 的 constructor",
      'return String("x".constructor.constructor("return typeof process")());'],
  ];

  for (const [name, code] of ESCAPES) {
    const r = await run(code);
    // 合格 = 执行失败，或者结果明确显示宿主 process/require 不可达
    const result = r.ok ? String(r.result) : null;
    const safe = !r.ok || result === "undefined" || result === "undefined,undefined";
    check(name + "  →  " + (r.ok ? "返回 " + JSON.stringify(result.slice(0, 50)) : "抛出 " + String(r.error).slice(0, 50)),
      safe, safe ? undefined : "★ 逃逸成功：沙箱拿到了宿主 realm 的对象");
  }

  // ============ 二、正常工具调用必须可用 ============
  console.log("\n=== 正常工具调用 ===");

  fs.writeFileSync(path.join(WS, "hello.txt"), "line1\nline2\nline3\n", "utf-8");

  let r = await run('return await read("hello.txt");');
  check("read 读文件带行号", r.ok && /1: line1/.test(r.result) && /3: line3/.test(r.result),
    r.ok ? JSON.stringify(r.result.slice(0, 80)) : r.error);

  r = await run('return await write("sub/new.txt", "abc");');
  check("write 自动建目录", r.ok && fs.readFileSync(path.join(WS, "sub", "new.txt"), "utf-8") === "abc",
    r.ok ? r.result : r.error);

  r = await run('return await glob("**/*.txt");');
  check("glob 递归匹配", r.ok && /hello\.txt/.test(r.result) && /sub\/new\.txt/.test(r.result),
    r.ok ? JSON.stringify(r.result.slice(0, 120)) : r.error);

  r = await run('return await grep("line2", { include: "*.txt" });');
  check("grep 按 include 过滤", r.ok && /hello\.txt:2: line2/.test(r.result),
    r.ok ? JSON.stringify(r.result.slice(0, 120)) : r.error);

  r = await run('log("a", {b:1}); return await bash("echo hi");');
  check("bash 执行 + log 收集", r.ok && /hi/.test(r.result) && r.logs && r.logs.length > 0,
    r.ok ? JSON.stringify({ result: String(r.result).slice(0, 60), logs: r.logs }) : r.error);

  r = await run('return await pwsh("Write-Output ok");');
  check("pwsh 执行", r.ok && /ok/.test(r.result), r.ok ? JSON.stringify(String(r.result).slice(0, 60)) : r.error);

  // ============ 三、edit() 的 $& 特殊替换 bug ============
  console.log("\n=== edit() 的 $ 特殊替换 ===");

  fs.writeFileSync(path.join(WS, "dollar.txt"), "const a = 1;", "utf-8");
  r = await run('return await edit("dollar.txt", "a", "x$&y");');
  const dollarOut = fs.readFileSync(path.join(WS, "dollar.txt"), "utf-8");
  check("newString 里的 $& 按字面量写入（不被解释为匹配内容）",
    r.ok && dollarOut === "const x$&y = 1;",
    "实际文件内容: " + JSON.stringify(dollarOut));

  fs.writeFileSync(path.join(WS, "dollar2.txt"), "a-b", "utf-8");
  r = await run('return await edit("dollar2.txt", "-", "$`|$\'");');
  const dollar2Out = fs.readFileSync(path.join(WS, "dollar2.txt"), "utf-8");
  // "a-b" 里的 "-" 被替换成 "$`|$'"，所以结果是 a + $`|$' + b
  // 旧实现用 replace(str, str)，$` 会展开成「匹配点之前的内容」(a)、$' 展开成「之后的内容」(b)，
  // 结果会变成 "aa|bb" 这类东西 —— 文件被静默改坏。
  check("newString 里的 $` 和 $' 按字面量写入",
    r.ok && dollar2Out === "a$`|$'b",
    "实际文件内容: " + JSON.stringify(dollar2Out));

  fs.writeFileSync(path.join(WS, "multi.txt"), "x x x", "utf-8");
  r = await run('return await edit("multi.txt", "x", "y");');
  check("多处匹配且未指定 replaceAll 时报错", !r.ok && /匹配 3 处/.test(r.error || ""), r.error || r.result);

  fs.writeFileSync(path.join(WS, "multi.txt"), "x x x", "utf-8");
  r = await run('return await edit("multi.txt", "x", "y", true);');
  check("replaceAll=true 全部替换",
    r.ok && fs.readFileSync(path.join(WS, "multi.txt"), "utf-8") === "y y y",
    r.error || JSON.stringify(fs.readFileSync(path.join(WS, "multi.txt"), "utf-8")));

  // ============ 四、safePath 越界拦截 ============
  console.log("\n=== safePath 越界拦截 ===");

  r = await run('return await read("../escape.txt");');
  check(".. 越界被拒绝", !r.ok && /安全限制/.test(r.error || ""), r.error || r.result);

  r = await run('return await read("C:/Windows/win.ini");');
  check("绝对路径越界被拒绝", !r.ok && /安全限制/.test(r.error || ""), r.error || r.result);

  r = await run('return await write("../evil.txt", "x");');
  check("越界写入被拒绝", !r.ok && /安全限制/.test(r.error || ""), r.error || r.result);

  r = await run('return await bash("dir", { cwd: "C:/Windows" });');
  check("bash 的 cwd 越界被拒绝", !r.ok && /安全限制/.test(r.error || ""), r.error || r.result);

  // junction 绕过：Windows 上建一个指向工作区外的目录链接
  if (process.platform === "win32") {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cuckoo-outside-"));
    fs.writeFileSync(path.join(outside, "secret.txt"), "TOP SECRET", "utf-8");
    const linkPath = path.join(WS, "junction");
    let made = false;
    try {
      require("child_process").execFileSync("cmd", ["/c", "mklink", "/J", linkPath, outside], { windowsHide: true });
      made = true;
    } catch (e) { /* 没权限就跳过 */ }
    if (made) {
      r = await run('return await read("junction/secret.txt");');
      check("junction 指向工作区外时 realpath 拦截生效",
        !r.ok && /安全限制/.test(r.error || ""), r.error || JSON.stringify(String(r.result).slice(0, 60)));
    } else {
      console.log("  - 跳过 junction 测试（无法创建目录链接）");
    }
    try { fs.rmSync(outside, { recursive: true, force: true }); } catch (e) {}
  }

  // ============ 五、未设置工作区时必须禁用工具 ============
  console.log("\n=== 未设置工作区 ===");

  r = await run('return await read("hello.txt");', "");
  check("未选工作区时 read 被拒绝并给出引导", !r.ok && /未设置工作区/.test(r.error || ""), r.error || r.result);

  r = await run('return await bash("dir");', null);
  check("未选工作区时 bash 被拒绝", !r.ok && /未设置工作区/.test(r.error || ""), r.error || r.result);

  // ============ 六、大文件保护 ============
  console.log("\n=== 大小上限 ===");

  const big = path.join(WS, "big.bin");
  fs.writeFileSync(big, Buffer.alloc(3 * 1024 * 1024, 0x41));
  r = await run('return await read("big.bin");');
  check("超过 2MB 的文件拒绝读取", !r.ok && /文件过大/.test(r.error || ""), r.error || String(r.result).slice(0, 60));
  fs.unlinkSync(big);

  // shell 输出与返回值都必须有上限：否则一条刷屏命令就能撑爆 worker 内存，
  // 并把超大的结构化克隆 payload 塞进 IPC 通道
  const huge = path.join(WS, "huge.txt");
  fs.writeFileSync(huge, "a".repeat(runner.MAX_SHELL_OUTPUT_BYTES + 64 * 1024) + "\n");
  r = await run('return await bash("type huge.txt");');
  check("shell 输出超过上限被截断",
    r.ok && String(r.result).length < runner.MAX_SHELL_OUTPUT_BYTES && /已截断/.test(String(r.result)),
    "len=" + String(r.result).length + " err=" + (r.error || ""));
  fs.unlinkSync(huge);

  r = await run('return "x".repeat(300000);');
  check("返回值超过 200KB 被截断",
    r.ok && String(r.result).length < runner.MAX_RESULT_CHARS + 200 && /已截断/.test(String(r.result)),
    "len=" + String(r.result).length);

  // ============ 七、错误诊断信息 ============
  console.log("\n=== 错误诊断 ===");

  r = await run('const x = 1;\nthrow new Error("boom");');
  check("抛出异常时带 errorType/errorLine", !r.ok && r.errorType === "Error" && r.errorLine >= 2,
    JSON.stringify({ error: r.error, errorType: r.errorType, errorLine: r.errorLine }));

  r = await run('return await bash("this-command-does-not-exist-xyz");');
  check("命令不存在时不崩溃、有输出", r.ok && typeof r.result === "string" && r.result.length > 0,
    r.error || JSON.stringify(String(r.result).slice(0, 80)));

  r = await run('return "plain";');
  check("纯返回值正常", r.ok && r.result === "plain", r.error || JSON.stringify(r.result));

  r = await run('return { a: 1 };');
  check("对象返回值被序列化为字符串", r.ok && typeof r.result === "string" && /"a": 1/.test(r.result),
    r.error || JSON.stringify(r.result));

  // ============ 清理 ============
  try { fs.rmSync(WS, { recursive: true, force: true }); } catch (e) {}

  console.log("\n" + "=".repeat(50));
  console.log(failures === 0 ? "全部通过（" + total + " 项）" : failures + " / " + total + " 项失败");
  process.exit(failures === 0 ? 0 : 1);
})();
