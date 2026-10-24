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
    if (/^[A-Za-z]:[\\/]/.test(cmd.slice(i, i + 3))) {
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
    return { ok: false, why: "命令不是字面量字符串（可能由变量拼接），无法静态审查" };
  }
  if (/[\r\n]/.test(cmd)) {
    return { ok: false, why: "命令包含换行，等价于多条命令串联" };
  }
  // shell 控制符 / 变量展开 / 命令分组 —— 任何一个都能改变命令的真实语义
  if (/[|&;<>`$(){}!]/.test(cmd)) {
    return { ok: false, why: "命令包含 shell 控制符或变量展开（| & ; < > ` $ ( ) { } !）" };
  }
  // UNC 路径会触发 SMB 认证，把本机 NTLM 凭据发给远端；URL 则可能外传数据
  if (/\\\\|\/\//.test(cmd)) {
    return { ok: false, why: "命令包含 UNC 路径或 URL，可能触发凭据外泄或网络请求" };
  }
  if (/(https?|ftp|file):/i.test(cmd)) {
    return { ok: false, why: "命令包含网络/文件协议地址" };
  }

  const token = firstToken(cmd);
  // 去掉路径与扩展名，只留可执行名
  const exe = token.exe.split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|com|bat|cmd|ps1)$/, "");
  const whitelist = flavor === "pwsh" ? PS_READONLY : CMD_READONLY;
  if (!exe) return { ok: false, why: "无法解析出命令名" };
  if (!whitelist.has(exe)) {
    return { ok: false, why: "`" + exe + "` 不在只读命令白名单内" };
  }

  const escape = pathEscapeReason(cmd, options && options.workspace);
  if (escape) return { ok: false, why: escape };

  return { ok: true, exe: exe };
}

// ============ 主入口 ============

function checkCode(code, options) {
  const result = { level: "safe", items: [] };

  function add(level, cmd, desc) {
    result.items.push({
      cmd: String(cmd == null ? "" : cmd).substring(0, 200),
      desc: desc,
      level: level
    });
    if (level === "forbidden") result.level = "forbidden";
    else if (level === "dangerous" && result.level !== "forbidden") result.level = "dangerous";
  }

  const src = typeof code === "string" ? code : "";
  if (!src.trim()) {
    result.level = "dangerous";
    add("dangerous", "(空)", "代码为空，无法判断意图");
    return finish(result);
  }

  // ---- 1. 绝对禁止：扫描去掉注释后的源码（字符串内容仍保留）----
  const scannable = stripComments(src);
  for (const f of FORBIDDEN) {
    if (f.p.test(scannable)) {
      add("forbidden", "(代码片段)", f.desc);
      return finish(result);
    }
  }

  // ---- 2. 沙箱逃逸原语 ----
  for (const e of ESCAPE_PRIMITIVES) {
    if (e.p.test(scannable)) add("dangerous", "(代码片段)", e.desc);
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
          return finish(result);
        }
      }
    }
  }

  if (calls.length === 0) {
    add("dangerous", "(代码片段)", "未识别到任何 cuckoo 工具调用，无法确认这段代码的意图");
  }

  for (const call of calls) {
    const name = call.name;

    if (READONLY_TOOLS.has(name)) continue;

    if (MUTATING_TOOLS.has(name)) {
      const target = call.args[0] ? (call.args[0].literal || call.args[0].raw) : "(未知路径)";
      add("dangerous", name + "(" + target + ")",
        name === "write" ? "写入/覆盖文件，会改变磁盘内容" : "修改文件内容，会改变磁盘内容");
      continue;
    }

    if (OPAQUE_TOOLS.has(name)) {
      add("dangerous", name + "(...)",
        "Python 代码无法静态审查，可以执行任意系统操作（删文件、联网、提权）");
      continue;
    }

    if (SHELL_TOOLS[name]) {
      const arg = call.args[0];
      if (!arg) {
        add("dangerous", name + "()", "缺少命令参数");
        continue;
      }
      const verdict = classifyShell(arg.literal, SHELL_TOOLS[name], options);
      if (verdict.ok) continue; // 只读白名单命令，放行
      add("dangerous", name + "(" + (arg.literal != null ? arg.literal : arg.raw) + ")", verdict.why);
      continue;
    }
  }

  return finish(result);
}

function finish(result) {
  result.reasons = result.items.map(function (it) {
    return "操作: " + it.cmd + "\n风险: " + it.desc;
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
