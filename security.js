// cuckoo 代码安全分级（白名单模型）
//
// 为什么不用黑名单：黑名单永远补不全。python() 的代码体、PowerShell 的 .NET API、
// shell 重定向符号、变量拼接都能绕过，而漏判一次的代价就是本地 RCE。
// 这里反过来做：只有能被静态证明为「只读、无副作用」的代码才算 safe，其余一律 dangerous。
//
// 判级结果：
//   safe      —— 自动执行，不打扰用户
//   dangerous —— 弹确认框，用户点了才执行
//   forbidden —— 直接拒绝，用户确认也不执行

const path = require("path");

// ============ 绝对禁止（破坏性磁盘/系统操作，确认也不放行）============
const FORBIDDEN = [
  { p: /\bformat(\.com)?\s+[a-z]:/i,          desc: "格式化磁盘，会清空整块硬盘数据，不可恢复" },
  { p: /\bdiskpart\b/i,                        desc: "磁盘分区工具，误操作会导致分区表损坏、数据丢失" },
  { p: /\brm\s+(-[a-z]*[rf][a-z]*\s+)+[\/~]/i, desc: "递归强制删除根目录或用户主目录，无法恢复" },
  { p: /\brm\s+-rf\s+\./i,                     desc: "递归强制删除当前目录全部内容，无法恢复" },
  { p: /\bdel\s+\/f\s+\/s\s+\/q\s+[a-z]:\\?\*/i, desc: "递归强制删除整盘文件，无法恢复" },
  { p: /\brd\s+\/s\s+\/q\s+[a-z]:\s*$/i,       desc: "递归删除整个磁盘目录，无法恢复" },
  { p: /\bhalt\b/i,                            desc: "立即停止系统，可能导致数据损坏" },
  { p: /\bmkfs\b/i,                            desc: "格式化文件系统，会清空分区数据" },
  { p: /\bcipher\s+\/w/i,                      desc: "擦除磁盘空闲空间，无法恢复已删除文件" },
  { p: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, desc: "Fork 炸弹，会耗尽系统资源导致死机" },
  { p: /\breg\s+delete\s+HKLM\\SYSTEM/i,       desc: "删除系统注册表，会导致系统无法启动" },
  { p: /\bvssadmin\s+delete\s+shadows/i,       desc: "删除系统卷影副本，会破坏备份恢复能力" },
  // wmic 与 vssadmin 是同一件事的另一个入口，只写 vssadmin 等于没写
  { p: /\bwmic\s+shadowcopy\s+delete/i,        desc: "通过 wmic 删除卷影副本，与 vssadmin 同语义，会破坏备份恢复能力" },
  { p: /\bwbadmin\s+delete\b/i,                desc: "删除系统备份，无法恢复" },
  { p: /\bdd\s+if=.*\bof=\/dev\//i,            desc: "dd 直写块设备，会覆盖整块磁盘，不可恢复" },
  { p: />\s*\/dev\/(sd|hd|nvme|disk)/i,        desc: "重定向覆盖块设备，会毁掉整块磁盘" },
  { p: /\bRemove-Item\b.*\b[CD]:\\?\s*$/i,     desc: "递归删除整个磁盘根目录，无法恢复" },
  { p: /\[System\.IO\.(Directory|File)\]::Delete\s*\(\s*["'][A-Z]:\\?["']/i, desc: "用 .NET API 删除磁盘根目录，无法恢复" }
];

// ============ 只读命令白名单 ============
// 只收录「无论加什么参数都不会产生副作用」的命令。
// 宁可漏收（多弹一次确认框），不可错收（放行了写操作）。
const CMD_READONLY = new Set([
  "dir", "type", "more", "findstr", "find", "where", "tree",
  "fc", "ver", "hostname", "whoami", "systeminfo", "tasklist", "echo", "help"
]);

const PS_READONLY = new Set([
  "get-childitem", "gci", "ls", "dir",
  "get-content", "gc", "cat", "type",
  "get-location", "gl", "pwd",
  "get-item", "gi",
  "get-process", "gps",
  "get-command", "gcm",
  "select-string", "sls",
  "get-date", "write-output", "write-host", "echo",
  "test-path", "measure-object",
  "get-itemproperty", "gp",
  "get-service", "gsv",
  "get-host", "get-culture", "get-uiculture",
  "out-string", "format-table", "ft", "format-list", "fl", "format-wide", "fw",
  "select-object", "get-variable", "gv", "get-alias", "gal", "get-member", "gm",
  "get-help", "get-filehash", "get-authenticodesignature", "get-computerinfo"
]);

// ============ 工具分类 ============
// 只读工具：不产生任何副作用
const READONLY_TOOLS = new Set(["read", "glob", "grep", "log", "sleep"]);
// 有副作用的工具：一律需要确认
const MUTATING_TOOLS = new Set(["write", "edit"]);
// 无法静态分析的工具：一律需要确认
const OPAQUE_TOOLS = new Set(["python"]);
// shell 工具 → 用哪张白名单判定
const SHELL_TOOLS = { bash: "cmd", pwsh: "pwsh" };

const TOOL_NAMES = Object.keys(SHELL_TOOLS)
  .concat(Array.from(READONLY_TOOLS), Array.from(MUTATING_TOOLS), Array.from(OPAQUE_TOOLS));

// vm 沙箱逃逸所需的原语。命中任意一个就说明代码在试图绕过工具层，
// 不管工具调用看起来多无害，都判定为 dangerous。
const ESCAPE_PRIMITIVES = [
  { p: /\brequire\s*\(/,                 desc: "尝试加载 Node 模块，可绕过工具层直接调用 child_process" },
  { p: /\bprocess\b/,                    desc: "尝试访问宿主进程对象" },
  { p: /\bglobalThis\b|\bglobal\s*\./,   desc: "尝试访问宿主全局对象" },
  { p: /\beval\s*\(/,                    desc: "动态执行字符串代码，无法静态审查" },
  { p: /\bFunction\s*\(/,                desc: "用 Function 构造器动态生成代码，是典型的沙箱逃逸手法" },
  { p: /\.constructor\b/,                desc: "通过 .constructor 取回宿主 Function 构造器，是典型的沙箱逃逸手法" },
  { p: /__proto__|__defineGetter__|__defineSetter__/, desc: "操作原型链，可能污染宿主对象" },
  { p: /\bimport\s*\(|\bimport\s+[\w{*]/, desc: "动态/静态导入模块，可绕过工具层" },
  { p: /\bProxy\b|\bReflect\b/,          desc: "元编程接口，可拦截并绕过沙箱检查" }
];

// ============ 用户策略：只有删除类不可逆操作才确认 ============
// 2026-10-24 用户明确要求：不要再因为管道、变量展开、非白名单命令、写文件弹窗，
// 只有「删除文件」这类不可逆操作才需要确认。为了让这条策略不至于把系统关机、
// 沙箱逃逸也一起放开，下面单独保留这些硬信号：
//   · DESTRUCTIVE_INTENT —— 删除 / 关机 / 杀进程（用户最在意的「不可逆」集合）
//   · ESCAPE_PRIMITIVES  —— 沙箱逃逸
//   · 越界 / UNC / URL    —— 数据外泄
// 其余 dangerous 在 finish() 里降级为 safe，自动执行。
const DESTRUCTIVE_INTENT = [
  { p: /\brm\b/i,              desc: "删除文件/目录" },
  { p: /\brmdir\b/i,           desc: "删除目录" },
  { p: /\brd\b/i,              desc: "删除目录" },
  { p: /\bdel\b/i,             desc: "删除文件" },
  { p: /\berase\b/i,           desc: "删除文件" },
  { p: /\bunlink\b/i,          desc: "删除文件/链接" },
  { p: /remove-item/i,         desc: "Remove-Item 删除文件/目录" },
  { p: /\bdelete\s*\(/i,      desc: "调用删除 API" },
  { p: /os\.remove\b/i,        desc: "os.remove 删除文件" },
  { p: /shutil\.rmtree/i,      desc: "递归删除目录" },
  { p: /\bshutdown\b/i,        desc: "关机" },
  { p: /\brestart-computer\b/i,desc: "重启计算机" },
  { p: /\bstop-computer\b/i,   desc: "关闭计算机" },
  { p: /\btaskkill\b/i,        desc: "强制结束进程" },
  { p: /\bstop-process\b/i,    desc: "结束进程" },
  // 别名与漏项（2026-10-25 审查实测）：只写 Remove-Item 而漏掉 PowerShell 官方别名
  // ri，`pwsh("ri C:\x -Recurse -Force")` 就会一路落到「非白名单命令」分支被降级成
  // 自动执行 —— 递归删除不弹窗，直接违背「删除必须确认」这条策略的本意。
  { p: /(^|[\s;&|`(])ri(\s|$)/i,   desc: "ri 是 Remove-Item 别名，删除文件/目录" },
  { p: /(^|[\s;&|`(])kill(\s|$)/i, desc: "kill 强制结束进程" }
];

// 命令名层面的删除/杀进程动词（含别名），供 classifyShell 解析出 exe 后判定。
// 与 DESTRUCTIVE_INTENT 的整段关键字扫描互补：关键字扫描管管道里的第二段，
// 这里管第一段。
const DESTRUCTIVE_EXE = new Set([
  "rm", "rmdir", "rd", "del", "erase", "unlink", "shred",
  "remove-item", "ri", "delitem", "di", "remove-itemproperty", "rp",
  "remove-psdrive", "kill", "stop-process", "spps", "taskkill",
  "shutdown", "restart-computer", "stop-computer"
]);

// ============ 编码/动态执行：静态审查看不见载荷 ============
// 这几条的共同点是「真正的命令在运行时才存在」，前面所有的关键字/路径扫描
// 扫的都是编码前的文本，等于全部失效。实测 `pwsh("powershell -enc ...")`、
// `python("...exec(base64.b64decode(...))")` 都判 safe 自动执行。
const OPAQUE_EXEC = [
  { p: /-(?:enc|encodedcommand)\b/i,  desc: "PowerShell -EncodedCommand：命令以 Base64 传入，内容无法静态审查" },
  { p: /\biex\b|invoke-expression/i,    desc: "Invoke-Expression / iex：动态执行字符串，等价于任意代码执行" },
  { p: /frombase64string|b64decode|base64\.b64decode/i, desc: "运行时解码 Base64 载荷，静态审查看不到真实命令" },
  { p: /\bexec\s*\(\s*(?:compile|codecs|base64|marshal)/i, desc: "解码后动态执行 Python 代码" },
  { p: /\badd-type\b/i,                 desc: "Add-Type 在内存里编译并执行 C# 代码，绕过所有文本层审查" },
  { p: /certutil\s+-(?:decode|urlcache)/i, desc: "certutil 解码/下载后常配合执行，载荷不可见" },
  { p: /\bmklink\b|-(?:itemtype|type)\s+(?:symboliclink|junction)/i, desc: "创建符号链接/目录联接，可把后续读写引到工作区外" }
];

function matchesTable(table, code) {
  const src = String(code || "");
  for (const t of table) if (t.p.test(src)) return t.desc;
  return null;
}

function hasDestructiveIntent(code) {
  const src = String(code || "");
  for (const d of DESTRUCTIVE_INTENT) {
    if (d.p.test(src)) return true;
  }
  return false;
}

// 去掉字符串字面量，只留真正的代码。
// 旧版逃逸检测直接扫含字符串的源码，pwsh("Get-Process ...") 里的 process
// 会被误判成「访问宿主进程对象」——这正是用户截图里反复弹窗的来源之一。
function stripStrings(code) {
  let out = "";
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(code, i);
      out += '""';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function hasEscapeIntent(code) {
  const bare = stripStrings(code);
  for (const e of ESCAPE_PRIMITIVES) {
    if (e.p.test(bare)) return true;
  }
  return false;
}

// ============ JS 字符串字面量扫描 ============

// 从 i（指向引号）开始，返回闭合引号之后的下标
function skipString(code, i) {
  const quote = code[i];
  const n = code.length;
  i++;
  while (i < n) {
    const c = code[i];
    if (c === "\\") { i += 2; continue; }
    if (quote === "`" && c === "$" && code[i + 1] === "{") {
      // 模板插值：跳过嵌套的 {}
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        const d = code[i];
        if (d === '"' || d === "'" || d === "`") { i = skipString(code, i); continue; }
        if (d === "{") depth++;
        else if (d === "}") depth--;
        i++;
      }
      continue;
    }
    if (c === quote) return i + 1;
    i++;
  }
  return n;
}

// 解码 JS 字符串字面量。遇到任何不能确定的转义就返回 null（调用方按 dangerous 处理）
function decodeStringLiteral(src) {
  if (src.length < 2) return null;
  const quote = src[0];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  if (src[src.length - 1] !== quote) return null;
  const body = src.slice(1, -1);
  // 模板插值无法静态求值
  if (quote === "`" && /\$\{/.test(body)) return null;

  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") { out += ch; continue; }
    const e = body[++i];
    switch (e) {
      case "n": out += "\n"; break;
      case "t": out += "\t"; break;
      case "r": out += "\r"; break;
      case "b": out += "\b"; break;
      case "f": out += "\f"; break;
      case "v": out += "\v"; break;
      case "0":
        // \0 单独出现是 NUL；后面还跟数字就是遗留八进制转义，属于刻意混淆，放弃分析
        if (/[0-7]/.test(body[i + 1] || "")) return null;
        out += "\0";
        break;
      case "1": case "2": case "3": case "4": case "5": case "6": case "7":
        // 非严格模式下 JS 会把 \1 当八进制转义（"\1" === "\u0001"）。
        // 正常代码不会这么写，出现即视为混淆，交给用户确认而不是猜它的值。
        return null;
      case "\\": out += "\\"; break;
      case "'": out += "'"; break;
      case '"': out += '"'; break;
      case "`": out += "`"; break;
      case "\n": break; // 行继续符
      case "x": {
        const h = body.substr(i + 1, 2);
        if (!/^[0-9a-fA-F]{2}$/.test(h)) return null;
        out += String.fromCharCode(parseInt(h, 16));
        i += 2;
        break;
      }
      case "u": {
        if (body[i + 1] === "{") {
          const close = body.indexOf("}", i);
          if (close < 0) return null;
          const h = body.slice(i + 2, close);
          if (!/^[0-9a-fA-F]+$/.test(h)) return null;
          out += String.fromCodePoint(parseInt(h, 16));
          i = close;
        } else {
          const h = body.substr(i + 1, 4);
          if (!/^[0-9a-fA-F]{4}$/.test(h)) return null;
          out += String.fromCharCode(parseInt(h, 16));
          i += 4;
        }
        break;
      }
      // 其余为 JS 恒等转义（如 "C:\Users" 里的 \U 求值为 U），照实还原。
      // 这里必须与 JS 引擎语义完全一致，否则静态分析看到的命令和真正执行的命令会不同。
      default:
        if (e === undefined) return null; // 字符串以孤立反斜杠结尾，异常输入
        out += e;
    }
  }
  return out;
}

// 判断一段源码是不是「纯字符串字面量」，是则返回解码后的值，否则返回 null
function literalValue(raw) {
  const s = (raw || "").trim();
  if (s.length < 2) return null;
  const q = s[0];
  if (q !== '"' && q !== "'" && q !== "`") return null;
  if (s[s.length - 1] !== q) return null;
  // 中间不能有未转义的同类引号（否则就不是单一字面量）
  const inner = s.slice(1, -1);
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "\\") { i++; continue; }
    if (inner[i] === q) return null;
  }
  return decodeStringLiteral(s);
}

// 去掉注释、保留字符串内容。
// FORBIDDEN 的原始扫描基于这个结果：这样「注释里提到 rm -rf /」不会误伤用户
// （FORBIDDEN 是不可放行的硬拦截，误伤代价高），但 `var c = "format c:"; bash(c)`
// 这种把命令藏进变量、绕过调用点分析的写法照样会被抓到。
function stripComments(code) {
  let out = "";
  const n = code.length;
  let i = 0;
  while (i < n) {
    const c = code[i];
    if (c === '"' || c === "'" || c === "`") {
      const end = skipString(code, i);
      out += code.slice(i, end);
      i = end;
      continue;
    }
    if (c === "/" && code[i + 1] === "/") {
      while (i < n && code[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && code[i + 1] === "*") {
      i += 2;
      while (i < n && !(code[i] === "*" && code[i + 1] === "/")) i++;
      i += 2;
      out += " ";
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// ============ 工具调用点解析 ============

// 从 openIdx（指向 "("）开始解析实参列表，返回 { args: [{raw, literal}], end }
function parseArgs(code, openIdx) {
  const n = code.length;
  const args = [];
  let depth = 0;
  let cur = "";
  let i = openIdx;
  while (i < n) {
    const c = code[i];
    if (c === '"' || c === "'" || c === "`") {
      const end = skipString(code, i);
      cur += code.slice(i, end);
      i = end;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      depth++;
      // 最外层那个 "(" 是调用语法，不属于参数内容
      if (depth > 1) cur += c;
      i++;
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0 && c === ")") { args.push(makeArg(cur)); return { args: args, end: i + 1 }; }
      cur += c;
      i++;
      continue;
    }
    if (c === "," && depth === 1) { args.push(makeArg(cur)); cur = ""; i++; continue; }
    cur += c;
    i++;
  }
  if (cur.trim()) args.push(makeArg(cur));
  return { args: args, end: n };
}

function makeArg(raw) {
  return { raw: raw.trim(), literal: literalValue(raw) };
}

// 扫描代码里所有工具调用点（跳过注释与字符串内部）
function scanToolCalls(code) {
  const calls = [];
  const n = code.length;
  let i = 0;
  while (i < n) {
    const c = code[i];
    if (c === "/" && code[i + 1] === "/") {
      while (i < n && code[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && code[i + 1] === "*") {
      i += 2;
      while (i < n && !(code[i] === "*" && code[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { i = skipString(code, i); continue; }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(code[j])) j++;
      const name = code.slice(i, j);
      const prev = i > 0 ? code[i - 1] : "";
      const isMemberOrShorthand = prev === "." || /[A-Za-z0-9_$]/.test(prev);
      let k = j;
      while (k < n && /\s/.test(code[k])) k++;
      if (TOOL_NAMES.indexOf(name) !== -1 && code[k] === "(" && !isMemberOrShorthand) {
        const parsed = parseArgs(code, k);
        calls.push({ name: name, args: parsed.args, index: i });
        i = parsed.end;
        continue;
      }
      i = j;
      continue;
    }
    i++;
  }
  return calls;
}

// 工具名被间接引用（赋值给变量、成员访问、逗号表达式、当值传走）时，真正的调用点
// 静态看不到，参数也就从没进过 classifyShell。实测 `let f = bash; f("ri C:\x -Force")`、
// `(0,bash)("ri ...")`、`const o={bash:bash}; o.bash("ri ...")` 三条全部判 safe，
// 等于整套分级被绕过。只看去掉字符串与注释后的裸代码，所以 console.log 这类
// 成员访问不会被误伤（log 前面是点）。
function findIndirectToolRef(bareCode) {
  const re = /([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(bareCode))) {
    const name = m[1];
    if (TOOL_NAMES.indexOf(name) === -1) continue;
    if (/\.\s*$/.test(bareCode.slice(0, m.index))) continue;
    if (/^\s*\(/.test(bareCode.slice(m.index + name.length))) continue;
    return name;
  }
  return null;
}

// ============ shell 命令判定 ============

// 取出命令的第一个 token（可执行名），正确处理带引号的路径
function firstToken(cmd) {
  const s = cmd.trim();
  if (!s) return { exe: "", rest: "" };
  const q = s[0];
  if (q === '"' || q === "'") {
    const end = s.indexOf(q, 1);
    if (end < 0) return { exe: s.slice(1), rest: "" };
    return { exe: s.slice(1, end), rest: s.slice(end + 1) };
  }
  const idx = s.search(/\s/);
  if (idx < 0) return { exe: s, rest: "" };
  return { exe: s.slice(0, idx), rest: s.slice(idx) };
}

// ============ 工作区边界 ============
// 白名单只能证明「命令只读」，不能证明「读的是工作区内」。
// type / Get-Content 这类只读命令照样能读 C:\Users 下的文件，而结果会自动回传云端，
// 所以这里必须再补一层路径边界检查。

function isInsideWorkspace(abs, workspace) {
  const ws = path.resolve(workspace);
  if (process.platform === "win32") {
    const a = abs.toLowerCase();
    const w = ws.toLowerCase().replace(/[\\/]+$/, "");
    return a === w || a.startsWith(w + "\\");
  }
  const w = ws.replace(/[\\/]+$/, "");
  return abs === w || abs.startsWith(w + path.sep);
}

// 提取命令里的绝对路径（支持带引号、带空格的路径）
function extractPathTokens(cmd) {
  const tokens = [];
  let i = 0;
  while (i < cmd.length) {
    const ch = cmd[i];
    if (ch === '"' || ch === "'") {
      const end = cmd.indexOf(ch, i + 1);
      const inner = end === -1 ? cmd.slice(i + 1) : cmd.slice(i + 1, end);
      tokens.push(inner);
      i = end === -1 ? cmd.length : end + 1;
      continue;
    }
    if (/^[A-Za-z]:[\\/]/.test(cmd.slice(i, i + 3)) && !/[A-Za-z0-9_$]/.test(cmd[i - 1] || "")) {
      // 前一个字符不能是标识符字符：否则注册表路径 HKCU:\Software 会被人从中间
      // 截出 "U:\Software" 当成工作区外的磁盘路径（实测会误弹一次确认）。
      let j = i;
      while (j < cmd.length && !/[\s"'|&;<>)]/.test(cmd[j])) j++;
      tokens.push(cmd.slice(i, j));
      i = j;
      continue;
    }
    i++;
  }
  return tokens;
}

// 各工具的路径参数在第几个位置：grep 的第一个参数是模式，路径是第二个。
// 不能"所有字符串参数都当路径查"，否则 write("a.txt", "C:\\Windows\\x") 会把
// 文件内容里的绝对路径误判成越界。
const PATH_ARG = { read: 0, write: 0, edit: 0, glob: 0, grep: 1 };

function toolPathArg(name, call) {
  const idx = PATH_ARG[name];
  return idx == null ? null : call.args[idx];
}

// 工具调用（read/write/edit/glob/grep）的路径参数。
// 只读工具同样能把工作区外的文件内容读出来并自动回传云端，所以边界检查
// 不能只做在 shell 通道上。执行侧还有 runner.safePath 兜底，这里的职责是
// 「让越界变成一次可见的确认」，而不是唯一防线 —— 所以不把「路径来自变量」
// 升级成弹窗（`const f="src/a.js"; read(f)` 是常见写法，误伤代价太高）。
function toolPathEscapeReason(arg, options) {
  if (!arg) return null;
  const ws = options && options.workspace;
  if (typeof arg.literal === "string" && arg.literal) {
    return checkOnePath(arg.literal, ws);
  }
  // 非字面量（对象字面量 / 变量）：退一步扫原文里能看见的绝对路径。
  // grep 的搜索根就在第二个参数的 { path: "..." } 里。
  const raw = String(arg.raw || "");
  for (const token of extractPathTokens(raw)) {
    const why = checkOnePath(token, ws);
    if (why) return why;
  }
  return null;
}

function checkOnePath(p, ws) {
  if (/^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p)) {
    if (!ws) return "工具访问绝对路径，但未设置工作区，无法确认是否越界";
    if (!isInsideWorkspace(path.resolve(p), ws)) return "工具访问工作区之外的路径：" + p;
    return null;
  }
  if (/(^|[\\/])\.\.([\\/]|$)/.test(p)) return "工具路径包含 ..，可能跳出工作区：" + p;
  return null;
}

function pathEscapeReason(cmd, workspace) {
  for (const token of extractPathTokens(cmd)) {
    if (!/^[A-Za-z]:[\\/]/.test(token)) continue;
    if (!workspace) return "命令引用了绝对路径，但未设置工作区，无法确认是否越界";
    if (!isInsideWorkspace(path.resolve(token), workspace)) {
      return "命令访问工作区之外的路径：" + token;
    }
  }

  // 相对路径穿越：.. / ..\x / a\..\b
  if (/(^|[\s"'=,(])\.\.([\\/]|\s|$)/.test(cmd) || /[\\/]\.\.([\\/]|$)/.test(cmd)) {
    return "命令包含 .. 相对路径，可能跳出工作区";
  }

  // 变量展开 / 家目录：真实路径无法静态确认
  if (/%[^%\s]+%/.test(cmd)) return "命令包含环境变量展开（%VAR%），实际路径无法静态确认";
  if (/\$env:/i.test(cmd)) return "命令包含环境变量展开（$env:），实际路径无法静态确认";
  if (/(^|[\s"'=,(])~([\\/]|\s|$)/.test(cmd)) return "命令包含 ~ 家目录，实际路径无法静态确认";

  return null;
}

function classifyShell(cmd, flavor, options) {
  if (typeof cmd !== "string") {
    // 变量拼接后完全看不出真实命令，属于无法审查，保持确认
    return { ok: false, hard: true, why: "命令不是字面量字符串（可能由变量拼接），无法静态审查" };
  }
  if (/[\r\n]/.test(cmd)) {
    return { ok: false, hard: false, why: "命令包含换行，等价于多条命令串联" };
  }
  // UNC 路径会触发 SMB 认证，把本机 NTLM 凭据发给远端；URL 则可能外传数据。
  // 这两条必须在控制符判定之前：Invoke-WebRequest 里本来就有 $env: 与括号，
  // 先走控制符分支会把外联风险降级成普通语法噪音。
  if (/\\\\|\/\//.test(cmd)) {
    return { ok: false, hard: true, why: "命令包含 UNC 路径或 URL，可能触发凭据外泄或网络请求" };
  }
  if (/(https?|ftp|file):/i.test(cmd)) {
    return { ok: false, hard: true, why: "命令包含网络/文件协议地址" };
  }
  // 工作区外的绝对路径必须在「控制符 / 非白名单」这两次降级之前判。
  // 旧实现把 pathEscapeReason 放在白名单判定之后，于是 `echo x > C:\...\Startup\x.bat`
  // （带 >）、`copy /y C:\Users\me\Desktop\a.txt D:\pub`（非白名单）全部绕过越界检查，
  // 实测直接自动执行 —— 而浮层一直在对用户承诺「读写仅限该目录内」。
  for (const token of extractPathTokens(cmd)) {
    if (!/^[A-Za-z]:[\\/]/.test(token)) continue;
    if (!(options && options.workspace)) {
      return { ok: false, hard: true, why: "命令引用了绝对路径，但未设置工作区，无法确认是否越界" };
    }
    if (!isInsideWorkspace(path.resolve(token), options.workspace)) {
      return { ok: false, hard: true, why: "命令访问工作区之外的路径：" + token };
    }
  }
  // 整盘导出环境变量：里面通常躺着 API Key / Token，而执行结果会自动回传云端。
  // 注意只拦「列举整个 env: 驱动」与裸 set/printenv，引用单个 $env:VAR 仍按
  // 用户要求的「变量展开不弹窗」放行。
  if (/(^|[\s;&|`(])(set|printenv)(\s|$|[)&|;"])/i.test(cmd) ||
      /\b(get-childitem|gci|dir|ls|get-item|gi)\s+(?:-path\s+)?env:/i.test(cmd)) {
    return { ok: false, hard: true, why: "命令会整盘导出环境变量（可能包含密钥），执行结果会自动回传给云端" };
  }
  // shell 控制符 / 变量展开 / 命令分组：按用户要求不再弹窗，
  // 但删除/关机等不可逆操作会在 finish() 里按整段源码再拦一次
  if (/[|&;<>`$(){}!]/.test(cmd)) {
    return { ok: false, hard: false, why: "命令包含 shell 控制符或变量展开（| & ; < > ` $ ( ) { } !）" };
  }

  const token = firstToken(cmd);
  // 去掉路径与扩展名，只留可执行名
  const exe = token.exe.split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|com|bat|cmd|ps1)$/, "");
  const whitelist = flavor === "pwsh" ? PS_READONLY : CMD_READONLY;
  if (!exe) return { ok: false, hard: true, why: "无法解析出命令名" };
  // 命令名本身就是删除/杀进程动词（含别名）—— 必须在「非白名单 → 降级」之前判，
  // 否则 `ri`、`kill` 这些会因为不在只读白名单里而被当成普通非白名单命令放行。
  if (DESTRUCTIVE_EXE.has(exe)) {
    return { ok: false, hard: true, why: "`" + exe + "` 属于删除/结束进程类命令，操作不可逆" };
  }
  if (exe === "reg" && /\bdelete\b/i.test(cmd)) {
    return { ok: false, hard: true, why: "reg delete 删除注册表项，可能导致系统或软件不可用" };
  }
  if (exe === "schtasks" && /\/delete/i.test(cmd)) {
    return { ok: false, hard: true, why: "schtasks /delete 删除计划任务" };
  }
  if (!whitelist.has(exe)) {
    // 用户要求「只有删除才弹」：非白名单命令也放行自动执行。
    // 这是明确的策略选择，风险由 finish() 里的删除/逃逸检测兜底。
    return { ok: false, hard: false, why: "`" + exe + "` 不在只读命令白名单内" };
  }

  const escape = pathEscapeReason(cmd, options && options.workspace);
  if (escape) return { ok: false, hard: true, why: escape };

  return { ok: true, hard: false, exe: exe };
}

// ============ 主入口 ============

function checkCode(code, options) {
  const result = { level: "safe", items: [] };

  function add(level, cmd, desc, hard) {
    result.items.push({
      cmd: String(cmd == null ? "" : cmd).substring(0, 200),
      desc: desc,
      level: level,
      hard: !!hard
    });
    if (level === "forbidden") result.level = "forbidden";
    else if (level === "dangerous" && result.level !== "forbidden") result.level = "dangerous";
  }

  const src = typeof code === "string" ? code : "";
  if (!src.trim()) {
    result.level = "dangerous";
    add("dangerous", "(空)", "代码为空，无法判断意图", false);
    return finish(result, src);
  }

  // ---- 1. 绝对禁止：扫描去掉注释后的源码（字符串内容仍保留）----
  const scannable = stripComments(src);
  for (const f of FORBIDDEN) {
    if (f.p.test(scannable)) {
      add("forbidden", "(代码片段)", f.desc);
      return finish(result, src);
    }
  }

  // ---- 2. 沙箱逃逸原语（只看代码，不看字符串内容，避免 Get-Process 这类误报）----
  const bareCode = stripStrings(scannable);
  for (const e of ESCAPE_PRIMITIVES) {
    if (e.p.test(bareCode)) add("dangerous", "(代码片段)", e.desc, true);
  }

  // ---- 2b. 编码/动态执行：载荷在运行时才存在，扫字符串本体没有意义 ----
  const opaque = matchesTable(OPAQUE_EXEC, scannable);
  if (opaque) add("dangerous", "(代码片段)", opaque, true);

  // ---- 2c. 工具被间接引用，调用点无法静态识别 ----
  const indirect = findIndirectToolRef(bareCode);
  if (indirect) {
    add("dangerous", "(代码片段)",
      "工具名 " + indirect + " 被间接引用（赋值给变量 / 别名 / 成员访问），实际调用与参数无法静态审查", true);
  }

  // ---- 3. 逐个工具调用判定 ----
  const calls = scanToolCalls(src);

  // 绝对禁止还要再扫一遍「解码后」的字面量，否则 rm -rf \u002f 这类
  // Unicode 转义能骗过上面基于原始源码的匹配。
  for (const call of calls) {
    for (const arg of call.args) {
      if (arg.literal == null) continue;
      for (const f of FORBIDDEN) {
        if (f.p.test(arg.literal)) {
          add("forbidden", call.name + "(" + arg.literal + ")", f.desc);
          return finish(result, src);
        }
      }
    }
  }

  if (calls.length === 0) {
    add("dangerous", "(代码片段)", "未识别到任何 cuckoo 工具调用，无法确认这段代码的意图", false);
  }

  for (const call of calls) {
    const name = call.name;

    if (READONLY_TOOLS.has(name)) {
      // 只读工具也要过边界：实测 read("C:\Users\me\.ssh\id_rsa") 原先判 safe，
      // 私钥内容会被原样回传给云端 —— 这是本轮审查里后果最直接的一条。
      if (name !== "log" && name !== "sleep") {
        const why = toolPathEscapeReason(toolPathArg(name, call), options);
        if (why) {
          const shown = toolPathArg(name, call);
          add("dangerous", name + "(" + (shown ? (shown.literal || shown.raw) : "") + ")",
            why, true);
        }
      }
      continue;
    }

    if (MUTATING_TOOLS.has(name)) {
      const pathArg = toolPathArg(name, call);
      const target = pathArg ? (pathArg.literal || pathArg.raw) : "(未知路径)";
      const why = toolPathEscapeReason(pathArg, options);
      if (why) {
        // 写工作区外 = 越界，属硬信号；写工作区内按用户要求不弹窗
        add("dangerous", name + "(" + target + ")", why, true);
      } else {
        add("dangerous", name + "(" + target + ")",
          name === "write" ? "写入/覆盖文件，会改变磁盘内容" : "修改文件内容，会改变磁盘内容", false);
      }
      continue;
    }

    if (OPAQUE_TOOLS.has(name)) {
      add("dangerous", name + "(...)",
        "Python 代码无法静态审查，可以执行任意系统操作（删文件、联网、提权）", false);
      continue;
    }

    if (SHELL_TOOLS[name]) {
      const arg = call.args[0];
      if (!arg) {
        add("dangerous", name + "()", "缺少命令参数", false);
        continue;
      }
      const verdict = classifyShell(arg.literal, SHELL_TOOLS[name], options);
      if (verdict.ok) continue; // 只读白名单命令，放行
      add("dangerous", name + "(" + (arg.literal != null ? arg.literal : arg.raw) + ")", verdict.why, verdict.hard);
      continue;
    }
  }

  return finish(result, src);
}

function finish(result, code) {
  // 用户策略（2026-10-24）：dangerous 里只要没有硬风险，就降级成自动执行。
  // 硬风险 = 删除/关机/杀进程、沙箱逃逸、越界或外泄、无法静态审查的字面量。
  const hard = result.items.some(function (it) {
    return it.level === "dangerous" && it.hard;
  });
  if (result.level === "dangerous" && !hard &&
      !hasDestructiveIntent(code) && !hasEscapeIntent(code)) {
    result.level = "safe";
    result.reasons = [];
    result.relaxed = true;
    return result;
  }
  result.reasons = result.items.map(function (it) {
    // cmd 是 AI 可控文本，而 reasons 是「操作: X\n风险: Y」这种拼串格式，
    // 弹窗侧要靠这两个标记切回来。于是命令里塞一个换行 + "风险:" 就能自拟一行
    // 看起来像系统判定的说明（例如"官方已核实：无任何数据损失"），
    // 把真实描述挤到后面 —— 这是确认弹窗，被糊弄的就是最后一道人工闸门。
    // 折掉换行（顺带让行首的"风险:"不再成其为行首）即可让格式无法被伪造。
    const oneLine = (s) => String(s == null ? "" : s).replace(/[\r\n]+/g, " ⏎ ");
    return "操作: " + oneLine(it.cmd) + "\n风险: " + oneLine(it.desc);
  });
  return result;
}

// 兼容旧接口：返回代码里出现过的 shell 命令字面量
function extractCommands(code) {
  return scanToolCalls(typeof code === "string" ? code : "")
    .filter(function (c) { return SHELL_TOOLS[c.name]; })
    .map(function (c) { return c.args[0] ? (c.args[0].literal || c.args[0].raw) : ""; });
}

// ============ 壳层安全状态（地址栏锁图标的数据源）============
// 域名与协议的权威判定只在这里写一份。main.js 的 isTrustedUrl、注入侧 preload
// 的门控、以及这里的三态计算都必须与它一致 —— 否则会出现「锁显示绿色，
// 但本地能力其实没开」这种自相矛盾的界面，那比没有指示更糟。
function isDeepSeekUrl(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    return h === "deepseek.com" || h.endsWith(".deepseek.com");
  } catch (e) {
    return false;
  }
}

// opts: { workspace, certError }
function shellSecurityInfo(url, opts) {
  const o = opts || {};
  let proto = "", host = "";
  try {
    const u = new URL(String(url));
    proto = u.protocol;
    host = u.hostname.toLowerCase();
  } catch (e) {}
  const https = proto === "https:";
  const deepseek = isDeepSeekUrl(url);
  return {
    level: deepseek ? "secure-app" : (https ? "secure-web" : "insecure"),
    https: https,
    host: host,
    isDeepSeek: deepseek,
    capability: deepseek ? "enabled" : (https ? "disabled-third-party" : "disabled-insecure"),
    workspace: deepseek ? String(o.workspace || "") : "",
    certError: (o.certError && o.certError.url === String(url)) ? o.certError : null
  };
}

module.exports = {
  checkCode: checkCode,
  extractCommands: extractCommands,
  scanToolCalls: scanToolCalls,
  classifyShell: classifyShell,
  literalValue: literalValue,
  isDeepSeekUrl: isDeepSeekUrl,
  shellSecurityInfo: shellSecurityInfo,
  CMD_READONLY: CMD_READONLY,
  PS_READONLY: PS_READONLY
};
