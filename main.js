const {
  app, BrowserWindow, WebContentsView, Tray, Menu, globalShortcut, Notification,
  shell, dialog, safeStorage, nativeTheme, screen, ipcMain, utilityProcess, session
} = require("electron");
const fs = require("fs");
const https = require("https");
const path = require("path");
const { StringDecoder } = require("string_decoder");
const { autoUpdater } = require("electron-updater");

// ============ 单实例锁 ============
// 必须排在所有 ipcMain.handle 注册之前。旧实现放在文件末尾，
// 第二实例会先把十几个 IPC handler 注册一遍再退出，纯属浪费。
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

// ============ 强制使用独立显卡（best-effort）============
// 这两个对 Chromium 不是标准入口，能不能生效取决于显卡驱动，保留但不依赖它们。
process.env.SHIM_MCCOMPAT = "0x800000001";
app.commandLine.appendSwitch("force_high_performance_gpu");

app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("enable-zero-copy");

// 禁止后台节流（应用常驻托盘，被节流会导致切回来时明显卡顿）
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

app.commandLine.appendSwitch("js-flags", "--max-old-space-size=4096");
// 注意：不要加 NetworkServiceInProcess。它会把网络栈合并进主进程，
// 网络层的任何漏洞就直接打到持有 API Key 和 execute-cuckoo 的主进程上。

// ★ 常量名不能叫 URL —— 那会遮蔽全局的 URL 构造函数，
//   导致 isTrustedUrl 里的 new URL() 抛 "URL is not a constructor"，
//   被 catch 吞掉后恒返回 false，地址栏和站内导航会全部静默失效。
const HOME_URL = "https://chat.deepseek.com/";
const APP_NAME = "DeepSeek";

const IS_DEV = !app.isPackaged || !!process.env.ELECTRON_DEV;

const security = require("./security.js");

// 地址栏高度（与 shell.html 里的 .address-bar 一致）
const ADDRESS_BAR_HEIGHT = 48;

let mainWindow = null;   // 壳窗口（地址栏）
let aiView = null;       // AI 网页视图（WebContentsView）
let securityView = null; // 连接信息浮层（独立 WebContentsView，不参与网页布局）
let securityOpen = false;
let tray = null;
let trayAvailable = false;   // 托盘没建起来时，关窗口必须真的退出，否则进程再也唤不回来
let isQuitting = false;

// 可信 URL 校验：只允许 https 且 hostname 为 deepseek.com 或其子域。
// 判定规则本体在 security.js（与注入侧门控、地址栏三态共用同一份实现），
// 这里只保留「解析失败必须能在日志里看到」这层包装。
function isTrustedUrl(url) {
  try {
    new URL(url);
  } catch (e) {
    console.warn("[Main] URL 解析失败，按不可信处理:", String(url).substring(0, 200), e.message);
    return false;
  }
  return security.isDeepSeekUrl(url);
}

// ============ 权限收口 ============
// 地址栏能打开任意站点之后这条必须有：Electron 的默认行为是对 media /
// geolocation / notifications 等请求弹系统授权框，任何被浏览到的站点都能借机
// 索取摄像头、麦克风、定位。这里默认全拒，只给 DeepSeek 开 notifications
//（它确实要用通知提示回复完成），媒体设备/剪贴板/定位/MIDI 连 DeepSeek 也不给。
function hardenPermissions(ses) {
  const isDeepSeekOrigin = (origin) => {
    try { return isTrustedUrl(String(origin)); } catch (e) { return false; }
  };
  const granted = (permission, origin) =>
    permission === "notifications" && isDeepSeekOrigin(origin);

  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    let origin = (details && details.requestingOrigin) || "";
    if (!origin && wc && !wc.isDestroyed()) origin = wc.getURL();
    const ok = granted(permission, origin);
    if (!ok) console.warn("[Security] 已拒绝权限:", permission, String(origin).substring(0, 120));
    callback(ok);
  });

  // 同步检查接口（navigator.permissions.query 之类）也要拦，否则只挡弹窗没用
  ses.setPermissionCheckHandler((wc, permission, origin) => {
    let o = origin || "";
    if (!o && wc && !wc.isDestroyed()) o = wc.getURL();
    return granted(permission, o);
  });
}

// ============ 壳层安全状态（地址栏锁图标的数据源）============
// 三态按「对本应用的实际含义」划分，而不是只看加密与否：
//   secure-app   https + DeepSeek 官方域 → 注入与本地执行能力启用
//   secure-web   https + 其它站点        → 连接加密，但本应用能力已自我关闭
//   insecure     明文 http / 证书出错     → 未加密，能力关闭
// 判定条件与 preload.js 顶部的门控严格一致，避免两处说法不同误导用户。
let certError = null;

function securityInfo(url) {
  return security.shellSecurityInfo(url, { workspace: currentWorkspace, certError: certError });
}

// ============ IPC 来源校验 ============
// preload 通过 contextBridge 暴露给远程页面的接口，任何跑在 chat.deepseek.com
// 上下文里的脚本都能调用（包括第三方脚本和潜在的 XSS）。主进程必须自己确认
// 请求确实来自我们认识的那个 webContents，不能只看 channel 名。
function senderIsAiView(event) {
  return !!(aiView && !aiView.webContents.isDestroyed() && event && event.sender &&
    event.sender.id === aiView.webContents.id);
}
function senderIsShell(event) {
  return !!(mainWindow && !mainWindow.isDestroyed() && event && event.sender &&
    event.sender.id === mainWindow.webContents.id);
}
function senderIsSecurityView(event) {
  return !!(securityView && !securityView.webContents.isDestroyed() && event && event.sender &&
    event.sender.id === securityView.webContents.id);
}
function assertTrustedSender(event) {
  if (!senderIsAiView(event) && !senderIsShell(event)) {
    throw new Error("非法的 IPC 来源");
  }
}
function assertAiViewSender(event) {
  if (!senderIsAiView(event)) throw new Error("非法的 IPC 来源");
  // 地址栏现在能打开任意站点，而 aiView 始终是同一个 webContents —— 只比对
  // event.sender.id 等于「请求来自这个视图就放行」，第三方页面照样能发。
  // preload 那边按域名自我关闭了，但那是注入侧的单点判断，主进程不能只依赖它。
  // isTrustedUrl 内部已强制 https：明文 HTTP 下中间人可以往页面里塞一个
  // <pre>dir</pre>，只看 hostname 的话 http://chat.deepseek.com 就能拿到本地执行。
  let src = "";
  try { src = event.sender.getURL(); } catch (e) {}
  if (!isTrustedUrl(src)) {
    throw new Error("来源页面不是 https 的 DeepSeek 站点");
  }
}

// ============ 主题管理 ============
const CONFIG_DIR = app.getPath("userData");
const CONFIG_FILE = path.join(CONFIG_DIR, "window-state.json");
const THEME_FILE = path.join(CONFIG_DIR, "theme.json");
const WORKSPACE_FILE = path.join(CONFIG_DIR, "workspace.json");
const GLM_CONFIG_FILE = path.join(CONFIG_DIR, "glm-config.json");

let currentTheme = "system";
let resolvedTheme = "light";

function loadThemeConfig() {
  try {
    if (fs.existsSync(THEME_FILE)) {
      const data = JSON.parse(fs.readFileSync(THEME_FILE, "utf-8"));
      if (["light", "dark", "system"].includes(data.theme)) currentTheme = data.theme;
    }
  } catch (e) {
    console.warn("[Theme] 读取失败:", e.message);
  }
  resolvedTheme = currentTheme === "system"
    ? (nativeTheme.shouldUseDarkColors ? "dark" : "light")
    : currentTheme;
}

function saveThemeConfig() {
  try {
    fs.writeFileSync(THEME_FILE, JSON.stringify({ theme: currentTheme }), "utf-8");
  } catch (e) {
    console.warn("[Theme] 保存失败:", e.message);
  }
}

// 页面加载完成前的过渡底色。必须与 themes/claude.css 的 --bg-canvas 一致，
// 否则打开时会先闪一下别的颜色。
function themeBg() {
  return resolvedTheme === "dark" ? "#262624" : "#FAF9F5";
}

function applyWindowTheme() {
  // 关键：网页主题段（claude-web.css 的 prefers-color-scheme 深色块、GLM 面板）和
  // dialog 都靠媒体查询判断，而不设 themeSource 时它只跟系统走 ——
  // 用户在本应用里选「深色」却拿到一份浅色网页，就是这个断层。
  try { nativeTheme.themeSource = currentTheme; } catch (e) {}
  const bg = themeBg();
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.setBackgroundColor(bg); } catch (e) {}
  }
  if (aiView && !aiView.webContents.isDestroyed()) {
    try { aiView.setBackgroundColor(bg); } catch (e) {}
  }
}

// ============ 网页 Claude 主题注入 ============
// themes/claude-web.css 是给 chat.deepseek.com 用的样式表。深色段写在文件内部的
// @media (prefers-color-scheme: dark) 里 —— Electron 的该媒体查询跟随 nativeTheme，
// 所以整份注入一次即可，切主题不需要换文件或重注入。
let webCssText = null;
let webCssKey = null;

function loadWebThemeCss() {
  if (webCssText === null) {
    try {
      webCssText = fs.readFileSync(path.join(__dirname, "themes", "claude-web.css"), "utf-8");
    } catch (e) {
      // 读不到就保持网页原样，绝不能让窗口起不来
      console.error("[Theme] 读取 themes/claude-web.css 失败，网页维持原样式:", e.message);
      webCssText = "";
    }
  }
  return webCssText;
}

// 网页字体：claude-web.css 里只有 font-family，刻意没写 @font-face —— 相对路径在
// 远端页面上解析不到 asar，file:// 会被隐私拦截，data: 又受页面 CSP 的 font-src 管。
// FontFace(字节) 不产生任何资源请求，CSP 无从拦截，字体照样注册进这个 document。
const WEB_FONTS = [
  { family: "Inter", weight: "100 900", file: "inter-normal-variable.woff2" },
  { family: "Source Serif 4", weight: "200 900", file: "source-serif-4-variable.woff2" },
];
let webFontJsText;   // undefined=未读，null=不可用

function webFontJs() {
  if (webFontJsText !== undefined) return webFontJsText;
  const list = [];
  for (const f of WEB_FONTS) {
    try {
      const buf = fs.readFileSync(path.join(__dirname, "assets", "fonts", f.file));
      list.push({ family: f.family, weight: f.weight, b64: buf.toString("base64") });
    } catch (e) {
      console.warn(`[Theme] 字体 ${f.file} 读取失败，网页回退系统字体:`, e.message);
    }
  }
  webFontJsText = list.length
    ? `(async()=>{for(const f of ${JSON.stringify(list)}){try{` +
      `const b=Uint8Array.from(atob(f.b64),c=>c.charCodeAt(0));` +
      `const ff=new FontFace(f.family,b.buffer,{weight:f.weight,display:"swap"});` +
      `await ff.load();document.fonts.add(ff);}catch(e){}}return 1})()`
    : null;
  return webFontJsText;
}

// dom-ready 与 did-finish-load 可能几乎同时到达，并发执行会各插一份却只记住最后
// 一个 key，前一份永远删不掉。用 promise 链串行化，并用 key 做幂等。
let webCssChain = Promise.resolve();
function applyWebTheme(force) {
  webCssChain = webCssChain
    .then(() => applyWebThemeNow(force))
    .catch((e) => console.warn("[Theme] 注入失败:", e.message));
  return webCssChain;
}

async function applyWebThemeNow(force) {
  if (!aiView || aiView.webContents.isDestroyed()) return;
  if (webCssKey && !force) return;          // 本文档已注入过
  if (webCssKey) {
    await aiView.webContents.removeInsertedCSS(webCssKey).catch(() => {});
    webCssKey = null;
  }
  // 与 preload.js 的注入门控同源：只在官方 https 页面改外观。
  // 第三方站点被我们改样式既越界，也会让「能力已关闭」的页面看起来仍被接管。
  if (!isTrustedUrl(aiView.webContents.getURL())) return;
  const css = loadWebThemeCss();
  if (!css) return;
  // cssOrigin:"user" 只决定我们站在「用户」这一档，不自动获得优先级：
  // 普通声明的层叠顺序是【作者 > 用户 > UA】，页面自己的普通声明照样压得住我们。
  // 所以 themes/claude-web.css 里接管令牌与字体族的那批声明必须逐条 !important
  // （important 侧才反过来：用户 > 作者）。别因为"我们是 user origin"就删掉它们。
  // 先插 CSS 再装字体：字体那段要传 ~230KB base64 并等 FontFace.load()，
  // 放在前面会把首屏上色一起拖住；颜色不依赖字体，先落地。
  webCssKey = await aiView.webContents.insertCSS(css, { cssOrigin: "user" });
  const js = webFontJs();
  if (js) {
    await aiView.webContents.executeJavaScript(js).catch((e) => {
      console.warn("[Theme] 字体注入失败，网页回退系统字体:", e.message);
    });
  }
}

function broadcastTheme() {
  const payload = { theme: currentTheme, resolved: resolvedTheme };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("theme-changed", payload);
  }
  // 浮层是独立文档，自己不跟 nativeTheme，需要单独收一份解析后的主题
  if (securityOpen && securityView && !securityView.webContents.isDestroyed()) {
    securityView.webContents.send("theme-changed", payload);
  }
  // 不往 aiView 发明文：那边没有监听者，网页主题由 nativeTheme 驱动的
  // prefers-color-scheme 自己跟随，多发一条只是死 IPC。
  applyWindowTheme();
  // ★ 这里【不要】重新注入网页样式表。深色段是靠文件内的 prefers-color-scheme 与
  //   body.dark 两段令牌自动跟随的，换主题不需要换文件。
  //   而且 removeInsertedCSS 对 cssOrigin:"user" 插入的表并不生效（实测：每调一次
  //   force 重注入，页面里就多留一份样式表，切两次主题后同一批规则匹配到 4 份，
  //   样式重算成本直接乘倍）。所以一个文档只注入一次：dom-ready 负责，
  //   did-finish-load 兜底（key 为空时才会真的插）。
}


// ============ 面板让位 ============
// 壳层面板展开时由 shell.html 报一次：哪一侧、让多宽。0 表示收回。
let viewInset = { side: null, width: 0 };
let layoutViewRef = null;

// ============ 窗口状态 ============
function loadWindowState() {
  const fallback = { width: 1280, height: 800 };
  try {
    if (!fs.existsSync(CONFIG_FILE)) return fallback;
    const s = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    if (typeof s.width !== "number" || typeof s.height !== "number") return fallback;
    const size = { width: Math.max(800, s.width), height: Math.max(600, s.height) };
    if (typeof s.x !== "number" || typeof s.y !== "number") return size;
    // 校验窗口是否还落在某块可见显示器上。用户拔掉外接屏或改分辨率后，
    // 旧坐标会把窗口丢到屏幕外 —— 拖不回来也关不掉（关闭是最小化到托盘）。
    if (isBoundsOnScreen(s)) return { width: size.width, height: size.height, x: s.x, y: s.y };
    console.warn("[Main] 保存的窗口位置不在任何显示器内，已重置位置");
    return size;
  } catch (e) {
    return fallback;
  }
}

function isBoundsOnScreen(b) {
  const displays = screen.getAllDisplays();
  return displays.some((d) => {
    const wa = d.workArea;
    // 至少留出 80px 宽、40px 高在屏幕内，保证标题栏能被鼠标够到
    return b.x < wa.x + wa.width - 80 &&
           b.x + (b.width || 0) > wa.x + 80 &&
           b.y < wa.y + wa.height - 40 &&
           b.y + (b.height || 0) > wa.y;
  });
}

let saveStateTimer = null;
function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const bounds = mainWindow.getBounds();
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(bounds));
  } catch (e) {
    console.warn("[Main] 保存窗口状态失败:", e.message);
  }
}
// resize/move 是高频事件，直接同步写盘会在拖动窗口时一路阻塞主进程
function saveWindowStateDebounced() {
  if (saveStateTimer) clearTimeout(saveStateTimer);
  saveStateTimer = setTimeout(saveWindowState, 400);
}

// ============ cuckoo 执行器（utilityProcess 隔离）============
const WORKER_PATH = path.join(__dirname, "runner-worker.js");
const EXEC_TIMEOUT_MS = 120000;
// 危险确认弹窗最长等待时间：超时按拒绝处理，避免渲染进程的 invoke 永久挂起
const DIALOG_TIMEOUT_MS = 10 * 60 * 1000;
let worker = null;
const workerPending = new Map();
let workerSeq = 0;

function onWorkerMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "ready" || msg.type === "pong") return;
  if (msg.type === "crashed") {
    console.error("[runner] 执行进程内部崩溃:", msg.error);
    // 崩溃的那一侧可能已经把 worker 的串行队列卡住，pending 的请求永远等不到回复。
    // 带 id 就只结掉那一个；不带 id 说明进程状态未知，把全部 pending 判失败，
    // 否则渲染进程的 invoke 要挂到 135 秒超时才有结果。
    const reason = new Error("执行进程内部崩溃: " + (msg.error || "未知"));
    if (typeof msg.id === "string" && msg.id) {
      const one = workerPending.get(msg.id);
      if (one) {
        workerPending.delete(msg.id);
        clearTimeout(one.timer);
        one.reject(reason);
      }
    } else {
      for (const [, entry] of workerPending) {
        clearTimeout(entry.timer);
        entry.reject(reason);
      }
      workerPending.clear();
    }
    return;
  }
  const entry = workerPending.get(msg.id);
  if (!entry) return;

  if (msg.type === "log") {
    entry.logs.push(msg.msg);
    console.log("[cuckoo]", msg.msg);
    return;
  }
  workerPending.delete(msg.id);
  clearTimeout(entry.timer);
  if (msg.type === "done") {
    entry.resolve(msg.payload);
  } else {
    entry.reject(new Error(msg.error || "执行器内部错误"));
  }
}

function spawnWorker() {
  if (worker) return worker;
  worker = utilityProcess.fork(WORKER_PATH, [], {
    serviceName: "cuckoo-runner",
    stdio: "pipe"
  });
  worker.stdout.on("data", (d) => console.log("[runner]", d.toString().trimEnd()));
  worker.stderr.on("data", (d) => console.error("[runner]", d.toString().trimEnd()));
  worker.on("message", onWorkerMessage);
  worker.on("exit", (code) => {
    console.warn("[runner] 执行进程退出, code=" + code);
    worker = null;
    // 不能让渲染进程的 invoke 永久挂起
    for (const [, entry] of workerPending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("执行进程意外退出（code=" + code + "）"));
    }
    workerPending.clear();
  });
  return worker;
}

function killWorker() {
  if (!worker) return;
  const w = worker;
  worker = null;
  try { w.kill(); } catch (e) {}
}

function executeInWorker(code) {
  return new Promise((resolve, reject) => {
    let w;
    try {
      w = spawnWorker();
    } catch (e) {
      reject(new Error("无法启动执行进程: " + e.message));
      return;
    }

    const id = "w" + (++workerSeq);
    const entry = { resolve: resolve, reject: reject, logs: [], timer: null };

    // 比 worker 内部的看门狗多留 15 秒余量，兜住 worker 自身卡死的情况
    entry.timer = setTimeout(() => {
      if (!workerPending.has(id)) return;
      workerPending.delete(id);
      try { w.postMessage({ type: "cancel" }); } catch (e) {}
      killWorker();
      const err = new Error("执行超时（超过 " + Math.round(EXEC_TIMEOUT_MS / 1000) + " 秒），已终止");
      err.logs = entry.logs;
      reject(err);
    }, EXEC_TIMEOUT_MS + 15000);

    workerPending.set(id, entry);
    try {
      w.postMessage({
        type: "execute",
        id: id,
        code: code,
        workspace: currentWorkspace,
        deadline: EXEC_TIMEOUT_MS
      });
    } catch (e) {
      workerPending.delete(id);
      clearTimeout(entry.timer);
      reject(e);
    }
  });
}

// ============ 工作区管理 ============
let currentWorkspace = "";

try {
  if (fs.existsSync(WORKSPACE_FILE)) {
    const data = JSON.parse(fs.readFileSync(WORKSPACE_FILE, "utf-8"));
    if (data.workspace && fs.existsSync(data.workspace)) currentWorkspace = data.workspace;
  }
} catch (e) {
  console.warn("[Main] 读取工作区配置失败:", e.message);
}

// ============ 敏感信息脱敏 ============
// 执行结果会自动回传给 DeepSeek 云端。工作区里如果有 .env / 证书 / 密钥，
// 内容会原样上传。这里只拦「几乎不可能需要发给 AI」的高置信度凭据，
// 避免误伤正常代码。
const SECRET_PATTERNS = [
  [/-{5}BEGIN [A-Z ]*PRIVATE KEY-{5}[\s\S]*?-{5}END [A-Z ]*PRIVATE KEY-{5}/g, "<已隐藏：私钥>"],
  [/-{5}BEGIN [A-Z ]*PRIVATE KEY-{5}/g, "<已隐藏：私钥>"],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, "<已隐藏：AWS Access Key>"],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, "<已隐藏：GitHub Token>"],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, "<已隐藏：API Key>"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "<已隐藏：Slack Token>"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "<已隐藏：JWT>"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "<已隐藏：Google API Key>"]
];

function redactSecrets(text) {
  if (typeof text !== "string" || !text) return text;
  let out = text;
  for (const [re, tag] of SECRET_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, tag);
  }
  return out;
}

// ============ 格式化详细错误信息（供 AI 自动修正）============
function formatExecutionError(result, rawCode) {
  const lines = [];
  lines.push("❌ 代码执行失败");
  lines.push("");
  lines.push("【错误类型】" + (result.errorType || "Error"));
  lines.push("【错误信息】" + (result.error || "未知错误"));
  if (result.errorLine) {
    lines.push("【出错位置】第 " + result.errorLine + " 行" +
      (result.errorColumn ? " 第 " + result.errorColumn + " 列" : ""));
  }
  const fullCode = String(rawCode || result.rawCode || "");
  lines.push("");
  lines.push("【你的代码】（原文）");
  lines.push("```javascript");
  lines.push(fullCode.substring(0, 8000) || "(空)");
  lines.push("```");
  lines.push("");
  lines.push("【代码长度】" + fullCode.length + " 字符");
  if (result.errorStack) {
    lines.push("");
    lines.push("【错误堆栈】");
    lines.push(String(result.errorStack).substring(0, 2000));
  }
  lines.push("");
  lines.push("【常见原因】");
  lines.push("1. ⚠️ 字符串转义陷阱（最常见）：");
  lines.push("   · JS 里反斜杠是转义符：\\t = Tab、\\n = 换行、\\r = 回车");
  lines.push("   · Windows 路径要写双反斜杠：\"D:\\\\path\\\\file.txt\"");
  lines.push("   · 推荐用正斜杠：\"D:/path/file.txt\"");
  lines.push("2. 全角标点 → 改成半角 () ; : , 和英文引号");
  lines.push("3. 忘记 return");
  lines.push("4. 括号/引号不配对");
  lines.push("5. 使用了沙箱不允许的 API（require、process、fs、fetch、constructor）");
  lines.push("6. 相对路径越界（只能访问用户选择的工作区目录）");
  lines.push("7. 未设置工作区（需要用户先点左上角文件夹图标选择目录）");
  return lines.join("\n").substring(0, 12000);
}

// ============ 连接信息浮层 ============
// 尺寸 = 卡片 330/288 + 四周 16px 阴影留白。view 是矩形而不是卡片形状，
// 所以窗口边缘要 clamp 住，别让浮层跑出可视区。
const SECURITY_VIEW_W = 362;
const SECURITY_VIEW_H = 320;

function currentSecurityState() {
  const u = aiView && !aiView.webContents.isDestroyed()
    ? (aiView.webContents.getURL() || HOME_URL)
    : HOME_URL;
  return Object.assign({ url: u }, securityInfo(u));
}

function placeSecurityView(anchorX) {
  if (!mainWindow || mainWindow.isDestroyed() || !securityView) return;
  const [w, h] = mainWindow.getContentSize();
  const width = Math.min(SECURITY_VIEW_W, Math.max(0, w - 16));
  const height = Math.min(SECURITY_VIEW_H, Math.max(0, h - ADDRESS_BAR_HEIGHT - 12));
  // 卡片自带 16px 内边距：view.x 比锚点少 16，卡片左边才和锁图标对齐
  const anchor = Number.isFinite(Number(anchorX)) ? Number(anchorX) : 16;
  const x = Math.max(8, Math.min(anchor - 16, w - width - 8));
  securityView.setBounds({ x, y: ADDRESS_BAR_HEIGHT + 6, width, height });
}

function pushSecurityState() {
  if (!securityOpen || !securityView || securityView.webContents.isDestroyed()) return;
  securityView.webContents.send("security-state", currentSecurityState());
}

function openSecurityPanel(anchorX) {
  if (!securityView || securityView.webContents.isDestroyed()) return;
  placeSecurityView(anchorX);
  securityOpen = true;
  securityView.setVisible(true);
  pushSecurityState();
  // 浮层文档只在加载时拉过一次主题。如果它关着的时候用户切了主题，
  // 现在打开就会拿到旧色（实测深色下开出来一张浅色卡片），所以每次打开补发。
  securityView.webContents.send("theme-changed", { theme: currentTheme, resolved: resolvedTheme });
  securityView.webContents.send("security-open");
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("security-panel-state", true);
  }
}

function closeSecurityPanel() {
  if (!securityOpen) return;
  securityOpen = false;
  if (securityView && !securityView.webContents.isDestroyed()) securityView.setVisible(false);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("security-panel-state", false);
  }
}

// ============ 创建主窗口 ============
function createWindow() {
  const state = loadWindowState();

  // === 1. 壳窗口（只装地址栏）===
  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 800,
    minHeight: 600,
    title: APP_NAME,
    icon: path.join(__dirname, "assets", "icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "shell-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: IS_DEV
    },
    backgroundColor: themeBg(),
    show: false,
    autoHideMenuBar: true
  });

  mainWindow.loadFile(path.join(__dirname, "shell.html"));

  // === 2. AI 网页视图 ===
  aiView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // 生产环境不开 DevTools：远程页面一旦开了控制台，
      // 里面的脚本就能直接调 window.deepseekDesktop.executeCode
      devTools: IS_DEV
    }
  });

  mainWindow.contentView.addChildView(aiView);

  // === 2.5 连接信息浮层 ===
  // 以前这块是 shell.html 里的 DOM。壳层是窗口的底层 webContents，而 aiView
  // 是盖在它上面的原生视图 —— 要看见面板就必须把网页缩窄让位，代价是正文列
  // 每次开合都被推走。改成独立 WebContentsView 后，它只占地址栏下方一小块
  // 矩形，浮在 aiView 之上，网页几何完全不动。
  securityView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "security-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: IS_DEV
    }
  });
  try { securityView.setBackgroundColor("#00000000"); } catch (e) {}
  securityView.setVisible(false);
  mainWindow.contentView.addChildView(securityView);
  securityView.webContents.loadFile(path.join(__dirname, "security.html"));
  // 本地浮层永远不需要跳转或开新窗口：关掉，免得将来有人往里面塞链接。
  securityView.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  securityView.webContents.on("will-navigate", (e) => e.preventDefault());
  securityView.webContents.on("did-finish-load", () => {
    if (securityOpen) pushSecurityState();
  });

  function layoutView() {
    if (!mainWindow || mainWindow.isDestroyed() || !aiView) return;
    const [w, h] = mainWindow.getContentSize();
    // 壳层的设置/安全面板是 shell.html 里的 DOM，而 aiView 是盖在它上面的原生视图：
    // 面板从 48px 的顶栏往下长，不腾出这块就永远被网页遮住。腾的方式是横向让位，
    // 让网页缩到面板对面那一侧，跟网页自己重排一次，代价只在开合各一次。
    const inset = viewInset.width ? Math.min(viewInset.width, Math.max(0, w - 480)) : 0;
    aiView.setBounds({
      x: viewInset.side === "left" ? inset : 0,
      y: ADDRESS_BAR_HEIGHT,
      width: Math.max(0, w - inset),
      height: Math.max(0, h - ADDRESS_BAR_HEIGHT)
    });
  }
  layoutView();
  layoutViewRef = layoutView;
  mainWindow.on("resize", layoutView);
  mainWindow.on("resize", closeSecurityPanel);
  // 浮层只在本窗口内有效：点网页、换页、窗口尺寸变化都该收起，
  // 否则它会漂在错误的位置上。
  aiView.webContents.on("focus", closeSecurityPanel);
  // 壳层重载后 DOM 里的面板状态全丢了，让位必须一起归零，
  // 否则网页会一直缺着一条再也收不回来的边。
  mainWindow.webContents.on("did-navigate", () => {
    viewInset = { side: null, width: 0 };
    closeSecurityPanel();
    layoutView();
  });

  try { aiView.setBackgroundColor(themeBg()); } catch (e) {}
  aiView.webContents.loadURL(HOME_URL);


  // === 4. probe hook（默认关闭）===
  // probe.js 会 hook 页面所有 XHR 并把整段 AI 回复在页面内存里再攒一份，
  // 而它的产出（__adshield_ai_reply）在 preload 里已经不再消费 ——
  // 常开纯属风险与内存开销。需要研究网络层时用 ADSHIELD_PROBE=1 显式打开。
  if (process.env.ADSHIELD_PROBE === "1") {
    try {
      const PROBE_CODE = fs.readFileSync(path.join(__dirname, "probe.js"), "utf-8");
      aiView.webContents.on("did-finish-load", () => {
        if (!aiView || aiView.webContents.isDestroyed()) return;
        aiView.webContents.executeJavaScript(PROBE_CODE).catch((e) => {
          console.error("[probe] 注入失败:", e.message);
        });
      });
      aiView.webContents.on("console-message", (event, level, message) => {
        if (message && message.indexOf("[probe]") !== -1) console.log("[probe]", message);
      });
    } catch (e) {
      console.error("[probe] 读取 probe.js 失败:", e.message);
    }
  }

  // === 5. DevTools（仅开发模式）===
  if (IS_DEV) {
    const setupF12 = (wc) => {
      wc.on("before-input-event", (event, input) => {
        if (input.key === "F12" && input.type === "keyDown") {
          if (wc.isDevToolsOpened()) wc.closeDevTools();
          else wc.openDevTools({ mode: "detach" });
          event.preventDefault();
        }
      });
    };
    setupF12(mainWindow.webContents);
    setupF12(aiView.webContents);
  }

  // === 6. 状态推送 ===
  function pushShellState(extra) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!aiView || aiView.webContents.isDestroyed()) return;
    const wc = aiView.webContents;
    const hist = wc.navigationHistory;
    const state = Object.assign({
      url: wc.getURL() || HOME_URL,
      canGoBack: hist ? hist.canGoBack() : false,
      canGoForward: hist ? hist.canGoForward() : false
    }, securityInfo(wc.getURL() || HOME_URL), extra || {});
    mainWindow.webContents.send("shell-state", state);
    pushSecurityState();
  }

  aiView.webContents.on("did-start-loading", () => pushShellState({ status: "loading" }));
  aiView.webContents.on("did-stop-loading", () => pushShellState({ status: "ok" }));
  aiView.webContents.on("did-navigate", () => {
    // 换了文档，上一条证书错误不该继续挂着
    certError = null;
    // user CSS 随文档一起失效，key 必须清掉，
    // 否则新文档上会被误判成「已注入过」而永久丢样式
    webCssKey = null;
    pushShellState();
  });

  // 主题注入：dom-ready 尽早生效（减少原色闪现）；
  // did-finish-load 只在漏注时补一次，避免每次导航两趟 insertCSS 往返
  aiView.webContents.on("dom-ready", () => { applyWebTheme(true); });
  aiView.webContents.on("did-finish-load", () => { applyWebTheme(false); });
  aiView.webContents.on("did-navigate-in-page", () => pushShellState());

  // 不 preventDefault —— Chromium 默认就会拒绝加载出错证书的页面，这里只把
  // 真实原因取下来给地址栏面板显示。以前那一行「证书有效」是写死在 HTML 里的，
  // 无论访问什么站点、无论证书怎样都显示，属于假信息。
  aiView.webContents.on("certificate-error", (e, url, error, cert) => {
    certError = {
      url,
      error: String(error || "unknown"),
      issuer: (cert && cert.issuerName) ? String(cert.issuerName) : "",
      subject: (cert && cert.subjectName) ? String(cert.subjectName) : "",
      expired: !!(cert && cert.expired)
    };
    console.error("[shell] 证书错误:", error, url);
    pushShellState({ status: "error" });
  });
  aiView.webContents.on("did-fail-load", (e, code, desc) => {
    pushShellState({ status: "error" });
    console.error("[shell] 页面加载失败:", code, desc);
  });

  // 壳页面加载完后推一次，确保地址栏有初始值
  mainWindow.webContents.on("did-finish-load", () => {
    setTimeout(() => pushShellState({ status: "ok" }), 200);
  });

  // === 7. 壳页面导航 IPC ===
  const goBack = () => {
    const wc = aiView.webContents;
    if (wc.navigationHistory) wc.navigationHistory.goBack(); else wc.goBack();
  };
  const goForward = () => {
    const wc = aiView.webContents;
    if (wc.navigationHistory) wc.navigationHistory.goForward(); else wc.goForward();
  };
  const shellHandlers = {
    "shell-back": (e) => { if (senderIsShell(e) && aiView && !aiView.webContents.isDestroyed()) goBack(); },
    "shell-forward": (e) => { if (senderIsShell(e) && aiView && !aiView.webContents.isDestroyed()) goForward(); },
    "shell-reload": (e) => { if (senderIsShell(e) && aiView && !aiView.webContents.isDestroyed()) aiView.webContents.reload(); },
    "shell-home": (e) => { if (senderIsShell(e) && aiView && !aiView.webContents.isDestroyed()) aiView.webContents.loadURL(HOME_URL); }
  };
  // createWindow 可能被调用多次（activate / 窗口重建），先清掉旧监听避免叠加
  Object.keys(shellHandlers).forEach((channel) => {
    ipcMain.removeAllListeners(channel);
    ipcMain.on(channel, shellHandlers[channel]);
  });

  // === 8. 首次加载完成才显示（避免白屏）===
  mainWindow.once("ready-to-show", () => { mainWindow.show(); });

  // === 9. 保存窗口状态 ===
  mainWindow.on("resize", saveWindowStateDebounced);
  mainWindow.on("move", saveWindowStateDebounced);
  mainWindow.on("closed", () => { mainWindow = null; });

  // === 10. 关闭时最小化到托盘 ===
  // 没有托盘就没有第二条入口，此时隐藏窗口等于把应用变成杀不掉的后台进程
  mainWindow.on("close", (e) => {
    if (!isQuitting && trayAvailable) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  // === 11. 外部链接用默认浏览器打开 ===
  // 新窗口（target=_blank / window.open）仍然交给系统浏览器：应用内只有一个
  // aiView，要开多窗口得重做布局和注入归属，收益不值。
  // 但协议从「只 https」放宽到 http/https，与地址栏保持一致，
  // 否则 http 站点弹出的链接会被静默丢弃、看起来像点了没反应。
  aiView.webContents.setWindowOpenHandler(({ url }) => {
    let proto = "";
    try { proto = new URL(url).protocol; } catch (e) {}
    if (proto === "https:" || proto === "http:") shell.openExternal(url);
    return { action: "deny" };
  });

  // === 12. 拦截导航 ===
  // 地址栏现在可以浏览任意站点，所以不再把非 DeepSeek 的跳转踢回系统浏览器——
  // 那样点一下站内链接就跳出应用，浏览体验是断的。
  // 仍然只放行 http/https：file: 是本地文件读取，devtools:/chrome:/view-source:
  // 触碰渲染器内部，search-ms:/ms-msdt:/自定义协议等于把系统协议处理器交给网页驱动。
  // 注入能力已按域名自我关闭（见 preload.js 顶部），放开导航不会带来本地执行。
  aiView.webContents.on("will-navigate", (e, url) => {
    let proto = "";
    try { proto = new URL(url).protocol; } catch (e2) {}
    if (proto !== "http:" && proto !== "https:") {
      e.preventDefault();
      console.warn("[Main] 拒绝非 http(s) 导航:", String(url).substring(0, 200));
    }
  });

  // === 13. 锁定窗口标题 ===
  mainWindow.on("page-title-updated", (e) => { e.preventDefault(); });
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    // 兜底：2 秒后还没显示就强制 show
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
        console.log("[Main] 强制显示窗口");
        mainWindow.show();
      }
    }, 2000);
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function sendToShell(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send(channel, payload); } catch (e) {}
  }
}

// ============ 系统托盘 ============
function createTray() {
  try {
    const iconPath = path.join(__dirname, "assets", "icon.ico");
    if (!fs.existsSync(iconPath)) {
      console.error("[Tray] 图标缺失，托盘不可用；关闭窗口将直接退出应用:", iconPath);
      return;
    }

    tray = new Tray(iconPath);
    const menu = Menu.buildFromTemplate([
      { label: "显示 DeepSeek", click: showWindow },
      { label: "重新加载", click: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload(); } },
      { type: "separator" },
      {
        label: "检查更新",
        click: () => {
          autoUpdater.checkForUpdatesAndNotify().then((r) => {
            if (!r || !r.updateInfo || r.updateInfo.version === app.getVersion()) {
              if (Notification.isSupported()) {
                new Notification({ title: "DeepSeek", body: "已是最新版本 v" + app.getVersion() }).show();
              }
            }
          }).catch((e) => {
            console.error("检查更新失败:", e.message);
            if (Notification.isSupported()) {
              new Notification({ title: "检查更新失败", body: e.message || "请检查网络连接" }).show();
            }
          });
        }
      },
      { type: "separator" },
      {
        label: "开机自启",
        type: "checkbox",
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => { app.setLoginItemSettings({ openAtLogin: item.checked }); }
      },
      { type: "separator" },
      {
        label: "退出",
        click: () => { isQuitting = true; app.quit(); }
      }
    ]);
    tray.setToolTip(APP_NAME);
    tray.setContextMenu(menu);
    tray.on("click", showWindow);
    tray.on("double-click", showWindow);
    trayAvailable = true;
  } catch (e) {
    console.error("托盘创建失败:", e);
    trayAvailable = false;
  }
}

// ============ 危险确认弹窗 ============
function showDangerDialog(reasons) {
  return new Promise((resolve) => {
    let dialogWin;
    try {
      dialogWin = new BrowserWindow({
        // mainWindow 可能已经销毁，parent 传 null 比抛异常好
        parent: (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : null,
        modal: !!(mainWindow && !mainWindow.isDestroyed()),
        width: 520,
        height: 480,
        frame: false,
        resizable: false,
        minimizable: false,
        maximizable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        show: false,
        // 与 --bg-canvas 同值，避免弹窗出现时先闪一下白底
        backgroundColor: themeBg(),
        webPreferences: {
          preload: path.join(__dirname, "dialog-preload.js"),
          additionalArguments: ["--dialog-data=" +
            Buffer.from(JSON.stringify({ reasons: reasons })).toString("base64")],
          contextIsolation: true,
          nodeIntegration: false,
          devTools: false
        }
      });
    } catch (e) {
      console.error("[dialog] 创建失败，按拒绝处理:", e.message);
      resolve(false);
      return;
    }

    let responded = false;
    let timer = null;
    function settle(allow) {
      if (responded) return;
      responded = true;
      if (timer) clearTimeout(timer);
      ipcMain.removeListener("dialog-respond", handler);
      resolve(!!allow);
      if (dialogWin && !dialogWin.isDestroyed()) dialogWin.close();
    }
    const handler = (event, result) => {
      // 只接受这个弹窗自己的回复，别的 webContents 发来的 dialog-respond 一律忽略
      if (event.sender !== dialogWin.webContents) return;
      settle(!!(result && result.allow));
    };
    ipcMain.on("dialog-respond", handler);

    // 弹窗可能因为父窗口被隐藏而看不见；无人应答就把这个 invoke 永久挂住，
    // 所以超时按「拒绝」处理，让 Agent 循环能拿到明确结果继续走。
    timer = setTimeout(() => {
      console.warn("[dialog] 无人应答，超时按拒绝处理");
      settle(false);
    }, DIALOG_TIMEOUT_MS);

    dialogWin.on("closed", () => {
      if (!responded) {
        responded = true;
        if (timer) clearTimeout(timer);
        ipcMain.removeListener("dialog-respond", handler);
        resolve(false);
      }
    });

    // 深色段挂在 [data-theme="dark"] 上。弹窗是独立窗口，拿不到 shell 那条主题
    // IPC，所以把已解析好的档位随 URL query 一起交给页面 —— 不开新通道、不动 preload。
    dialogWin.loadFile(path.join(__dirname, "dialog.html"), { query: { theme: resolvedTheme } });
    dialogWin.once("ready-to-show", () => {
      try {
        dialogWin.show();
        dialogWin.focus();
      } catch (e) {}
    });
  });
}

// ============ cuckoo IPC ============
ipcMain.handle("check-cuckoo", async (event, payload) => {
  try {
    assertAiViewSender(event);
  } catch (e) {
    return { level: "forbidden", reasons: [e.message], items: [] };
  }
  try {
    return security.checkCode((payload && payload.code) || "", { workspace: currentWorkspace });
  } catch (e) {
    console.error("[check-cuckoo] 检测失败，fail-closed:", e.message);
    return { level: "forbidden", reasons: ["安全检查失败: " + e.message], items: [] };
  }
});

ipcMain.handle("execute-cuckoo", async (event, payload) => {
  try {
    assertAiViewSender(event);
  } catch (e) {
    return { status: "cancelled", ok: false, error: e.message, logs: [] };
  }

  const code = (payload && payload.code) || "";
  const blockId = (payload && payload.blockId) || "";

  // ★ 主进程自己重新判级，不信任 renderer 传上来的 reasons/level
  let check;
  try {
    check = security.checkCode(code, { workspace: currentWorkspace });
  } catch (e) {
    console.error("[execute-cuckoo] 安全检查异常，fail-closed:", e.message);
    return { status: "cancelled", ok: false, error: "安全检查失败", logs: [] };
  }

  if (check.level === "forbidden") {
    return { status: "cancelled", ok: false, error: "禁止的命令", reasons: check.reasons, logs: [] };
  }
  if (check.level === "dangerous") {
    const allowed = await showDangerDialog(check.reasons || []);
    if (!allowed) return { status: "cancelled", ok: false, logs: [] };
  }

  try {
    const result = await executeInWorker(code);

    let outputText;
    let hasOutput = true;
    if (result.ok) {
      outputText = typeof result.result === "string" ? result.result : "";
      if (!outputText.trim()) { outputText = ""; hasOutput = false; }
    } else {
      outputText = formatExecutionError(result, code);
    }

    // 结果会自动回传给 DeepSeek 云端，先过一遍凭据脱敏
    if (hasOutput) outputText = redactSecrets(outputText);

    console.log("[cuckoo] block=" + blockId + " ok=" + result.ok +
      " 输出长度=" + outputText.length + " hasOutput=" + hasOutput);

    return {
      ok: !!result.ok,
      result: outputText,
      error: result.error,
      hasOutput: hasOutput,
      level: check.level,
      logs: (result.logs || []).map(redactSecrets)
    };
  } catch (e) {
    console.error("[cuckoo] 执行异常:", e.message);
    return { ok: false, error: e.message, hasOutput: false, logs: (e.logs || []).map(redactSecrets) };
  }
});

// ============ 工作区 IPC ============
ipcMain.handle("get-workspace", (event) => {
  try { assertTrustedSender(event); } catch (e) { return { path: null, error: e.message }; }
  return { path: currentWorkspace };
});

ipcMain.handle("select-workspace", async (event) => {
  try { assertTrustedSender(event); } catch (e) { return { path: null, error: e.message }; }
  if (!mainWindow || mainWindow.isDestroyed()) return { path: currentWorkspace || null };

  const result = await dialog.showOpenDialog(mainWindow, {
    title: "请选择要分析的项目目录",
    properties: ["openDirectory"],
    defaultPath: currentWorkspace || app.getPath("documents")
  });
  if (result.canceled || result.filePaths.length === 0) return { path: currentWorkspace || null };

  currentWorkspace = result.filePaths[0];
  try {
    const tmp = WORKSPACE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ workspace: currentWorkspace }), "utf-8");
    fs.renameSync(tmp, WORKSPACE_FILE);
  } catch (e) {
    console.error("保存工作区失败:", e);
  }
  return { path: currentWorkspace };
});

// ============ 设置页：系统能力 ============
// 这些都能改本机状态，一律只认壳层。远程页面即使拿到 channel 名也发不进来。
ipcMain.handle("get-app-info", (event) => {
  if (!senderIsShell(event)) return { version: "", electron: "" };
  return { version: app.getVersion(), electron: process.versions.electron };
});

ipcMain.handle("open-workspace-folder", async (event) => {
  if (!senderIsShell(event)) return { ok: false, error: "非法的 IPC 来源" };
  if (!currentWorkspace) return { ok: false, error: "尚未选择工作区" };
  const err = await shell.openPath(currentWorkspace);
  return err ? { ok: false, error: err } : { ok: true };
});

ipcMain.handle("get-login-item", (event) => {
  if (!senderIsShell(event)) return { openAtLogin: false };
  try { return { openAtLogin: app.getLoginItemSettings().openAtLogin }; } catch (e) { return { openAtLogin: false }; }
});

ipcMain.handle("set-login-item", (event, enabled) => {
  if (!senderIsShell(event)) return { ok: false, error: "非法的 IPC 来源" };
  try {
    app.setLoginItemSettings({ openAtLogin: !!enabled });
    return { ok: true, openAtLogin: app.getLoginItemSettings().openAtLogin };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle("clear-cache", async (event) => {
  if (!senderIsShell(event)) return { ok: false, error: "非法的 IPC 来源" };
  try {
    await session.defaultSession.clearCache();
    if (aiView && !aiView.webContents.isDestroyed()) aiView.webContents.reload();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ============ 壳页面状态查询 ============
ipcMain.handle("get-shell-state", (event) => {
  try { assertTrustedSender(event); } catch (e) { return { url: HOME_URL, canGoBack: false, canGoForward: false }; }
  if (!aiView || aiView.webContents.isDestroyed()) {
    return { url: HOME_URL, canGoBack: false, canGoForward: false };
  }
  try {
    const hist = aiView.webContents.navigationHistory;
    const u = aiView.webContents.getURL() || HOME_URL;
    return Object.assign({
      url: u,
      canGoBack: hist ? hist.canGoBack() : false,
      canGoForward: hist ? hist.canGoForward() : false
    }, securityInfo(u));
  } catch (e) {
    return { url: HOME_URL, canGoBack: false, canGoForward: false };
  }
});

ipcMain.handle("shell-navigate", async (event, url) => {
  try { assertTrustedSender(event); } catch (e) { return { ok: false, error: e.message }; }
  if (typeof url !== "string" || !url.trim()) return { ok: false, error: "URL 为空" };

  let targetUrl = url.trim();
  if (!/^https?:\/\//i.test(targetUrl)) targetUrl = "https://" + targetUrl;

  // 域名不再限制（地址栏就是拿来浏览任意站点的），但协议必须限制：
  //   file:            等于让网页驱动本地文件读取
  //   devtools:/chrome:/view-source:  触碰渲染器内部
  //   javascript:      在页面上下文执行任意脚本
  //   search-ms:/ms-msdt:/自定义协议   系统协议处理器利用
  // 注入能力已按域名自我关闭（见 preload.js 顶部），所以这里放开不会带来本地执行。
  let proto = "";
  try { proto = new URL(targetUrl).protocol; } catch (e2) {
    return { ok: false, error: "URL 无法解析" };
  }
  if (proto !== "https:" && proto !== "http:") {
    return { ok: false, error: "只允许 http/https 协议" };
  }
  if (!aiView || aiView.webContents.isDestroyed()) return { ok: false, error: "窗口未就绪" };

  console.log("[Main] 正在跳转到:", targetUrl);
  try {
    await aiView.webContents.loadURL(targetUrl);
    return { ok: true };
  } catch (err) {
    console.error("[Main] 跳转报错:", err.message);
    return { ok: false, error: err.message };
  }
});

// ============ 主题 IPC ============
ipcMain.handle("get-theme", () => ({ theme: currentTheme, resolved: resolvedTheme }));

ipcMain.handle("set-theme", (event, theme) => {
  try { assertTrustedSender(event); } catch (e) { return { ok: false, error: e.message }; }
  if (!["light", "dark", "system"].includes(theme)) return { ok: false, error: "非法主题" };
  currentTheme = theme;
  resolvedTheme = theme === "system"
    ? (nativeTheme.shouldUseDarkColors ? "dark" : "light")
    : theme;
  saveThemeConfig();
  broadcastTheme();
  return { ok: true };
});

nativeTheme.on("updated", () => {
  if (currentTheme !== "system") return;
  const next = nativeTheme.shouldUseDarkColors ? "dark" : "light";
  if (next !== resolvedTheme) {
    resolvedTheme = next;
    broadcastTheme();
  }
});

// preload 跑在 sandbox 里，不能 require("./package.json")，元信息只能由主进程给。
// 同步应答是因为 preload 在脚本顶层就要拿到它（晚一步就来不及暴露给页面）。
ipcMain.on("get-preload-meta", (event) => {
  const ok = senderIsAiView(event) || senderIsShell(event);
  event.returnValue = ok
    ? { version: app.getVersion(), platform: process.platform }
    : { version: "", platform: "" };
});

// 壳层面板展开时申请让位：side = "left" | "right" | "none"，width 像素。
// 改的是原生视图的几何，只有壳层自己能发起，且宽度设了硬上限。
ipcMain.on("set-panel-inset", (event, side, width) => {
  // 收紧到只认壳层：这条会改原生视图几何，远程页面不该有任何途径碰它
  if (!senderIsShell(event)) return;
  const w = Number(width);
  if (!Number.isFinite(w) || w < 0 || w > 720) return;
  viewInset = (side === "left" || side === "right") && w > 0 ? { side, width: w } : { side: null, width: 0 };
  if (layoutViewRef) layoutViewRef();
});

// 连接信息浮层：壳层只发「开/关」与锚点坐标，几何由主进程算，
// 这样远程页面没有任何入口能移动或隐藏原生层。
ipcMain.on("toggle-security-panel", (event, anchorX) => {
  if (!senderIsShell(event)) return;
  if (securityOpen) closeSecurityPanel();
  else openSecurityPanel(anchorX);
});
ipcMain.on("close-security-panel", (event) => {
  if (!senderIsShell(event) && !senderIsSecurityView(event)) return;
  closeSecurityPanel();
});

// ============ GLM API Key 安全存储 ============
// call-glm 每条消息都要拿一次 apiKey，没必要跟着每次做磁盘 IO + DPAPI 解密。
// 唯一写入方是 glm-set-config，它在 renameSync 之后把缓存清掉。
let glmConfigCache = null;
function loadGlmConfig() {
  if (!glmConfigCache) glmConfigCache = readGlmConfigFromDisk();
  return glmConfigCache;
}

function readGlmConfigFromDisk() {
  const defaults = { apiKey: "", model: "glm-4-air", temperature: 0.7, maxTokens: 1024, systemPrompt: "" };
  try {
    if (!fs.existsSync(GLM_CONFIG_FILE)) return defaults;
    const raw = JSON.parse(fs.readFileSync(GLM_CONFIG_FILE, "utf-8"));

    let apiKey = "";
    if (raw.apiKey) {
      if (raw.encrypted) {
        if (safeStorage.isEncryptionAvailable()) {
          try {
            apiKey = safeStorage.decryptString(Buffer.from(raw.apiKey, "base64"));
          } catch (e) {
            console.error("[glm-config] 解密失败:", e.message);
            apiKey = "";
          }
        }
      } else {
        apiKey = String(raw.apiKey);
      }
    }
    return {
      apiKey: apiKey,
      model: raw.model || defaults.model,
      temperature: (typeof raw.temperature === "number" && isFinite(raw.temperature)) ? raw.temperature : defaults.temperature,
      maxTokens: (typeof raw.maxTokens === "number" && raw.maxTokens > 0) ? raw.maxTokens : defaults.maxTokens,
      systemPrompt: raw.systemPrompt || defaults.systemPrompt
    };
  } catch (e) {
    console.error("[glm-config] 读取失败:", e.message);
    return defaults;
  }
}

ipcMain.handle("glm-get-config", (event) => {
  try { assertAiViewSender(event); } catch (e) { return { hasApiKey: false, error: e.message }; }
  const cfg = loadGlmConfig();
  return {
    hasApiKey: !!cfg.apiKey,
    model: cfg.model,
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
    systemPrompt: cfg.systemPrompt,
    // 让 UI 能明确告诉用户「Key 是明文存的」，而不是只在主进程日志里 warn 一句
    encrypted: safeStorage.isEncryptionAvailable()
  };
});

ipcMain.handle("glm-set-config", (event, config) => {
  try { assertAiViewSender(event); } catch (e) { return { ok: false, error: e.message }; }

  const rawApiKey = String((config && config.apiKey) || "").trim();
  const wantClear = config && config.clearApiKey === true;
  // 界面上 API Key 已存在时显示的是占位掩码，用户没动它就提交 → 沿用旧值。
  // 想删掉已存的 Key 必须显式带 clearApiKey，否则永远清不掉。
  const apiKey = wantClear ? "" : (rawApiKey || loadGlmConfig().apiKey);
  if (!apiKey && !wantClear) return { ok: false, error: "API Key 不能为空" };
  const model = String((config && config.model) || "glm-4-air").trim() || "glm-4-air";

  const tRaw = Number(config && config.temperature);
  const temperature = (isFinite(tRaw) && tRaw >= 0 && tRaw <= 2) ? tRaw : 0.7;

  const mtRaw = Number(config && config.maxTokens);
  const maxTokens = (isFinite(mtRaw) && mtRaw >= 256 && mtRaw <= 8192) ? Math.round(mtRaw) : 1024;

  const systemPrompt = String((config && config.systemPrompt) || "").trim().substring(0, 8000);

  const encrypted = safeStorage.isEncryptionAvailable();
  if (!encrypted) {
    console.warn("[glm-config] safeStorage 不可用，API Key 将以明文存储");
  }

  try {
    const payload = encrypted
      ? { apiKey: safeStorage.encryptString(apiKey).toString("base64"), encrypted: true }
      : { apiKey: apiKey, encrypted: false };
    Object.assign(payload, { model, temperature, maxTokens, systemPrompt });

    const tmp = GLM_CONFIG_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(payload), "utf-8");
    fs.renameSync(tmp, GLM_CONFIG_FILE);
    glmConfigCache = null;
    return { ok: true, encrypted: encrypted };
  } catch (e) {
    console.error("[glm-config] 保存失败:", e.message);
    return { ok: false, error: e.message };
  }
});

// ============ GLM 流式转发（带重试）============
ipcMain.handle("call-glm", async (event, args) => {
  try { assertAiViewSender(event); } catch (e) { return { ok: false, error: e.message }; }

  const { messages, model, temperature, maxTokens, systemPrompt, reqId } = args || {};
  const apiKey = loadGlmConfig().apiKey;
  if (!apiKey) return { ok: false, error: "未配置 API Key" };
  if (!Array.isArray(messages) || messages.length === 0) return { ok: false, error: "消息为空" };

  const finalMessages = [
    {
      role: "system",
      content: systemPrompt || "你正在辅助用户进行 AI 协作。请直接、专业、简洁地回应用户的问题。"
    }
  ].concat(
    messages.slice(-40).map((m) => ({
      role: m && m.role === "assistant" ? "assistant" : "user",
      content: String((m && m.content) || "").substring(0, 32000)
    }))
  );

  const rid = reqId || ("r" + Date.now());
  const sender = event.sender;
  function safeSend(channel, payload) {
    try {
      if (sender && !sender.isDestroyed()) sender.send(channel, payload);
    } catch (e) {
      console.warn("[call-glm] send 失败:", channel, e.message);
    }
  }

  return new Promise((resolve) => {
    let retries = 0;
    const maxRetries = 3;
    let settled = false;
    function finish(result) {
      if (settled) return;
      settled = true;
      resolve(result);
    }

    function doRequest() {
      const data = JSON.stringify({
        model: model || "glm-4-air",
        messages: finalMessages,
        temperature: (typeof temperature === "number" && isFinite(temperature)) ? temperature : 0.7,
        max_tokens: (typeof maxTokens === "number" && maxTokens > 0) ? maxTokens : 1024,
        stream: true
      });

      const req = https.request({
        hostname: "open.bigmodel.cn",
        path: "/api/paas/v4/chat/completions",
        method: "POST",
        headers: {
          "Authorization": "Bearer " + apiKey,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data)
        }
      }, (res) => {
        if (res.statusCode !== 200) {
          // TCP 分片不保证落在 UTF-8 字符边界，必须用 StringDecoder，
          // 直接 chunk.toString() 会把中文切成乱码替换符
          const errDecoder = new StringDecoder("utf8");
          const errChunks = [];
          let errLen = 0;
          res.on("data", (c) => {
            if (errLen >= 8192) return;
            errChunks.push(c);
            errLen += c.length;
          });
          res.on("end", () => {
            const errBody = errChunks.map((c) => errDecoder.write(c)).join("") + errDecoder.end();
            if ((res.statusCode === 429 || res.statusCode >= 500) && retries < maxRetries) {
              retries++;
              const delay = Math.min(1000 * Math.pow(2, retries), 5000);
              safeSend("glm-stream-retry", { reqId: rid, attempt: retries, max: maxRetries, delay: delay });
              setTimeout(doRequest, delay);
            } else {
              const msg = "HTTP " + res.statusCode + ": " + errBody.substring(0, 2000);
              safeSend("glm-stream-error", { reqId: rid, error: msg });
              finish({ ok: false, error: msg });
            }
          });
          res.on("error", () => {});
          return;
        }

        const decoder = new StringDecoder("utf8");
        let buffer = "";

        function processLine(line) {
          if (!line.startsWith("data: ")) return;
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") return;
          try {
            const json = JSON.parse(payload);
            const delta = json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content;
            if (delta) safeSend("glm-stream-chunk", { reqId: rid, delta: delta });
          } catch (e) { /* 半截 JSON，跳过 */ }
        }

        res.on("data", (chunk) => {
          buffer += decoder.write(chunk);
          if (buffer.length > 1048576) {
            console.warn("[call-glm] buffer 超限，丢弃已累积内容");
            buffer = "";
            return;
          }
          const blocks = buffer.split("\n\n");
          buffer = blocks.pop();
          for (const block of blocks) {
            for (const line of block.split("\n")) processLine(line);
          }
        });

        res.on("end", () => {
          buffer += decoder.end();
          if (buffer) {
            for (const line of buffer.split("\n")) processLine(line);
            buffer = "";
          }
          safeSend("glm-stream-end", { reqId: rid });
          finish({ ok: true });
        });

        res.on("error", (e) => {
          console.error("[call-glm] 流式响应错误:", e.message);
          safeSend("glm-stream-error", { reqId: rid, error: e.message });
          finish({ ok: false, error: e.message });
        });
      });

      req.on("error", (e) => {
        if (retries < maxRetries) {
          retries++;
          const delay = Math.min(1000 * Math.pow(2, retries), 5000);
          safeSend("glm-stream-retry", { reqId: rid, attempt: retries, max: maxRetries, delay: delay });
          setTimeout(doRequest, delay);
        } else {
          safeSend("glm-stream-error", { reqId: rid, error: e.message });
          finish({ ok: false, error: e.message });
        }
      });

      req.setTimeout(60000, () => { req.destroy(new Error("请求超时")); });
      req.write(data);
      req.end();
    }

    doRequest();
  });
});

// ============ 检查更新 IPC ============
ipcMain.handle("check-update", async (event) => {
  try { assertTrustedSender(event); } catch (e) { return { ok: false, error: e.message }; }
  try {
    const result = await autoUpdater.checkForUpdates();
    if (!result || !result.updateInfo) {
      sendToShell("update-status", { status: "error", message: "未获取到更新信息" });
      return { ok: false };
    }
    const latest = result.updateInfo.version;
    if (latest === app.getVersion()) {
      sendToShell("update-status", { status: "latest" });
    } else {
      sendToShell("update-status", { status: "available", message: "发现新版本 v" + latest });
    }
    return { ok: true };
  } catch (e) {
    sendToShell("update-status", { status: "error", message: "检查失败" });
    return { ok: false, error: e.message };
  }
});

// ============ 自动更新 ============
function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("update-available", (info) => {
    console.log("[Update] 有新版本:", info.version);
    if (Notification.isSupported()) {
      new Notification({
        title: "DeepSeek 有新版本",
        body: "v" + info.version + " 正在后台下载..."
      }).show();
    }
  });

  autoUpdater.on("update-not-available", () => { console.log("[Update] 已是最新版本"); });
  autoUpdater.on("download-progress", (p) => { console.log("[Update] 下载进度:", Math.round(p.percent) + "%"); });

  autoUpdater.on("update-downloaded", (info) => {
    console.log("[Update] 下载完成:", info.version);
    const opts = {
      type: "info",
      title: "更新就绪",
      message: "新版本 v" + info.version + " 已下载完成",
      detail: "重启应用以完成安装。",
      buttons: ["稍后", "立即重启"],
      defaultId: 1,
      cancelId: 0
    };
    // 主窗口可能已经销毁：showMessageBoxSync(null, opts) 会抛
    // "Invalid arguments"，必须换成不带窗口的重载。
    let choice = 0;
    try {
      const parent = (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : null;
      choice = parent ? dialog.showMessageBoxSync(parent, opts) : dialog.showMessageBoxSync(opts);
    } catch (e) {
      console.error("[Update] 弹窗失败:", e.message);
      return;
    }
    if (choice === 1) {
      isQuitting = true;
      autoUpdater.quitAndInstall();
    }
  });

  autoUpdater.on("error", (err) => { console.error("[Update] 错误:", err.message); });

  // 启动后延迟 10 秒检查，避免和首屏加载抢带宽
  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify().catch((e) => console.error("[Update] 检查失败:", e.message));
  }, 10000);

  setInterval(() => {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  }, 4 * 60 * 60 * 1000);
}

// ============ 启动 ============
app.on("second-instance", () => { showWindow(); });

app.whenReady().then(async () => {
  loadThemeConfig();
  // 必须在任何页面加载前把 themeSource 定下来：网页深色段走的是
  // prefers-color-scheme，它跟随 nativeTheme 而不是我们的 theme.json。
  // 少这一次调用，冷启动就会出现"深壳浅页"（上次只在本轮切主题时设过）。
  applyWindowTheme();

  Menu.setApplicationMenu(null);

  // 必须在任何页面加载之前装好，否则首个站点的权限请求会走默认弹窗
  hardenPermissions(session.defaultSession);

  createWindow();
  createTray();

  // 显卡信息只用于打一行日志，不该挡在首屏前面。
  // 原来这里 await，窗口创建被一次 GPU 查询串行拖住。
  app.getGPUInfo("basic").then((gpuInfo) => {
    const dev = gpuInfo && gpuInfo.gpuDevice && gpuInfo.gpuDevice[0];
    if (dev) console.log("[DeepSeek GPU] 当前使用的显卡: " + dev.deviceString);
  }).catch(() => {});

  const okShortcut = globalShortcut.register("CommandOrControl+Shift+D", showWindow);
  if (!okShortcut) console.warn("[Main] 全局快捷键 Ctrl+Shift+D 注册失败（可能已被其他程序占用）");

  // 自动更新仅打包后启用
  if (!IS_DEV && !process.defaultApp) setupAutoUpdater();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showWindow();
  });
});

// Windows/Linux 上关掉窗口后保持托盘常驻，不退出。
// 但托盘不可用时必须退出，否则只剩一个看不见、也杀不掉的后台进程。
app.on("window-all-closed", () => {
  if (!trayAvailable) app.quit();
});

app.on("before-quit", () => {
  isQuitting = true;
  if (saveStateTimer) clearTimeout(saveStateTimer);
  saveWindowState();
  killWorker();
  if (app.isReady()) {
    try { globalShortcut.unregisterAll(); } catch (e) {}
  }
});
