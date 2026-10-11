const { app, BrowserWindow, Tray, Menu, globalShortcut, Notification, shell, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const { autoUpdater } = require("electron-updater");

const URL = "https://chat.deepseek.com/";
const APP_NAME = "DeepSeek";

// 配置文件（记住窗口大小/位置）
const CONFIG_DIR = path.join(app.getPath("userData"));
const CONFIG_FILE = path.join(CONFIG_DIR, "window-state.json");

let mainWindow = null;
let tray = null;
let isQuitting = false;

// 读取窗口状态
function loadWindowState() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    }
  } catch (e) {}
  return { width: 1280, height: 800 };
}

// 保存窗口状态
function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bounds = mainWindow.getBounds();
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(bounds));
  } catch (e) {}
}

// 创建主窗口
function createWindow() {
  const state = loadWindowState();

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
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      devTools: true
    },
    backgroundColor: "#ffffff",
    show: false,
    autoHideMenuBar: true
  });

  mainWindow.loadURL(URL);

  // ★ P1：注入网络探测 hook（在 main world 抓 fetch/XHR）
  const PROBE_CODE = fs.readFileSync(path.join(__dirname, "probe.js"), "utf-8");

  // 每次页面加载完成 → 注入
  mainWindow.webContents.on("did-finish-load", () => {
    mainWindow.webContents.executeJavaScript(PROBE_CODE).catch((e) => {
      console.error("[probe] 注入失败:", e.message);
    });
  });

  // 接收 hook 通过 postMessage 抛出的数据
  mainWindow.webContents.on("console-message", (event, level, message) => {
    if (message && message.indexOf("[probe]") !== -1) {
      console.log("[probe]", message);
    }
  });

  // F12 打开 DevTools
  mainWindow.webContents.on("before-input-event", (e, input) => {
    if (input.key === "F12" && input.type === "keyDown") {
      mainWindow.webContents.openDevTools({ mode: "detach" });
      e.preventDefault();
    }
  });

  // 首次加载完成才显示（避免白屏）
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  // 保存窗口状态
  mainWindow.on("resize", saveWindowState);
  mainWindow.on("move", saveWindowState);

  // 关闭时最小化到托盘（不退出）
  mainWindow.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  // 外部链接用默认浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  // 拦截导航（防止跳到非 DeepSeek 域名）
  mainWindow.webContents.on("will-navigate", (e, url) => {
    if (!url.includes("deepseek.com")) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  // 页面标题变化时同步窗口标题
  mainWindow.on("page-title-updated", (e) => {
    e.preventDefault();
  });
}

// 显示主窗口
function showWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// 创建系统托盘
function createTray() {
  try {
    const iconPath = path.join(__dirname, "assets", "icon.ico");
    if (!fs.existsSync(iconPath)) return;

    tray = new Tray(iconPath);
    const menu = Menu.buildFromTemplate([
      { label: "显示 DeepSeek", click: showWindow },
      { label: "重新加载", click: () => mainWindow && mainWindow.reload() },
      { type: "separator" },
      {
        label: "检查更新",
        click: () => {
          try {
            autoUpdater.checkForUpdatesAndNotify().then((r) => {
              if (!r || !r.updateInfo || r.updateInfo.version === app.getVersion()) {
                if (Notification.isSupported()) {
                  new Notification({
                    title: "DeepSeek",
                    body: "已是最新版本 v" + app.getVersion()
                  }).show();
                }
              }
            }).catch((e) => {
              console.error("检查更新失败:", e.message);
              if (Notification.isSupported()) {
                new Notification({
                  title: "检查更新失败",
                  body: e.message || "请检查网络连接"
                }).show();
              }
            });
          } catch (e) {}
        }
      },
      { type: "separator" },
      {
        label: "开机自启",
        type: "checkbox",
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => {
          app.setLoginItemSettings({ openAtLogin: item.checked });
        }
      },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ]);
    tray.setToolTip(APP_NAME);
    tray.setContextMenu(menu);
    tray.on("click", showWindow);
    tray.on("double-click", showWindow);
  } catch (e) {
    console.error("托盘创建失败:", e);
  }
}

// ============ cuckoo 代码执行 IPC ============
const { ipcMain } = require("electron");

// ============ 格式化详细错误信息（供 AI 自动修正）============
function formatExecutionError(result, rawCode) {
  var lines = [];
  lines.push("❌ 代码执行失败");
  lines.push("");
  lines.push("【错误类型】" + (result.errorType || "Error"));
  lines.push("【错误信息】" + (result.error || "未知错误"));
  if (result.errorLine) {
    lines.push("【出错位置】第 " + result.errorLine + " 行" + (result.errorColumn ? " 第 " + result.errorColumn + " 列" : ""));
  }
  lines.push("");
  lines.push("【你的代码】");
  lines.push("```javascript");
  lines.push(rawCode || result.rawCode || "(空)");
  lines.push("```");
  if (result.errorStack) {
    lines.push("");
    lines.push("【错误堆栈】");
    lines.push(result.errorStack);
  }
  lines.push("");
  lines.push("请检查并修正上述代码后重新输出。常见原因：");
  lines.push("1. 全角标点（中文引号/括号）→ 必须改成半角 () ; : , 和英文引号");
  lines.push("2. 忘记 return");
  lines.push("3. 括号/引号不配对");
  lines.push("4. 使用了沙箱不允许的 API（require、process、fs、fetch）");
  lines.push("5. 相对路径错误（应使用绝对路径或基于用户主目录）");
  return lines.join("\n");
}

const security = require("./security.js");
const runner = require("./runner.js");

// 检查代码危险程度
ipcMain.handle("check-cuckoo", async (event, payload) => {
  try {
    const code = payload && payload.code || "";
    return security.checkCode(code);
  } catch (e) {
    return { level: "safe", reasons: [], error: e.message };
  }
});

// 执行 cuckoo 代码
ipcMain.handle("execute-cuckoo", async (event, payload) => {
  const code = payload && payload.code || "";
  const blockId = payload && payload.blockId || "";
  const reasons = payload && payload.reasons || [];

  // 危险命令 → 弹 dialog 确认
  if (reasons && reasons.length > 0) {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: "warning",
      title: "⚠️ 危险操作确认",
      message: "AI 请求执行以下敏感操作：",
      detail: reasons.join("\n\n") + "\n\n是否继续执行？",
      buttons: ["取消", "允许执行"],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
    if (choice !== 1) {
      return { status: "cancelled", ok: false };
    }
  }

  // 执行代码
  const logs = [];
  try {
    const result = await runner.runCuckooCode(code, {
      onLog: (msg) => {
        logs.push(msg);
        console.log("[cuckoo]", msg);
      }
    });

    // 把执行结果填入 DeepSeek 输入框（可选，暂时只返回）
    let outputText;
    let hasOutput = true;
    if (result.ok) {
      if (typeof result.result === "string") {
        outputText = result.result;
      } else if (result.result === undefined || result.result === null) {
        outputText = "";
        hasOutput = false;
      } else {
        try { outputText = JSON.stringify(result.result); } catch (e) { outputText = String(result.result); }
      }
      // 空字符串也算无输出
      if (!outputText || outputText.trim() === "") {
        outputText = "";
        hasOutput = false;
      }
    } else {
      outputText = formatExecutionError(result, code);
      hasOutput = true;
    }

    console.log("[cuckoo] 执行结果长度:", outputText.length, "| hasOutput:", hasOutput);

    // 无输出时跳过注入
    if (hasOutput) {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          const safeOutput = String(outputText).replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$");
          await mainWindow.webContents.executeJavaScript(
            "(function(){" +
            "  var ta = document.querySelector('textarea');" +
            "  if (!ta) return { ok: false };" +
            "  var text = '执行结果：\\n' + " + JSON.stringify(outputText) + ";" +
            "  var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;" +
            "  setter.call(ta, text);" +
            "  ta.dispatchEvent(new Event('input', { bubbles: true }));" +
            "  ta.focus();" +
            "  return { ok: true };" +
            "})()"
          );
        }
      } catch (e) {
        console.error("[cuckoo] 填入输入框失败:", e.message);
      }
    } else {
      console.log("[cuckoo] 无输出，跳过注入");
    }

    return {
      ok: result.ok,
      result: result.result,
      error: result.error,
      hasOutput: hasOutput,
      logs: logs
    };
  } catch (e) {
    return { ok: false, error: e.message, logs: logs };
  }
});

// 应用就绪
app.whenReady().then(() => {
  // 隐藏默认菜单栏
  Menu.setApplicationMenu(null);

  createWindow();
  createTray();

  // 全局快捷键 Ctrl+Shift+D 唤起
  globalShortcut.register("CommandOrControl+Shift+D", showWindow);

  // 自动更新（仅打包后启用，开发模式跳过）
  if (!process.defaultApp && !process.env.ELECTRON_DEV) {
    setupAutoUpdater();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      showWindow();
    }
  });
});

// 所有窗口关闭时
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    // Windows/Linux：保持托盘运行
    // 不 quit
  }
});

// ===== 自动更新 =====
function setupAutoUpdater() {
  // 静默下载（不弹窗打扰）
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

  autoUpdater.on("update-not-available", () => {
    console.log("[Update] 已是最新版本");
  });

  autoUpdater.on("download-progress", (progress) => {
    console.log("[Update] 下载进度:", Math.round(progress.percent) + "%");
  });

  autoUpdater.on("update-downloaded", (info) => {
    console.log("[Update] 下载完成:", info.version);
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: "info",
      title: "更新就绪",
      message: "新版本 v" + info.version + " 已下载完成",
      detail: "重启应用以完成安装。",
      buttons: ["稍后", "立即重启"],
      defaultId: 1,
      cancelId: 0
    });
    if (choice === 1) {
      isQuitting = true;
      autoUpdater.quitAndInstall();
    }
  });

  autoUpdater.on("error", (err) => {
    console.error("[Update] 错误:", err.message);
  });

  // 启动后延迟 10 秒检查（避免影响首屏加载）
  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify().catch((e) => {
      console.error("[Update] 检查失败:", e.message);
    });
  }, 10000);

  // 每 4 小时检查一次
  setInterval(() => {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  }, 4 * 60 * 60 * 1000);
}

// 应用退出前清理
app.on("before-quit", () => {
  isQuitting = true;
  saveWindowState();
  // 只有 ready 后才能操作 globalShortcut（避免第二实例退出时崩溃）
  if (app.isReady()) {
    try { globalShortcut.unregisterAll(); } catch (e) {}
  }
});

// 单实例锁
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showWindow();
  });
}
