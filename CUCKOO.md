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
├── security.js         危险命令检测
├── runner.js           沙箱执行（bash/pwsh/python/read/write/...）
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
  ↓ MutationObserver 监听 DOM
  ↓ scan(pre) 提取 cuckoo 代码块
  ↓ 三重过滤（工具调用 + 长度 + 代码特征）
  ↓ 消息级去重（同一 .ds-message 只执行一次）
  ↓ scheduleExecute 800ms debounce
  ↓ autoExecute
  ↓ check-cuckoo（危险等级）
  ↓ execute-cuckoo（vm 沙箱）
  ↓ 结果注入输入框 + 自动发送
  ↓ AI 收到结果，继续下一轮
```

## 五、关键机制

### 5.1 代码块过滤（preload.js scan）

三层过滤，避免误判：
1. **工具调用检查**：必须含 bash(/pwsh(/python(/read(/write(/edit(/glob(/grep(
2. **长度检查**：至少 10 字符
3. **代码特征检查**：含 ; { } ( = 或换行

### 5.2 消息级去重

用 `.ds-message` 元素属性 `data-adshield-msg-done="1"` 标记，同一条消息只执行第一个代码块。

### 5.3 元素级去重

用 `pre.setAttribute("data-adshield-processed", "1")` 防止同一个 pre 被重复处理。

### 5.4 中文编码

- **cmd**：iconv-lite 按 GBK 解码
- **pwsh**：强制 `[Console]::OutputEncoding = UTF8` + UTF-8 解码
- **python**：spawn 直接调用 + `-X utf8` + `PYTHONIOENCODING=utf-8`

### 5.5 网络 hook（probe.js，触发已禁用）

**现状**：probe.js 仍然注入（打印调试日志），但**不触发执行**。

**原因**：DeepSeek 对长回复用**多次独立 XHR** 返回（每次一小段），无法可靠累积。

**保留理由**：作为未来研究/改进的基础。

## 六、打包流程

### 6.1 快速打包（推荐）

```bash
# 只改 JS 代码（main/preload/runner/security/probe）
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

## 七、使用流程

1. 用户打开应用 → 登录 DeepSeek
2. 用户发送 `SYSTEM_PROMPT.md` 作为第一条消息
3. 用户发送任务（如"帮我看看 D:\test 目录"）
4. AI 输出 cuckoo 代码块
5. 应用自动执行 + 发送结果
6. AI 收到结果继续

## 八、可用工具（runner.js）

| 工具 | 说明 |
|------|------|
| bash(命令) | CMD 命令（GBK 解码）|
| pwsh(命令) | PowerShell（UTF-8）|
| python(代码) | Python（UTF-8）|
| read(路径) | 读文件（带行号）|
| write(路径, 内容) | 写文件 |
| edit(路径, 旧, 新) | 精确替换 |
| glob(模式) | 查找文件 |
| grep(模式, 选项) | 搜索内容 |
| log(...) | 打印日志 |

## 九、已知限制

- 网络 hook 无法可靠累积（DeepSeek 分片 XHR），已禁用触发
- DOM 扫描有 800ms debounce 延迟
- 依赖 `.ds-message` / `pre` 的 DOM 结构（DeepSeek 改版可能失效）

## 十、未来方向（参考 Cuckoo Code 原架构）

1. **P2**：壳页面（地址栏 + WebContentsView）
2. **P3**：TypeScript 迁移 + 模块化（src/tools, src/providers 等）
3. **P4**：MCP 客户端 + 多平台适配（Claude/ChatGPT/智谱）
4. **P5**：需求档案 + 自动生成物（apiMetas 模式）
