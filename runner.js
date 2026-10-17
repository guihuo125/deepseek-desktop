// cuckoo 代码沙箱执行器
// 提供 bash/pwsh/read/write/edit/glob/grep 等工具函数

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const os = require("os");
const { spawn } = require("child_process");
const iconv = require("iconv-lite");

// 默认工作目录（用户的主目录）
const DEFAULT_CWD = os.homedir();

// 执行 shell 命令
function execShell(command, opts) {
  opts = opts || {};
  return new Promise(function(resolve) {
    var cwd = opts.cwd || DEFAULT_CWD;
    var timeout = opts.timeout || 30000;
    var isPwsh = opts.shell === "pwsh";

    var shell = isPwsh
      ? "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
      : "C:\\Windows\\System32\\cmd.exe";

    // 编码策略：
    // - cmd：用 GBK 解码（中文 Windows 默认 CP936）；不切 chcp（保持系统默认）
    // - pwsh：先强制 UTF-8 输出，再用 UTF-8 解码
    var finalCmd;
    var decoder = "gbk";
    if (isPwsh) {
      finalCmd = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; " + command;
      decoder = "utf8";
    } else {
      finalCmd = command;
      decoder = "gbk";
    }

    var args = isPwsh
      ? ["-NoProfile", "-Command", finalCmd]
      : ["/d", "/s", "/c", finalCmd];

    var proc = spawn(shell, args, { cwd: cwd, windowsHide: true });
    var stdout = "";
    var stderr = "";
    var finished = false;
    var outBufs = [];
    var errBufs = [];

    proc.stdout.on("data", function(d) {
      // cmd /u 输出是 UTF-16 LE，先累积后统一解码
      outBufs.push(d);
    });
    proc.stderr.on("data", function(d) {
      errBufs.push(d);
    });

    var timer = setTimeout(function() {
      if (finished) return;
      finished = true;
      try { proc.kill(); } catch (e) {}
      var finalOut = iconv.decode(Buffer.concat(outBufs), decoder);
      var finalErr = iconv.decode(Buffer.concat(errBufs), decoder);
      var result = finalOut + (finalErr ? "\n[stderr]\n" + finalErr : "") + "\n[timed out]";
      resolve({ output: result, code: -1 });
    }, timeout + 1000);

    proc.on("close", function(code) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      var finalStdout = iconv.decode(Buffer.concat(outBufs), decoder);
      var finalStderr = iconv.decode(Buffer.concat(errBufs), decoder);

      var result = finalStdout;
      if (finalStderr) result += (result ? "\n[stderr]\n" : "[stderr]\n") + finalStderr;
      if (code !== 0) result += "\n[exit code: " + code + "]";
      resolve({ output: result, code: code });
    });

    proc.on("error", function(err) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ output: "[error] " + err.message, code: -1 });
    });
  });
}

// 检测 Python 可执行文件路径（缓存），返回完整路径
var __pythonPath = undefined;
function findPython() {
  if (__pythonPath !== undefined) return __pythonPath;
  var { spawnSync } = require("child_process");
  var candidates = ["python", "python3", "py"];
  // 1. 用 where 拿完整路径（跳过 WindowsApps 的假别名）
  for (var i = 0; i < candidates.length; i++) {
    try {
      var r = spawnSync("where", [candidates[i]], { encoding: "utf-8", timeout: 3000 });
      if (r.status === 0 && r.stdout) {
        var lines = r.stdout.split(/\r?\n/);
        for (var k = 0; k < lines.length; k++) {
          var exe = lines[k].trim();
          if (exe && exe.indexOf("WindowsApps") === -1 && /\.exe$/i.test(exe)) {
            __pythonPath = exe;
            return __pythonPath;
          }
        }
      }
    } catch (e) {}
  }
  // 2. 回退：spawnSync 检测命令可用性
  for (var j = 0; j < candidates.length; j++) {
    try {
      var r2 = spawnSync(candidates[j], ["--version"], { encoding: "utf-8", timeout: 3000 });
      if (r2.status === 0) {
        __pythonPath = candidates[j];
        return __pythonPath;
      }
    } catch (e) {}
  }
  __pythonPath = null;
  return null;
}

// 创建工具函数集
function createTools(options) {
  options = options || {};
  // 优先使用用户选择的工作区
  var cwdBase = options.workspace && options.workspace.trim() !== "" ? options.workspace : DEFAULT_CWD;
  var logFn = function() {
    if (options.onLog) options.onLog(Array.prototype.slice.call(arguments).map(String).join(" "));
  };

  // 安全路径检查：确保路径解析后仍然在工作区内
  function safePath(p) {
    if (!p) throw new Error("路径不能为空");
    var abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(cwdBase, p);
    var base = path.normalize(cwdBase);
    // 确保绝对的 base 下
    if (abs === base) return abs;
    if (!abs.startsWith(base + path.sep)) {
      throw new Error("安全限制：禁止访问工作区之外的路径（" + abs + "）");
    }
    return abs;
  }

  return {
    log: logFn,

    bash: async function(command, opts) {
      opts = Object.assign({}, opts);
      if (!opts.cwd) opts.cwd = cwdBase;
      var r = await execShell(command, Object.assign({}, opts, { shell: "bash" }));
      return r.output;
    },

    pwsh: async function(command, opts) {
      opts = Object.assign({}, opts);
      if (!opts.cwd) opts.cwd = cwdBase;
      var r = await execShell(command, Object.assign({}, opts, { shell: "pwsh" }));
      return r.output;
    },

    read: async function(filePath, opts) {
      opts = opts || {};
      var abs = safePath(filePath);
      var content = fs.readFileSync(abs, "utf-8");
      var lines = content.split("\n");
      var offset = opts.offset || 1;
      var limit = opts.limit || 2000;
      var slice = lines.slice(offset - 1, offset - 1 + limit);
      var numbered = slice.map(function(l, i) { return (offset + i) + ": " + l; }).join("\n");
      return "<path>" + filePath + "</path>\n<content>\n" + numbered + "\n</content>";
    },

    write: async function(filePath, content) {
      var abs = safePath(filePath);
      var dir = path.dirname(abs);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(abs, content, "utf-8");
      return "<path>" + filePath + "</path>\n<content>Created/Updated file</content>";
    },

    edit: async function(filePath, oldString, newString, replaceAll) {
      var abs = safePath(filePath);
      var content = fs.readFileSync(abs, "utf-8");
      if (content.indexOf(oldString) === -1) throw new Error("oldString 未找到");
      if (replaceAll) {
        content = content.split(oldString).join(newString);
      } else {
        var count = content.split(oldString).length - 1;
        if (count > 1) throw new Error("匹配 " + count + " 处，需 replaceAll");
        content = content.replace(oldString, newString);
      }
      fs.writeFileSync(abs, content, "utf-8");
      return "Updated file: " + filePath;
    },

    glob: async function(pattern, searchPath) {
      var base = searchPath ? safePath(searchPath) : cwdBase;
      var regex = new RegExp("^" + pattern.replace(/\\*\\*/g, ".*").replace(/\\*/g, "[^/\\\\]*").replace(/\\?/g, ".") + "$");
      var results = [];
      function walk(dir, depth) {
        if (depth > 10 || results.length > 500) return;
        try {
          var entries = fs.readdirSync(dir, { withFileTypes: true });
          for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            if (e.name === "node_modules" || e.name === ".git") continue;
            var full = path.join(dir, e.name);
            var rel = path.relative(base, full).replace(/\\\\/g, "/");
            if (e.isDirectory()) {
              walk(full, depth + 1);
            } else if (regex.test(rel) || regex.test(e.name)) {
              results.push(rel);
            }
          }
        } catch (err) {}
      }
      walk(base, 0);
      return results.slice(0, 200).join("\n") + "\n(Found " + results.length + " files)";
    },

    grep: async function(pattern, opts) {
      opts = opts || {};
      var base = opts.path ? safePath(opts.path) : cwdBase;
      var re = new RegExp(pattern);
      var include = opts.include || "*";
      var includeRe = new RegExp("^" + include.replace(/\\*/g, ".*").replace(/\\./g, "\\\\.") + "$");
      var results = [];
      function walk(dir, depth) {
        if (depth > 8 || results.length > 100) return;
        try {
          var entries = fs.readdirSync(dir, { withFileTypes: true });
          for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            if (e.name === "node_modules" || e.name === ".git") continue;
            var full = path.join(dir, e.name);
            if (e.isDirectory()) {
              walk(full, depth + 1);
            } else if (includeRe.test(e.name)) {
              try {
                var content = fs.readFileSync(full, "utf-8");
                var lines = content.split("\n");
                for (var j = 0; j < lines.length && results.length < 100; j++) {
                  if (re.test(lines[j])) {
                    var rel = path.relative(base, full).replace(/\\\\/g, "/");
                    results.push(rel + ":" + (j + 1) + ": " + lines[j].substring(0, 200));
                  }
                }
              } catch (err) {}
            }
          }
        } catch (err) {}
      }
      walk(base, 0);
      return results.length > 0 ? "Found " + results.length + " matches:\n" + results.join("\n") : "No matches found";
    },

    // ★ Python 执行器：把代码写到临时文件后调用 python 运行
    python: async function(code, opts) {
      opts = opts || {};
      var pythonCmd = findPython();
      if (!pythonCmd) {
        throw new Error("未检测到 Python，请先安装 Python 3（https://www.python.org/downloads/）");
      }

      // 写临时文件（UTF-8 无 BOM）
      var tmpDir = os.tmpdir();
      var tmpFile = path.join(tmpDir, "adshield_py_" + Date.now() + "_" + Math.random().toString(36).substring(2, 8) + ".py");
      fs.writeFileSync(tmpFile, code, "utf-8");

      return new Promise(function(resolve) {
        var cwd = opts.cwd || DEFAULT_CWD;
        var timeout = opts.timeout || 60000;
        var env = Object.assign({}, process.env, {
          PYTHONIOENCODING: "utf-8",
          PYTHONUTF8: "1"
        });
        // 直接 spawn python.exe，不走 cmd，避免引号问题
        var proc = spawn(pythonCmd, ["-X", "utf8", tmpFile], { cwd: cwd, windowsHide: true, env: env });
        var outBufs = [];
        var errBufs = [];
        var finished = false;

        proc.stdout.on("data", function(d) { outBufs.push(d); });
        proc.stderr.on("data", function(d) { errBufs.push(d); });

        var timer = setTimeout(function() {
          if (finished) return;
          finished = true;
          try { proc.kill(); } catch (e) {}
          try { fs.unlinkSync(tmpFile); } catch (e) {}
          var out = iconv.decode(Buffer.concat(outBufs), "utf-8");
          var err = iconv.decode(Buffer.concat(errBufs), "utf-8");
          resolve(out + (err ? "\n[stderr]\n" + err : "") + "\n[timed out]");
        }, timeout + 1000);

        proc.on("close", function(code) {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          try { fs.unlinkSync(tmpFile); } catch (e) {}
          var out = iconv.decode(Buffer.concat(outBufs), "utf-8");
          var err = iconv.decode(Buffer.concat(errBufs), "utf-8");
          var result = out;
          if (err) result += (result ? "\n[stderr]\n" : "[stderr]\n") + err;
          if (code !== 0) result += "\n[exit code: " + code + "]";
          resolve(result);
        });

        proc.on("error", function(err) {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          try { fs.unlinkSync(tmpFile); } catch (e) {}
          resolve("[error] " + err.message);
        });
      });
    }
  };
}

// 执行 cuckoo 代码
async function runCuckooCode(code, options) {
  options = options || {};
  var tools = createTools(options);

  var jsCode = code;
  var match = code.match(/```cuckoo([\\s\\S]*?)```/);
  if (match) jsCode = match[1];

  var wrapped = "(async () => {\n" + jsCode + "\n})()";

  var sandbox = {
    log: tools.log,
    bash: tools.bash,
    pwsh: tools.pwsh,
    read: tools.read,
    write: tools.write,
    edit: tools.edit,
    glob: tools.glob,
    grep: tools.grep,
    python: tools.python,
    console: { log: tools.log },
    JSON: JSON, Math: Math, Date: Date,
    Array: Array, Object: Object, String: String,
    Number: Number, Boolean: Boolean, RegExp: RegExp,
    Promise: Promise, setTimeout: setTimeout, clearTimeout: clearTimeout
  };

  var context = vm.createContext(sandbox);

  try {
    var result = await vm.runInContext(wrapped, context, { timeout: 60000, displayErrors: true });
    return { ok: true, result: result };
  } catch (e) {
    // 提取详细的错误信息（类型、堆栈、出错位置）
    var errorType = (e && e.name) || "Error";
    var errorMsg = (e && e.message) || String(e);
    var stack = (e && e.stack) || "";

    // 从堆栈里提取 vm 里的行列（<anonymous>:N:M）
    var line = 0, column = 0;
    var m = stack.match(/<anonymous>:(\d+):(\d+)/);
    if (m) {
      // wrapped = "(async () => {\n" + jsCode + "\n})()"，所以减 1 行
      line = Math.max(1, parseInt(m[1], 10) - 1);
      column = parseInt(m[2], 10);
    }

    return {
      ok: false,
      error: errorMsg,
      errorType: errorType,
      errorLine: line,
      errorColumn: column,
      errorStack: stack,
      rawCode: jsCode
    };
  }
}

module.exports = { runCuckooCode: runCuckooCode, execShell: execShell };