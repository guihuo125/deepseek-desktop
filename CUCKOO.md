# Cuckoo Code 项目说明

> 本文件在初始化项目时随系统提示词发送给 AI。**做任何改动前先读它。**

## 一、这是什么

**DeepSeek 桌面客户端** 是一个零 Token 成本的 AI Agent 桌面应用：

- 用 Electron 把 DeepSeek 网页版嵌入本地窗口
- 注入网络 hook + DOM 扫描，捕获 AI 的 cuckoo 代码块
- 在受限 vm 沙箱执行，结果回传 AI，形成 Agent 循环
- **不需要 API Key**，复用网页版账号

## 二、技术栈

| 项 | 说明 |
|---|---|
| 运行时 | Electron 33 |
| 语言 | JavaScript（CommonJS）|
| 打包 | electron-builder + Inno Setup 7 |
| 测试环境 | Windows x64 |

## 三、目录结构

```
deepseek-app/
├── main.js              主进程（窗口/托盘/IPC）
├── preload.js           网页注入（DOM 扫描 + 状态栏）
├── probe.js            网络 hook（探测 + 累积，触发已禁用）
├── security.js         命令白名单检测（只读才自动执行）
├── runner.js           沙箱执行（bash/pwsh/python/read/write/...）
├── runner-worker.js    utilityProcess 执行器入口（与主进程隔离）
├── test/               security/runner 回归测试（node test/xxx.test.js）
├── package.json        依赖 + build 配置
├── build-fast.mjs      快速打包脚本（替代 electron-builder，~3s）
├── installer.iss       Inno Setup 脚本
├── installer.nsh       Inno 自定义逻辑
├── SYSTEM_PROMPT.md    超详细系统提示词
├── CUCKOO.md           本文件
└── assets/             图标、安装程序图片
```

## 四、核心流程

```
AI 回复（DeepSeek 网页）
  ↓ MutationObserver 增量监听（只扫变化过的 <pre>）
  ↓ scanPre 提取 cuckoo 代码块
  ↓ 三重过滤（工具调用 + 长度 + 代码特征）
  ↓ 消息级去重（同一 .ds-message 只执行一次）
  ↓ scheduleExecute 800ms debounce
  ↓ autoExecute（自动链上限 3 次，手动执行不计入）
  ↓ check-cuckoo（白名单判级：read-only=safe，其余=dangerous）
  ↓ execute-cuckoo（主进程重新判级 → 危险则弹窗）
  ↓ runner-worker utilityProcess（vm 硬化沙箱）
  ↓ 结果脱敏 + 注入输入框 + 自动发送
  ↓ AI 收到结果，继续下一轮
```

## 五、关键机制

### 5.1 代码块过滤（preload.js scanPre）

三层过滤，避免误判：
1. **工具调用检查**：必须含 bash(/pwsh(/python(/read(/write(/edit(/glob(/grep(/log(/sleep(
2. **长度检查**：至少 10 字符
3. **代码特征检查**：含 ; { } ( = 或换行

### 5.2 消息级去重

用 `.ds-message` 元素属性 `data-adshield-done="1"` 标记，同一条消息只执行第一个代码块。

### 5.3 元素级去重

用 `WeakSet` 按 `<pre>` 元素记账（`processedEls`）。元素随 React 回收时记录自动消失，
不再像旧实现那样"攒够 100 条整表清空"后把已执行的块重跑一遍。
没有 DOM 元素的调用路径（网络 hook）用 `Map` 兜底，最多保留 300 条。

### 5.4 中文编码

- **cmd**：iconv-lite 按 GBK 解码
- **pwsh**：强制 `[Console]::OutputEncoding = UTF8` + UTF-8 解码
- **python**：spawn 直接调用 + `-X utf8` + `PYTHONIOENCODING=utf-8`

### 5.5 网络 hook（probe.js，默认不注入）

**现状**：probe.js 只在 `ADSHIELD_PROBE=1` 时注入，默认完全不进页面。

**原因**：它 hook 全站 XHR 并在页面内存里再攒一份完整 AI 回复，而它的产出
（`__adshield_ai_reply`）在 preload 里已经不再消费 —— 常开只有风险和内存开销。

**为什么不再靠它触发**：DeepSeek 对长回复用多次独立 XHR 分片返回，无法可靠累积。

**保留理由**：作为未来研究/改进的基础。

### 5.6 安全模型（security.js）

采用**白名单**而不是黑名单：只有能静态证明"只读且无副作用"的调用才判 `safe`。

- **safe**：`read/glob/grep/log/sleep` + `dir/type/findstr/...` + `Get-Content/Get-ChildItem/...`
- **dangerous**：`write/edit/python`、任何写操作、联网、管道/串联/重定向、非白名单可执行名
- **forbidden**：`rm -rf /`、`format c:`、`dd of=/dev/`、磁盘/注册表根级删除等，不可放行

判级前会先解码字符串字面量（`\x41`、`\u0041`、`\u{41}`、`\\`、模板串），
防止用转义把命令藏过第一层检查；代码里出现 `require(` / `process` / `.constructor` /
`eval(` / `Function(` / `import(` 等逃逸原语会直接判危险。

主进程在 `execute-cuckoo` 里**重新判级**，不信任渲染进程传来的 level。
真正的执行发生在 `utilityProcess`（`runner-worker.js`），即使 vm 被绕过，
也只是一个没有 Electron 能力的普通 Node 进程，杀得掉、重启得了。

**不给远程页面留接口**：`window.deepseekDesktop` 只暴露 version/platform 两个死字段。
执行能力（execute-cuckoo / glm-set-config 等）只由 preload 自己用 ipcRenderer 调用，
页面脚本拿不到 —— 否则 DeepSeek 端一次 XSS 就等于本地任意文件读取 + 改写 API Key。

**弹窗默认拒绝**：危险确认框里 Esc 和 Enter 都是取消，只有鼠标点「允许执行」才放行；
超过 10 分钟无人应答按拒绝处理，不会把 Agent 循环永久挂住。

### 5.7 工作区

`read/write/edit/glob/grep` 与 shell 的 `cwd` 都被限制在用户选择的**工作区**内：
`safePath()` 用 `fs.realpathSync.native` 解析后比较，junction/symlink 指向工作区外也会被拒绝。
未选择工作区时工具直接报错，不会退化成"用户主目录"。

只读 shell 命令额外做路径边界检查：绝对路径必须落在工作区内，
出现 `..`、`%VAR%`、`$env:`、`~` 时无法静态确认目标，转弹窗确认。
（用户手动确认后仍可访问外部路径，这是显式授权，不是静默放行。）

## 六、打包流程

### 6.1 快速打包（推荐）

```bash
# 只改 JS/HTML 代码（main/preload/runner/runner-worker/security/probe）
node build-fast.mjs
```

用时 **~3 秒**（替代 electron-builder 的 30 秒）。

**原理**：直接 asar pack，跳过 rebuild/packaging/signing。

### 6.2 完整打包（改依赖/配置时用）

```bash
npm run build
```

用时 **~30 秒**。改 `package.json` / `assets` / 依赖时必须用它。

### 6.3 编译 Inno 安装程序

```powershell
& "C:\Users\39007\AppData\Local\Programs\Inno Setup 7\ISCC.exe" "installer.iss"
```

用时 **~55 秒**（Inno 压缩 270 MB 文件，硬瓶颈）。

**关键**：先杀 ISCC/DeepSeek 进程，否则文件锁死。

### 6.4 回归测试

```bash
node test/security.test.js   # 85 项：拦截/放行/字面量解码/工作区边界
node test/runner.test.js     # 39 项：沙箱逃逸/工具/越界/大小与输出上限
```

## 七、使用流程

1. 用户打开应用 → 登录 DeepSeek
2. 点击左上角文件夹图标选择**工作区**（必须，否则工具不可用）
3. 用户发送 `SYSTEM_PROMPT.md` 作为第一条消息
4. 用户发送任务（如"帮我看看 D:\test 目录"）
5. AI 输出 cuckoo 代码块
6. 只读命令自动执行；写操作/联网/python 弹窗确认
7. 结果自动发送，AI 继续

## 八、可用工具（runner.js）

| 工具 | 说明 | 自动执行 |
|------|------|---------|
| bash(命令) | CMD 命令（GBK 解码）| 仅只读命令 |
| pwsh(命令) | PowerShell（UTF-8）| 仅只读 cmdlet |
| python(代码) | Python（UTF-8）| 否，需确认 |
| read(路径) | 读文件（带行号）| 是 |
| write(路径, 内容) | 写文件 | 否，需确认 |
| edit(路径, 旧, 新) | 精确替换 | 否，需确认 |
| glob(模式) | 查找文件 | 是 |
| grep(模式, 选项) | 搜索内容 | 是 |
| log(...) | 打印日志 | 是 |

## 九、已知限制

- 网络 hook 无法可靠累积（DeepSeek 分片 XHR），已禁用触发
- DOM 扫描有 800ms debounce 延迟
- 依赖 `.ds-message` / `pre` 的 DOM 结构（DeepSeek 改版可能失效）
- 工作区必须手动选择；未选择时 AI 会收到"未设置工作区"错误
- 结果仍会自动发回云端（产品核心），已做凭据脱敏 + 工作区边界约束

## 十、未来方向（参考 Cuckoo Code 原架构）

1. **P2**：壳页面（地址栏 + WebContentsView）
2. **P3**：TypeScript 迁移 + 模块化（src/tools, src/providers 等）
3. **P4**：MCP 客户端 + 多平台适配（Claude/ChatGPT/智谱）
4. **P5**：需求档案 + 自动生成物（apiMetas 模式）
