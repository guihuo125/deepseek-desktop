// 危险命令检测（C 策略：无危险直接执行，有危险弹窗确认）

// 绝对禁止的命令（无论用户是否确认，都拒绝）
const FORBIDDEN_PATTERNS = [
  /\bformat\s+[a-z]:/i,                    // format C:
  /\bdiskpart\b/i,
  /\brm\s+-rf\s+\//i,                     // rm -rf /
  /\bdel\s+\/f\s+\/s\s+\/q\s+[a-z]:\\?\*/i,  // del /f /s /q C:\
  /\brd\s+\/s\s+\/q\s+[a-z]:\s*$/i,       // rd /s /q C:
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bhalt\b/i,
  /\bmkfs\b/i,
  /\bcipher\s+\/w/i,
  /:(){ :\|:& };:/,                        // fork bomb
  /\breg\s+delete\s+HKLM\\SYSTEM/i,
  /\bvssadmin\s+delete\s+shadows/i
];

// 需要用户确认的命令（敏感操作）
const DANGEROUS_PATTERNS = [
  /\brm\s+/i,
  /\bdel\s+/i,
  /\brd\s+/i,
  /\brmdir\s+/i,
  /\bmove\s+/i,
  /\bcopy\s+/i,
  /\breg\s+(add|delete|import)/i,
  /\bschtasks\s+\/create/i,
  /\bnet\s+(user|localgroup)\s+/i,
  /\bsc\s+(delete|stop|config)/i,
  /\btaskkill\b/i,
  /\bwmic\b/i,
  /\bpowershell.*-enc/i,                    // 编码命令（隐藏意图）
  /\bcurl.*\|.*sh/i,                       // curl | sh
  /\bwget.*\|.*sh/i,
  /\biex\b/i,                              // Invoke-Expression
  /\binvoke-expression/i,
  /\bstart-process.*-verb\s+runas/i,       // 提权
  /\bsudo\b/i,
  /\b-Force\b.*-Recurse/i,                 // 递归强删
  /\bRemove-Item.*-Recurse.*-Force/i
];

// 检查代码块中的所有 bash/pwsh 调用
function checkCode(code) {
  const result = {
    level: "safe",     // safe | dangerous | forbidden
    reasons: []
  };

  // 提取所有 bash(...) / pwsh(...) 里的命令字符串
  const commands = extractCommands(code);

  for (const cmd of commands) {
    // 先检查绝对禁止
    for (const p of FORBIDDEN_PATTERNS) {
      if (p.test(cmd)) {
        result.level = "forbidden";
        result.reasons.push("包含禁止命令: " + cmd.substring(0, 100));
        return result;
      }
    }
    // 再检查需要确认
    for (const p of DANGEROUS_PATTERNS) {
      if (p.test(cmd)) {
        result.level = "dangerous";
        result.reasons.push("敏感操作: " + cmd.substring(0, 100));
        break;
      }
    }
  }

  return result;
}

// 从 cuckoo 代码中提取 bash/pwsh 命令
function extractCommands(code) {
  const commands = [];

  // 匹配 bash(`...`) 或 bash("...") 或 bash('...')
  const regexes = [
    /\bbash\s*\(\s*`([^`]+)`/g,
    /\bbash\s*\(\s*"([^"]+)"\s*\)/g,
    /\bbash\s*\(\s*'([^']+)'\s*\)/g,
    /\bpwsh\s*\(\s*`([^`]+)`/g,
    /\bpwsh\s*\(\s*"([^"]+)"\s*\)/g,
    /\bpwsh\s*\(\s*'([^']+)'\s*\)/g
  ];

  for (const re of regexes) {
    let m;
    while ((m = re.exec(code)) !== null) {
      commands.push(m[1]);
    }
  }

  // 也检查 write/edit 里的文件路径（是否敏感目录）
  const pathRegexes = [
    /\bwrite\s*\(\s*[`'"]([^`'"]+)[`'"]/g,
    /\bedit\s*\(\s*[`'"]([^`'"]+)[`'"]/g
  ];
  for (const re of pathRegexes) {
    let m;
    while ((m = re.exec(code)) !== null) {
      const p = m[1];
      // 敏感路径
      if (/^[a-z]:\\?(windows|program files|system32)/i.test(p)) {
        commands.push("WRITE_PATH:" + p);
      }
    }
  }

  return commands;
}

module.exports = { checkCode, extractCommands };
