# DeepSeek 桌面客户端

> 把 DeepSeek 网页版封装成桌面应用，支持 **AI 工具调用**（cuckoo 代码块 → 本地沙箱执行 → 结果自动回传），形成可自我纠错的 Agent 循环。

## ✨ 功能

- 🖥️ **桌面壳**：地址栏 + 系统托盘 + 全局快捷键 `Ctrl+Shift+D` + 窗口状态记忆 + 关闭到托盘
- 🤖 **AI 工具调用**：AI 输出 cuckoo 代码块 → 本地执行 → 结果回传 → 形成 Agent 循环
- 🛡️ **白名单安全模型**：只有能被静态证明「只读、无副作用」的代码才自动执行，其余先问你（详见[安全模型](#-安全模型)）
- 🔒 **双层沙箱**：代码在独立子进程（`utilityProcess`）里跑，子进程内再套 Node `vm` 隔离；沙箱被突破的最坏后果不再等于主进程被远程执行代码
- 📁 **工作区限制**：文件读写与命令路径都被限制在你选定的目录内，`..` 穿越、绝对路径、环境变量都会拦
- 🧩 **GLM 协作面板**：右下角悬浮球唤出，独立于 DeepSeek 的智谱流式对话，用于让第二个模型帮你纠错
- 🎨 **Claude 风格主题**：跟随系统 / 浅色 / 深色，壳层与网页同时生效
- 🐍 **Python 支持**：直接调用本机 Python 3（强制 UTF-8）
- 🌏 **中文无乱码**：cmd 输出按 GBK 解码，pwsh / python 强制 UTF-8
- 📊 **详细错误反馈**：出错时自动把「错误类型 + 行号 + 原始代码 + 常见原因」回传 AI
- 🔄 **自动更新**：从 GitHub Releases 检查新版本

## 📦 安装

从 [Releases](https://github.com/guihuo125/deepseek-desktop/releases) 下载最新版：

- `DeepSeek-Setup-x.x.x.exe` — Windows 安装包（约 104 MB）

普通权限即可安装，不需要管理员；默认安装目录跟随权限自动选择。从旧版本升级建议先卸载，避免两份安装并存。

## 🚀 使用

### 1. 选择工作区（必做）

点左上角文件夹图标，选一个项目目录。**不选工作区，`read` / `write` / `edit` 与命令里的路径都会被拦下。**

### 2. 登录并开启对话

打开应用 → 登录 DeepSeek → 新建对话。

### 3. 发送系统提示词

复制 [SYSTEM_PROMPT.md](./SYSTEM_PROMPT.md) 里的内容，作为**第一条消息**发给 AI。

### 4. 发指令

```
帮我看看当前目录下有哪些文件
```

AI 会输出一个 cuckoo 代码块。只读操作直接执行并回传结果；涉及写入、删除或 Python 的，会先弹确认窗。

## 🔒 安全模型

判级由主进程独立完成，不信任渲染进程传来的结论。三个等级：

| 等级 | 行为 | 例子 |
|------|------|------|
| `safe` | 自动执行，不打扰你 | `dir`、`cat`、`Get-ChildItem`、`read()`、`glob()`、`grep()` |
| `dangerous` | 弹确认窗，你点了才执行 | `write()`、`edit()`、`python()`、任何写操作、越出工作区的路径 |
| `forbidden` | 直接拒绝，确认也不放行 | `format c:`、`diskpart`、`rm -rf /`、删除卷影副本、Fork 炸弹 |

**为什么是白名单而不是黑名单**：`python()` 的代码体、PowerShell 的 .NET API、shell 重定向、变量拼接都能绕过任何规则列表，而漏判一次的代价是本机任意代码执行。所以反过来做——证明只读才放行，证明不了就问人。

其他防护：

- 只读命令也要过工作区边界。`type C:\Windows\win.ini` 确实「只读」，但它读的是工作区外的文件，而结果会自动上传云端，因此同样需要确认。
- 命令里的字符串字面量会先做静态解码（`\x`、`\u`、`\u{}`），八进制转义一律视为混淆直接拒绝，防 `rm\x20-rf` 这类绕过。
- 执行结果回传前先过凭据脱敏。
- 确认窗 `Enter` / `Esc` 都是取消，只有点「允许执行」才放行；10 分钟无人应答按拒绝处理，不会把任务永久挂住。
- 网页上下文拿不到任何本地执行能力，注入脚本与页面之间只暴露版本号与平台名。

## 🛠️ 开发

### 环境

- Node.js ≥ 18
- Windows x64
- Inno Setup 7（仅打包安装程序需要）

### 常用命令

```bash
# 安装依赖
npm install

# 回归测试（无需构建，直接跑）
node test/security.test.js
node test/runner.test.js

# 快速打包：只改 JS/HTML 时用，重写 app.asar，实测约 3 秒
node build-fast.mjs

# 完整打包：改依赖 / 图标 / 配置时才需要，会重编整个 win-unpacked，明显更慢
npm run build

# 编译 Inno 安装程序，产物自动进 inno-out/，实测约 19 秒
& "C:\Path\To\Inno Setup 7\ISCC.exe" installer.iss
```

改版本号只需同步两处：`package.json` 的 `version` 与 `installer.iss` 的 `MyAppVersion`。产物文件名用模板，会自动跟随。

### 目录结构

| 文件 | 作用 |
|------|------|
| `main.js` | 主进程（窗口 / 托盘 / IPC / 确认弹窗 / 自动更新） |
| `preload.js` | 网页注入（代码块扫描、执行调度、GLM 面板、主题注入） |
| `runner.js` | 沙箱执行器（只在子进程里加载，主进程不 require） |
| `runner-worker.js` | `utilityProcess` 子进程入口 |
| `security.js` | 白名单分级 + 工作区边界判定 |
| `shell.html` | 壳层界面（地址栏、设置面板、工作区选择） |
| `shell-preload.js` | 壳层 IPC 桥 |
| `dialog.html` | 自定义危险确认弹窗 |
| `probe.js` | 网络 hook 探测，默认不注入，需 `ADSHIELD_PROBE=1` 显式开启 |
| `build-fast.mjs` | 快速打包脚本 |
| `installer.iss` | Inno Setup 脚本 |
| `test/` | 回归测试，不随应用发布 |

## 🧩 可用工具

AI 可在 cuckoo 代码块里调用：

| 工具 | 说明 | 默认是否自动执行 |
|------|------|------------------|
| `read(路径, 选项?)` | 读文件（带行号） | ✅ 工作区内自动 |
| `glob(模式, 搜索路径?)` | 查找文件 | ✅ 工作区内自动 |
| `grep(模式, 选项?)` | 搜索内容 | ✅ 工作区内自动 |
| `bash(命令, 选项?)` | 执行 CMD 命令（GBK 解码） | ⚠️ 仅只读白名单命令 |
| `pwsh(命令, 选项?)` | 执行 PowerShell（UTF-8） | ⚠️ 仅只读白名单命令 |
| `write(路径, 内容)` | 写文件 | ❌ 需确认 |
| `edit(路径, 旧文本, 新文本)` | 精确替换 | ❌ 需确认 |
| `python(代码, 选项?)` | 执行 Python（需本机 Python 3） | ❌ 需确认 |
| `log(...)` | 打印日志 | ✅ |
| `sleep(毫秒)` | 等待 | ✅ |

## 🚧 已知限制

- **执行结果会发送给 DeepSeek**：这是产品的核心工作方式，不做阉割；边界由「只读白名单 + 工作区限制 + 凭据脱敏」三层收束，但不覆盖工作区内本就敏感的文件内容。
- **DOM 依赖**：代码块识别依赖 DeepSeek 网页的 `.ds-message` / `pre` 结构，对方改版可能失效，届时需更新选择器。
- **800ms 稳定窗口**：为避免执行到写了一半的代码块，扫描有约 800ms 延迟；理论上仍存在执行到未完成块的可能。
- **仅 Windows**：编码约定（GBK / UTF-8）、进程树终止方式都绑定 Windows。

## 🗺️ 路线图

- [x] 基础桌面壳（地址栏 + WebContentsView + 托盘）
- [x] AI 工具调用与 Agent 循环
- [x] 白名单安全模型 + 子进程隔离 + 工作区边界
- [x] Python 支持 / 详细错误反馈 / 自定义确认弹窗
- [x] GLM 协作面板 / Claude 风格主题 / 自动更新检查
- [x] 回归测试（124 项断言）
- [ ] GLM 面板跟随主题切换
- [ ] 网页深色主题的特殊元素精修
- [ ] TypeScript 迁移
- [ ] MCP 客户端
- [ ] 多平台适配（Claude / ChatGPT / 智谱）

## 📄 License

[MIT](./LICENSE)

---

Made with ❤️ by [guihuo125](https://github.com/guihuo125)
