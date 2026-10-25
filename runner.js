// cuckoo 代码执行器
//
// 提供 bash/pwsh/python/read/write/edit/glob/grep 等工具函数。
// 这个模块只在 utilityProcess 子进程里被加载（见 runner-worker.js），
// 不要从 Electron 主进程直接 require —— 否则沙箱逃逸就等于主进程 RCE。

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const os = require("os");
const { spawn } = require("child_process");
const iconv = require("iconv-lite");

// 文件大小上限（字节）。执行器跑在子进程里，但读进来的东西最终要回传给 AI，
// 不设限的话一个大文件就能吃满内存并撑爆消息通道。
const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_GREP_FILE_BYTES = 1 * 1024 * 1024;
const MAX_WRITE_BYTES = 10 * 1024 * 1024;
// shell 输出与最终返回值的上限：结果要经 worker → 主进程 → 渲染进程再回传云端，
// 不设限等于让一条命令决定内存占用和消息体积。
const MAX_SHELL_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_RESULT_CHARS = 200 * 1024;

// 单次执行的墙钟上限。vm.runInContext 的 timeout 只管同步代码，
// await bash(...) 这类异步操作必须靠这个看门狗兜住。
const DEFAULT_DEADLINE_MS = 120000;

// 当前执行期间所有活着的子进程，超时时要整棵树杀掉
const liveProcs = new Set();

function killTree(proc) {
  if (!proc || proc.killed) return;
  try { proc.kill(); } catch (e) {}
  // Windows 上 proc.kill() 只终止直接子进程（cmd.exe / powershell.exe），
  // 它派生的孙子进程会变成孤儿常驻。必须用 taskkill /T 杀整棵树。
  if (process.platform === "win32" && proc.pid) {
    try {
      const killer = spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true });
      killer.on("error", function () {});
      killer.unref();
    } catch (e) {}
  }
}

function killAllLiveProcs() {
  for (const p of Array.from(liveProcs)) killTree(p);
  liveProcs.clear();
}

// 统一的子进程登记：spawn 之后立刻注册，close/error 之后注销
function track(proc) {
  liveProcs.add(proc);
  const untrack = function () { liveProcs.delete(proc); };
  proc.once("close", untrack);
  proc.once("error", untrack);
  return proc;
}

// 把选项里的 cwd/workdir、timeout/timeoutMs 统一起来。
// SYSTEM_PROMPT.md 告诉 AI 用 workdir/timeoutMs，旧代码读的是 cwd/timeout，
// 两套都接受，免得 AI 按文档写的参数被静默忽略。
function pickCwd(opts, fallback) {
  const v = opts && (opts.cwd || opts.workdir);
  return typeof v === "string" && v.trim() ? v : fallback;
}
function pickTimeout(opts, fallback) {
  const v = opts && (opts.timeout || opts.timeoutMs);
  if (typeof v !== "number" || !(v > 0)) return fallback;
  // AI 可以传任意大数（1e12 就是约 31 年），单层定时器会形同虚设。
  // 主进程那边还有 120s 总看门狗，这里把单次超时同样钉到 120s 以内。
  return Math.min(v, 120000);
}

// 执行 shell 命令
function execShell(command, opts) {
  opts = opts || {};
  return new Promise(function (resolve) {
    const cwd = opts.cwd;
    const timeout = opts.timeout;
    const isPwsh = opts.shell === "pwsh";

    const shell = isPwsh
      ? "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
      : "C:\\Windows\\System32\\cmd.exe";

    // 编码策略：
    // - cmd：用 GBK 解码（中文 Windows 默认 CP936）；不切 chcp（保持系统默认）
    // - pwsh：先强制 UTF-8 输出，再用 UTF-8 解码
    let finalCmd;
    let decoder;
    if (isPwsh) {
      finalCmd = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; " + command;
      decoder = "utf8";
    } else {
      finalCmd = command;
      decoder = "gbk";
    }

    const args = isPwsh
      ? ["-NoProfile", "-Command", finalCmd]
      : ["/d", "/s", "/c", finalCmd];

    let proc;
    try {
      proc = track(spawn(shell, args, { cwd: cwd, windowsHide: true }));
    } catch (e) {
      resolve({ output: "[error] 无法启动 shell: " + e.message, code: -1 });
      return;
    }

    const outBufs = [];
    const errBufs = [];
    let finished = false;
    // 不设上限的话，一条 `type 大文件` 或刷屏命令能把整个输出堆进 worker 内存，
    // 撑爆之后连累队列里其它任务。到量就停止累积，只留截断标记。
    let outLen = 0, errLen = 0, truncated = false;

    proc.stdout.on("data", function (d) {
      if (outLen >= MAX_SHELL_OUTPUT_BYTES) { truncated = true; return; }
      outBufs.push(d);
      outLen += d.length;
    });
    proc.stderr.on("data", function (d) {
      if (errLen >= MAX_SHELL_OUTPUT_BYTES) { truncated = true; return; }
      errBufs.push(d);
      errLen += d.length;
    });

    function collect(extra) {
      const out = iconv.decode(Buffer.concat(outBufs), decoder);
      const err = iconv.decode(Buffer.concat(errBufs), decoder);
      let text = out;
      if (err) text += (text ? "\n[stderr]\n" : "[stderr]\n") + err;
      if (truncated) text += "\n[输出超过 " + Math.round(MAX_SHELL_OUTPUT_BYTES / 1024 / 1024) + "MB，后续已截断]";
      return text + (extra || "");
    }

    const timer = setTimeout(function () {
      if (finished) return;
      finished = true;
      killTree(proc);
      resolve({ output: collect("\n[timed out]"), code: -1 });
    }, timeout + 1000);

    proc.on("close", function (code) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ output: collect(code !== 0 ? "\n[exit code: " + code + "]" : ""), code: code });
    });

    proc.on("error", function (err) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ output: "[error] " + err.message, code: -1 });
    });
  });
}

// 检测 Python 可执行文件路径（缓存），返回完整路径
let __pythonPath;
let __pythonProbe = null;

// 注意：这里必须用异步探测。旧实现用 spawnSync，三个候选命令各 3 秒超时，
// 最坏情况把进程卡死 9 秒 —— 放在主进程时整个界面都会失去响应。
function findPython() {
  if (__pythonPath !== undefined) return Promise.resolve(__pythonPath);
  if (__pythonProbe) return __pythonProbe;

  const candidates = ["python", "python3", "py"];

  function tryWhere(name) {
    return new Promise(function (resolve) {
      let proc;
      try {
        proc = spawn("where", [name], { windowsHide: true });
      } catch (e) { resolve(null); return; }
      let out = "";
      const t = setTimeout(function () { killTree(proc); resolve(null); }, 3000);
      proc.stdout.on("data", function (d) { out += d.toString("utf8"); });
      proc.on("error", function () { clearTimeout(t); resolve(null); });
      proc.on("close", function (code) {
        clearTimeout(t);
        if (code !== 0 || !out) { resolve(null); return; }
        const lines = out.split(/\r?\n/);
        for (const line of lines) {
          const exe = line.trim();
          // 跳过 Microsoft Store 的假别名（WindowsApps 下的 python.exe 只会弹商店）
          if (exe && exe.indexOf("WindowsApps") === -1 && /\.exe$/i.test(exe)) {
            resolve(exe);
            return;
          }
        }
        resolve(null);
      });
    });
  }

  function tryVersion(name) {
    return new Promise(function (resolve) {
      let proc;
      try {
        proc = spawn(name, ["--version"], { windowsHide: true });
      } catch (e) { resolve(false); return; }
      const t = setTimeout(function () { killTree(proc); resolve(false); }, 3000);
      proc.on("error", function () { clearTimeout(t); resolve(false); });
      proc.on("close", function (code) { clearTimeout(t); resolve(code === 0); });
    });
  }

  __pythonProbe = (async function () {
    for (const name of candidates) {
      const exe = await tryWhere(name);
      if (exe) { __pythonPath = exe; return exe; }
    }
    for (const name of candidates) {
      if (await tryVersion(name)) { __pythonPath = name; return name; }
    }
    __pythonPath = null;
    return null;
  })();

  return __pythonProbe;
}

// 创建工具函数集
function createTools(options) {
  options = options || {};

  // ★ 必须显式选择工作区。
  // 旧实现默认用 os.homedir()，等于把整个用户主目录开放给 AI 读写：
  // write("AppData/.../Startup/x.bat", ...) 就能装一个开机自启后门，
  // 而路径检查还会认为它完全合法。
  const cwdBase = (typeof options.workspace === "string" && options.workspace.trim())
    ? path.resolve(options.workspace.trim())
    : null;

  const logFn = function () {
    if (options.onLog) {
      options.onLog(Array.prototype.slice.call(arguments).map(function (a) {
        if (typeof a === "string") return a;
        try { return JSON.stringify(a); } catch (e) { return String(a); }
      }).join(" "));
    }
  };

  function needWorkspace() {
    if (!cwdBase) {
      throw new Error(
        "未设置工作区，文件与命令工具已禁用。" +
        "请告诉用户：点击窗口左上角的文件夹图标选择项目目录，然后重新发送任务。"
      );
    }
  }

  // 安全路径检查：确保路径解析后仍然在工作区内
  function safePath(p) {
    needWorkspace();
    if (typeof p !== "string" || !p.trim()) throw new Error("路径不能为空");

    const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(cwdBase, p);

    // 用 realpath 解析符号链接与 junction。
    // path.normalize 只看字面量，旧实现下 `mklink /J link C:\Windows` 之后
    // write("link/system32/x", ...) 就能逃出工作区。
    // 目标本身常常还不存在（write 新文件），这时要退到最近一个**存在**的祖先做
    // realpath 再拼回剩余段：只对"整体存在"的路径取 realpath，等于把新文件这条
    // 最常被用的写入路径完全放过了。
    const realBase = fs.realpathSync.native(cwdBase);
    const realTarget = realpathWithMissing(abs);

    if (realTarget !== realBase && !realTarget.startsWith(realBase + path.sep)) {
      throw new Error("安全限制：禁止访问工作区之外的路径（" + realTarget + "）");
    }
    return realTarget;
  }

  function realpathWithMissing(p) {
    const missing = [];
    let cur = p;
    while (!fs.existsSync(cur)) {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      missing.unshift(path.basename(cur));
      cur = parent;
    }
    let real;
    try { real = fs.realpathSync.native(cur); } catch (e) { return p; }
    return missing.length ? path.join(real, ...missing) : real;
  }

  function assertReadableSize(abs, limit) {
    const st = fs.statSync(abs);
    if (st.size > limit) {
      throw new Error("文件过大（" + (st.size / 1024 / 1024).toFixed(1) + " MB），超过 " +
        (limit / 1024 / 1024) + " MB 上限，拒绝读取");
    }
    return st;
  }

  return {
    log: logFn,

    sleep: async function (ms) {
      const wait = Math.min(Math.max(Number(ms) || 0, 0), 30000);
      await new Promise(function (r) { setTimeout(r, wait); });
      return "";
    },

    bash: async function (command, opts) {
      needWorkspace();
      if (typeof command !== "string" || !command.trim()) throw new Error("bash() 需要一个非空命令字符串");
      const r = await execShell(command, {
        cwd: safePath(pickCwd(opts, ".")),
        timeout: pickTimeout(opts, 30000),
        shell: "cmd"
      });
      return r.output;
    },

    pwsh: async function (command, opts) {
      needWorkspace();
      if (typeof command !== "string" || !command.trim()) throw new Error("pwsh() 需要一个非空命令字符串");
      const r = await execShell(command, {
        cwd: safePath(pickCwd(opts, ".")),
        timeout: pickTimeout(opts, 30000),
        shell: "pwsh"
      });
      return r.output;
    },

    read: async function (filePath, opts) {
      opts = opts || {};
      const abs = safePath(filePath);
      assertReadableSize(abs, MAX_READ_BYTES);
      const content = fs.readFileSync(abs, "utf-8");
      const lines = content.split("\n");
      const offset = Math.max(1, Number(opts.offset) || 1);
      const limit = Math.min(Math.max(Number(opts.limit) || 2000, 1), 20000);
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      const numbered = slice.map(function (l, i) { return (offset + i) + ": " + l; }).join("\n");
      return "<path>" + filePath + "</path>\n<content>\n" + numbered + "\n</content>";
    },

    write: async function (filePath, content) {
      const abs = safePath(filePath);
      const text = typeof content === "string" ? content : String(content);
      if (Buffer.byteLength(text, "utf8") > MAX_WRITE_BYTES) {
        throw new Error("写入内容超过 " + (MAX_WRITE_BYTES / 1024 / 1024) + " MB 上限");
      }
      const dir = path.dirname(abs);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // 先写临时文件再 rename，避免写一半崩溃留下损坏文件
      const tmp = abs + ".cuckoo-tmp";
      fs.writeFileSync(tmp, text, "utf-8");
      fs.renameSync(tmp, abs);
      return "<path>" + filePath + "</path>\n<content>Created/Updated file</content>";
    },

    edit: async function (filePath, oldString, newString, replaceAll) {
      const abs = safePath(filePath);
      if (typeof oldString !== "string" || oldString === "") throw new Error("oldString 不能为空");
      assertReadableSize(abs, MAX_READ_BYTES);
      let content = fs.readFileSync(abs, "utf-8");
      if (content.indexOf(oldString) === -1) throw new Error("oldString 未找到");
      const news = typeof newString === "string" ? newString : String(newString);
      if (replaceAll) {
        content = content.split(oldString).join(news);
      } else {
        const count = content.split(oldString).length - 1;
        if (count > 1) throw new Error("匹配 " + count + " 处，需 replaceAll");
        // ★ 必须用函数形式的 replace。
        // String.replace(str, str) 会解释 newString 里的 $& / $' / $` / $1，
        // 旧实现下 AI 写入含 "$&" 的内容会被静默替换成匹配文本，把文件改坏且不报错。
        content = content.replace(oldString, function () { return news; });
      }
      const tmp = abs + ".cuckoo-tmp";
      fs.writeFileSync(tmp, content, "utf-8");
      fs.renameSync(tmp, abs);
      return "Updated file: " + filePath;
    },

    glob: async function (pattern, searchPath) {
      const base = searchPath ? safePath(searchPath) : (needWorkspace(), cwdBase);
      if (typeof pattern !== "string" || !pattern) throw new Error("glob() 需要一个模式字符串");

      const regex = globToRegExp(pattern);
      const results = [];
      let truncated = false;

      function walk(dir, depth) {
        if (depth > 10) return;
        if (results.length >= 500) { truncated = true; return; }
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const e of entries) {
          if (results.length >= 500) { truncated = true; return; }
          if (e.name === "node_modules" || e.name === ".git") continue;
          // 遍历不跟随符号链接：readdir 的Dirent 对链接既不是 isDirectory() 也不是
          // isFile()，旧代码把它当普通文件 statSync+readFileSync，于是工作区里放一个
          // 指向 C:\Users\me 的链接，glob/grep 就会把外面的内容读出来并随结果回传。
          if (e.isSymbolicLink()) continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            walk(full, depth + 1);
          } else {
            const rel = path.relative(base, full).replace(/\\/g, "/");
            if (regex.test(rel) || regex.test(e.name)) results.push(rel);
          }
        }
      }
      walk(base, 0);
      const shown = results.slice(0, 200);
      let text = shown.join("\n");
      text += "\n(Found " + results.length + " files";
      if (results.length > shown.length) text += ", showing first " + shown.length;
      if (truncated) text += ", search truncated at 500";
      return text + ")";
    },

    grep: async function (pattern, opts) {
      opts = opts || {};
      const base = opts.path ? safePath(opts.path) : (needWorkspace(), cwdBase);
      if (typeof pattern !== "string" || !pattern) throw new Error("grep() 需要一个模式字符串");

      let re;
      try {
        re = new RegExp(pattern);
      } catch (e) {
        throw new Error("正则表达式无效: " + e.message);
      }

      const include = typeof opts.include === "string" && opts.include ? opts.include : "*";
      const includeRe = globToRegExp(include, true);
      const results = [];
      let truncated = false;

      function walk(dir, depth) {
        if (depth > 8) return;
        if (results.length >= 100) { truncated = true; return; }
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const e of entries) {
          if (results.length >= 100) { truncated = true; return; }
          if (e.name === "node_modules" || e.name === ".git") continue;
          // 遍历不跟随符号链接：readdir 的Dirent 对链接既不是 isDirectory() 也不是
          // isFile()，旧代码把它当普通文件 statSync+readFileSync，于是工作区里放一个
          // 指向 C:\Users\me 的链接，glob/grep 就会把外面的内容读出来并随结果回传。
          if (e.isSymbolicLink()) continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) { walk(full, depth + 1); continue; }
          if (!includeRe.test(e.name)) continue;
          try {
            const st = fs.statSync(full);
            if (st.size > MAX_GREP_FILE_BYTES) continue;
            const content = fs.readFileSync(full, "utf-8");
            const lines = content.split("\n");
            for (let j = 0; j < lines.length && results.length < 100; j++) {
              re.lastIndex = 0;
              if (re.test(lines[j])) {
                const rel = path.relative(base, full).replace(/\\/g, "/");
                results.push(rel + ":" + (j + 1) + ": " + lines[j].substring(0, 200));
              }
            }
          } catch (err) { /* 二进制或无权限，跳过 */ }
        }
      }
      walk(base, 0);
      if (results.length === 0) return "No matches found";
      return "Found " + results.length + " matches" + (truncated ? " (search truncated)" : "") + ":\n" + results.join("\n");
    },

    // Python 执行器：把代码写到临时文件后调用 python 运行
    python: async function (code, opts) {
      needWorkspace();
      if (typeof code !== "string" || !code.trim()) throw new Error("python() 需要一段非空代码");

      const pythonCmd = await findPython();
      if (!pythonCmd) {
        throw new Error("未检测到 Python，请先安装 Python 3（https://www.python.org/downloads/）");
      }

      const cwd = safePath(pickCwd(opts, "."));
      const timeout = pickTimeout(opts, 60000);

      // 临时文件放在系统临时目录，用 pid + 随机后缀避免并发碰撞
      const tmpFile = path.join(
        os.tmpdir(),
        "cuckoo_py_" + process.pid + "_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8) + ".py"
      );
      fs.writeFileSync(tmpFile, code, "utf-8");

      return new Promise(function (resolve) {
        const env = Object.assign({}, process.env, {
          PYTHONIOENCODING: "utf-8",
          PYTHONUTF8: "1"
        });

        let proc;
        try {
          // 直接 spawn python.exe，不走 cmd，避免引号问题
          proc = track(spawn(pythonCmd, ["-X", "utf8", tmpFile], { cwd: cwd, windowsHide: true, env: env }));
        } catch (e) {
          try { fs.unlinkSync(tmpFile); } catch (e2) {}
          resolve("[error] " + e.message);
          return;
        }

        const outBufs = [];
        const errBufs = [];
        // python 分支原先无上限累积：print('x'*10**9) 会把 worker 撑到 OOM，
        // 触发 uncaughtException 复位后连带整条串行队列上的其它任务一起失败。
        // bash 分支早就有 4MB 帽，这里对齐。
        let pyOutBytes = 0, pyErrBytes = 0, pyTruncated = false;
        let finished = false;

        proc.stdout.on("data", function (d) {
          if (pyOutBytes >= MAX_SHELL_OUTPUT_BYTES) { pyTruncated = true; return; }
          pyOutBytes += d.length;
          outBufs.push(d);
        });
        proc.stderr.on("data", function (d) {
          if (pyErrBytes >= MAX_SHELL_OUTPUT_BYTES) { pyTruncated = true; return; }
          pyErrBytes += d.length;
          errBufs.push(d);
        });

        function collect(extra) {
          const out = iconv.decode(Buffer.concat(outBufs), "utf-8");
          const err = iconv.decode(Buffer.concat(errBufs), "utf-8");
          let text = out;
          if (err) text += (text ? "\n[stderr]\n" : "[stderr]\n") + err;
          if (pyTruncated) {
            text += "\n...(输出超过 " + Math.round(MAX_SHELL_OUTPUT_BYTES / 1024 / 1024) +
              "MB 上限，后续内容已丢弃)";
          }
          return text + (extra || "");
        }

        function cleanup() {
          try { fs.unlinkSync(tmpFile); } catch (e) {}
        }

        const timer = setTimeout(function () {
          if (finished) return;
          finished = true;
          killTree(proc);
          cleanup();
          resolve(collect("\n[timed out]"));
        }, timeout + 1000);

        proc.on("close", function (exitCode) {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          cleanup();
          resolve(collect(exitCode !== 0 ? "\n[exit code: " + exitCode + "]" : ""));
        });

        proc.on("error", function (err) {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          cleanup();
          resolve("[error] " + err.message);
        });
      });
    }
  };
}

// glob 模式 → 正则
// nameOnly=true 时 "*" 允许跨越路径分隔符（grep 的 include 只匹配文件名）
function globToRegExp(pattern, nameOnly) {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern.charAt(i);
    if (c === "*") {
      if (pattern.charAt(i + 1) === "*") {
        out += ".*";
        i++;
        if (pattern.charAt(i + 1) === "/") i++;
      } else {
        out += nameOnly ? ".*" : "[^/\\\\]*";
      }
    } else if (c === "?") {
      out += nameOnly ? "." : "[^/\\\\]";
    } else if ("\\.+^$()|{}[]".indexOf(c) !== -1) {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  return new RegExp("^" + out + "$", "i");
}

// ============ 沙箱构造 ============
//
// vm 不是安全边界（Node 官方文档明确这么说），真正兜底的是 utilityProcess 隔离。
// 但把明显的逃逸通道堵掉仍然值得：只要沙箱里能摸到任何一个宿主对象，
// 就能顺着 .constructor 拿回宿主 Function，进而 require("child_process")，
// 把 security.js 的白名单整个绕过去。
//
// 做法：
//   1. 不往 context 里塞任何宿主内建对象（Array/Object/Promise/JSON...）。
//      vm.createContext 会给新 realm 自己的一套，沙箱代码用到的是沙箱自己的。
//   2. 注入的工具函数一律 Object.setPrototypeOf(fn, null)，隐藏 .constructor。
//   3. 工具返回的 Promise 用沙箱 realm 的 Promise 重新包一层，
//      宿主 Promise 对象绝不进入沙箱。
//   4. 错误也在沙箱 realm 里重建，宿主 Error 不跨境界。
//   5. 所有工具返回值强制转成字符串，不返回宿主对象。
function createSandbox(tools) {
  const context = vm.createContext(Object.create(null));

  const bridge = vm.runInContext(
    "(function () {\n" +
    "  function deferred() {\n" +
    "    var d = {};\n" +
    "    d.promise = new Promise(function (res, rej) { d.resolve = res; d.reject = rej; });\n" +
    "    return d;\n" +
    "  }\n" +
    "  function makeError(msg) { return new Error(String(msg)); }\n" +
    "  return { deferred: deferred, makeError: makeError };\n" +
    "})()",
    context
  );

  const g = vm.runInContext("this", context);

  function wrap(name, hostFn) {
    const wrapper = function () {
      const args = Array.prototype.slice.call(arguments);
      const d = bridge.deferred();
      Promise.resolve()
        .then(function () { return hostFn.apply(null, args); })
        .then(
          function (value) {
            // 只允许原始值跨界，宿主对象一律转字符串
            const t = typeof value;
            d.resolve(t === "string" || value == null || t === "number" || t === "boolean"
              ? (value == null ? "" : (t === "string" ? value : String(value)))
              : String(value));
          },
          function (err) {
            d.reject(bridge.makeError((err && err.message) || String(err)));
          }
        );
      return d.promise;
    };
    // 关键一步：抹掉原型链，让 wrapper.constructor 变成 undefined
    Object.setPrototypeOf(wrapper, null);
    Object.defineProperty(wrapper, "name", { value: name, configurable: true });
    g[name] = wrapper;
  }

  for (const name of Object.keys(tools)) wrap(name, tools[name]);

  // console 也在沙箱 realm 里造，避免把宿主对象字面量塞进去
  vm.runInContext(
    "this.console = { log: this.log, info: this.log, warn: this.log, error: this.log, debug: this.log };",
    context
  );

  return context;
}

// 执行 cuckoo 代码
async function runCuckooCode(code, options) {
  options = options || {};

  const logs = [];
  const tools = createTools({
    workspace: options.workspace,
    onLog: function (msg) {
      logs.push(msg);
      if (options.onLog) options.onLog(msg);
    }
  });

  let jsCode = typeof code === "string" ? code : String(code);
  const fence = jsCode.match(/```cuckoo([\s\S]*?)```/i);
  if (fence) jsCode = fence[1];

  const wrapped = "(async () => {\n" + jsCode + "\n})()";
  const deadline = options.deadline || DEFAULT_DEADLINE_MS;

  const context = createSandbox(tools);

  // 看门狗：vm 的 timeout 只约束同步执行，异步工具调用要靠这个
  let timedOut = false;
  const watchdog = setTimeout(function () {
    timedOut = true;
    killAllLiveProcs();
  }, deadline);

  try {
    const value = await vm.runInContext(wrapped, context, { timeout: deadline, displayErrors: true });
    if (timedOut) {
      return { ok: false, error: "执行超时（超过 " + Math.round(deadline / 1000) + " 秒），已终止所有子进程", logs: logs };
    }
    return { ok: true, result: normalizeResult(value), logs: logs };
  } catch (e) {
    if (timedOut) {
      return { ok: false, error: "执行超时（超过 " + Math.round(deadline / 1000) + " 秒），已终止所有子进程", logs: logs };
    }
    killAllLiveProcs();

    const stack = (e && e.stack) || "";
    let line = 0, column = 0;
    const m = stack.match(/<anonymous>:(\d+):(\d+)/);
    if (m) {
      // wrapped 在最前面插了一行 "(async () => {"，所以行号减 1
      line = Math.max(1, parseInt(m[1], 10) - 1);
      column = parseInt(m[2], 10);
    }

    return {
      ok: false,
      error: (e && e.message) || String(e),
      errorType: (e && e.name) || "Error",
      errorLine: line,
      errorColumn: column,
      errorStack: stack.substring(0, 4000),
      rawCode: jsCode,
      logs: logs
    };
  } finally {
    clearTimeout(watchdog);
    killAllLiveProcs();
  }
}

// 结果必须是可跨进程结构化克隆的原始值
function normalizeResult(value) {
  if (value == null) return "";
  let text;
  if (typeof value === "string") text = value;
  else if (typeof value === "number" || typeof value === "boolean") text = String(value);
  else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch (e) {
      text = String(value);
    }
  }
  if (text && text.length > MAX_RESULT_CHARS) {
    text = text.substring(0, MAX_RESULT_CHARS) +
      "\n...(返回值超过 " + Math.round(MAX_RESULT_CHARS / 1024) + "KB，已截断)";
  }
  return text;
}

module.exports = {
  runCuckooCode: runCuckooCode,
  execShell: execShell,
  killAllLiveProcs: killAllLiveProcs,
  createTools: createTools,
  globToRegExp: globToRegExp,
  MAX_SHELL_OUTPUT_BYTES: MAX_SHELL_OUTPUT_BYTES,
  MAX_RESULT_CHARS: MAX_RESULT_CHARS
};
