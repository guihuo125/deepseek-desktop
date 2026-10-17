// 危险命令检测（带后果描述）

// ============ 模式库（带风险说明）============

// 绝对禁止（无论确认都拒绝）
const FORBIDDEN = [
  { p: /\bformat\s+[a-z]:/i,               desc: "格式化磁盘，会清空整块硬盘数据，不可恢复" },
  { p: /\bdiskpart\b/i,                    desc: "磁盘分区工具，误操作会导致分区表损坏、数据丢失" },
  { p: /\brm\s+-rf\s+\//i,               desc: "递归强制删除根目录，会删除整个系统" },
  { p: /\bdel\s+\/f\s+\/s\s+\/q\s+[a-z]:\\?\*/i, desc: "递归强制删除整盘文件，无法恢复" },
  { p: /\brd\s+\/s\s+\/q\s+[a-z]:\s*$/i, desc: "递归删除整个磁盘目录，无法恢复" },
  { p: /\bhalt\b/i,                        desc: "立即停止系统，可能导致数据损坏" },
  { p: /\bmkfs\b/i,                        desc: "格式化文件系统，会清空分区数据" },
  { p: /\bcipher\s+\/w/i,                 desc: "擦除磁盘空闲空间，无法恢复已删除文件" },
  { p: /:\(\)\{\s*:\|:&\s*\};:/,      desc: "Fork 炸弹，会耗尽系统资源导致死机" },
  { p: /\breg\s+delete\s+HKLM\\SYSTEM/i, desc: "删除系统注册表，会导致系统无法启动" },
  { p: /\bvssadmin\s+delete\s+shadows/i,  desc: "删除系统卷影副本，会破坏备份恢复能力" }
];

// 需要确认（敏感操作）
const DANGEROUS = [
  { p: /\bshutdown\b/i,                    desc: "关机命令，会中断所有正在进行的工作" },
  { p: /\breboot\b/i,                      desc: "重启命令，会中断所有正在进行的工作" },
  { p: /\brm\s+/i,                         desc: "删除文件或目录，无法恢复" },
  { p: /\bdel\s+/i,                        desc: "删除文件，无法恢复（不放入回收站）" },
  { p: /\brd\s+/i,                         desc: "删除目录，无法恢复" },
  { p: /\brmdir\s+/i,                      desc: "删除目录，无法恢复" },
  { p: /\bmove\s+/i,                       desc: "移动文件/目录，可能覆盖目标" },
  { p: /\bcopy\s+/i,                       desc: "复制文件，可能覆盖同名文件" },
  { p: /\breg\s+(add|delete|import)/i,     desc: "修改注册表，可能影响系统稳定性" },
  { p: /\bschtasks\s+\/create/i,          desc: "创建计划任务，可后台定时执行程序" },
  { p: /\bnet\s+(user|localgroup)\s+/i,   desc: "修改用户/用户组，可能影响账户安全" },
  { p: /\bsc\s+(delete|stop|config)/i,     desc: "修改 Windows 服务，可能导致系统功能异常" },
  { p: /\btaskkill\b/i,                    desc: "强制结束进程，未保存的数据会丢失" },
  { p: /\bwmic\b/i,                        desc: "WMI 命令，可执行系统管理操作" },
  { p: /\bpowershell.*-enc/i,               desc: "Base64 编码命令，意图被隐藏，可能有风险" },
  { p: /\bcurl.*\|.*sh/i,                  desc: "下载脚本并直接执行，可能运行恶意代码" },
  { p: /\bwget.*\|.*sh/i,                  desc: "下载脚本并直接执行，可能运行恶意代码" },
  { p: /\biex\b/i,                         desc: "Invoke-Expression，可执行任意动态代码" },
  { p: /\binvoke-expression/i,              desc: "Invoke-Expression，可执行任意动态代码" },
  { p: /\bstart-process.*-verb\s+runas/i,  desc: "以管理员权限启动进程，可能造成系统级影响" },
  { p: /\bsudo\b/i,                        desc: "提升权限执行，可能影响系统关键区域" },
  { p: /\b-Force\b.*-Recurse/i,            desc: "递归强制操作，可能批量删除/修改" },
  { p: /\bRemove-Item.*-Recurse.*-Force/i,  desc: "递归强制删除，无法恢复" }
];

// ============ 检测 ============

function checkCode(code) {
  const result = {
    level: "safe",
    items: []   // [{ cmd, desc, level }]
  };

  const commands = extractCommands(code);

  // 检查提取的命令
  for (const cmd of commands) {
    const cmdShort = cmd.substring(0, 200);
    for (const f of FORBIDDEN) {
      if (f.p.test(cmd)) {
        result.level = "forbidden";
        result.items.push({ cmd: cmdShort, desc: f.desc, level: "forbidden" });
        return result;
      }
    }
    for (const d of DANGEROUS) {
      if (d.p.test(cmd)) {
        result.level = "dangerous";
        result.items.push({ cmd: cmdShort, desc: d.desc, level: "dangerous" });
        break;
      }
    }
  }

  // 兜底：对整个 code 匹配（应对变量拼接）
  if (commands.length === 0 || result.level === "safe") {
    for (const f of FORBIDDEN) {
      if (f.p.test(code)) {
        result.level = "forbidden";
        result.items.push({ cmd: "(代码片段)", desc: f.desc, level: "forbidden" });
        return result;
      }
    }
    for (const d of DANGEROUS) {
      if (d.p.test(code)) {
        result.level = "dangerous";
        result.items.push({ cmd: "(代码片段)", desc: d.desc, level: "dangerous" });
        break;
      }
    }
  }

  // 兼容旧格式：reasons 数组
  result.reasons = result.items.map(function(it) {
    return "操作: " + it.cmd + "\n风险: " + it.desc;
  });

  return result;
}

// ============ 命令提取 ============

function extractCommands(code) {
  const commands = [];
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
  const pathRegexes = [
    /\bwrite\s*\(\s*[`'"]([^`'"]+)[`'"]/g,
    /\bedit\s*\(\s*[`'"]([^`'"]+)[`'"]/g
  ];
  for (const re of pathRegexes) {
    let m;
    while ((m = re.exec(code)) !== null) {
      const p = m[1];
      if (/^[a-z]:\\?(windows|program files|system32)/i.test(p)) {
        commands.push("WRITE_PATH:" + p);
      }
    }
  }
  return commands;
}

module.exports = { checkCode, extractCommands };
