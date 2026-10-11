# DeepSeek 桌面客户端

> 把 DeepSeek 网页版封装成桌面应用，支持 **AI 工具调用**（cuckoo 代码块 → 本地沙箱执行 → 结果自动回传）。

## ✨ 功能

- 🖥️ **桌面壳**：系统托盘、全局快捷键、窗口状态记忆、关闭到托盘
- 🤖 **AI 工具调用**：AI 输出 cuckoo 代码块 → 自动执行 → 结果回传 → 形成 Agent 循环
- 🔒 **安全沙箱**：Node `vm` 隔离，禁止 `require` / `process` / `fs`
- ⚠️ **危险命令拦截**：
  - 危险操作（del、rm、reg 等）→ **自定义红色弹窗确认**（含风险说明）
  - 禁止操作（format、shutdown、diskpart 等）→ **直接拒绝**
- 🐍 **Python 支持**：直接调用本机 Python（强制 UTF-8）
- 🌏 **中文无乱码**：cmd 用 GBK 解码，pwsh/python 强制 UTF-8
- 📊 **详细错误反馈**：出错时自动把「错误类型 + 行号 + 原始代码 + 常见原因」回传 AI
- 🌐 **多平台适配**（规划中）：DeepSeek / Claude / ChatGPT / 智谱

## 📦 安装

从 [Releases](https://github.com/guihuo125/deepseek-desktop/releases) 下载最新版：
- `DeepSeek-Setup-x.x.x.exe` — Windows 安装包

## 🚀 使用

### 1. 首次使用

打开应用 → 登录 DeepSeek → 开启新对话。

### 2. 发送系统提示词

复制 [SYSTEM_PROMPT.md](./SYSTEM_PROMPT.md) 里的内容，作为**第一条消息**发给 AI。

### 3. 发指令

例如：
```
帮我看看 D:\test 目录下有哪些文件
```

AI 会输出一个 cuckoo 代码块，应用**自动执行**并把结果回传给 AI。

## 🛠️ 开发

### 环境

- Node.js ≥ 18
- Windows x64
- Inno Setup 7（仅打包需要）

### 常用命令

```bash
# 安装依赖
npm install

# 快速打包（只改 JS 代码时用，~3 秒）
node build-fast.mjs

# 完整打包（改依赖/配置时用，~30 秒）
npm run build

# 编译 Inno 安装程序（~55 秒）
& "C:\Path\To\ISCC.exe" installer.iss
```

### 目录结构

| 文件 | 作用 |
|------|------|
| `main.js` | 主进程（窗口 / 托盘 / IPC / 自定义弹窗） |
| `preload.js` | 网页注入（DOM 扫描 + 状态栏 + 代码提取） |
| `probe.js` | 网络 hook 探测（已禁用触发，仅保留日志） |
| `security.js` | 危险命令检测（带风险描述） |
| `runner.js` | 沙箱执行（bash / pwsh / python / read / write / ...） |
| `dialog.html` | 自定义危险确认弹窗 |
| `build-fast.mjs` | 快速打包脚本 |
| `installer.iss` | Inno Setup 脚本 |

## 🧩 可用工具

AI 可在 cuckoo 代码块里调用：

| 工具 | 说明 |
|------|------|
| `bash(命令, 选项?)` | 执行 CMD 命令（GBK 解码） |
| `pwsh(命令, 选项?)` | 执行 PowerShell（UTF-8） |
| `python(代码, 选项?)` | 执行 Python（UTF-8，需本机安装 Python 3） |
| `read(路径, 选项?)` | 读文件（带行号） |
| `write(路径, 内容)` | 写文件 |
| `edit(路径, 旧文本, 新文本)` | 精确替换 |
| `glob(模式, 搜索路径?)` | 查找文件 |
| `grep(模式, 选项?)` | 搜索内容 |
| `log(...)` | 打印日志 |

## 🚧 已知限制

- **网络 hook 累积不可靠**：DeepSeek 对长回复用多次独立 XHR 分片返回，无法可靠累积。当前**用 DOM 扫描**作为抓取方案。
- **DOM 依赖**：扫描依赖 DeepSeek 网页的 `.ds-message` / `pre` 结构，DeepSeek 改版可能导致失效。
- **800ms debounce**：DOM 扫描有约 800ms 延迟。
- **仅 Windows**：当前只支持 Windows。

## 🗺️ 路线图

- [x] 基础桌面壳
- [x] AI 工具调用
- [x] 危险命令拦截
- [x] Python 支持
- [x] 详细错误反馈
- [x] 自定义危险弹窗
- [ ] 壳页面（地址栏 + WebContentsView）
- [ ] TypeScript 迁移
- [ ] MCP 客户端
- [ ] 多平台适配（Claude / ChatGPT / 智谱）

## 📄 License

[MIT](./LICENSE)

---

Made with ❤️ by [guihuo125](https://github.com/guihuo125)
