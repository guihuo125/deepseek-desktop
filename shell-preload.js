const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("shellAPI", {
  back: function() { ipcRenderer.send("shell-back"); },
  forward: function() { ipcRenderer.send("shell-forward"); },
  reload: function() { ipcRenderer.send("shell-reload"); },
  home: function() { ipcRenderer.send("shell-home"); },
  navigate: function(url) { return ipcRenderer.invoke("shell-navigate", url); },
  onStateChange: function(cb) {
    ipcRenderer.on("shell-state", function(event, state) { cb(state); });
  },
  getShellState: function() { return ipcRenderer.invoke("get-shell-state"); },
  selectWorkspace: function() { return ipcRenderer.invoke("select-workspace"); },
  getWorkspace: function() { return ipcRenderer.invoke("get-workspace"); },

  // 主题
  getTheme: function() { return ipcRenderer.invoke("get-theme"); },
  setTheme: function(theme) { return ipcRenderer.invoke("set-theme", theme); },
  onThemeChange: function(cb) { ipcRenderer.on("theme-changed", function(_e, data) { cb(data); }); },

  // 设置面板展开时申请网页让位（仅设置面板使用；安全浮层是独立视图）
  setPanelInset: function(side, width) { ipcRenderer.send("set-panel-inset", side, width); },

  // 连接信息浮层（独立 WebContentsView）
  toggleSecurityPanel: function(anchorX) { ipcRenderer.send("toggle-security-panel", anchorX); },
  closeSecurityPanel: function() { ipcRenderer.send("close-security-panel"); },
  onSecurityPanelState: function(cb) {
    ipcRenderer.on("security-panel-state", function(_e, open) { cb(open); });
  },

  // 检查更新
  checkUpdate: function() { return ipcRenderer.invoke("check-update"); },
  onUpdateStatus: function(cb) { ipcRenderer.on("update-status", function(_e, data) { cb(data); }); },

  // 设置页用到的系统能力
  getAppInfo: function() { return ipcRenderer.invoke("get-app-info"); },
  openWorkspaceFolder: function() { return ipcRenderer.invoke("open-workspace-folder"); },
  getLoginItem: function() { return ipcRenderer.invoke("get-login-item"); },
  setLoginItem: function(enabled) { return ipcRenderer.invoke("set-login-item", enabled); },
  clearCache: function() { return ipcRenderer.invoke("clear-cache"); },

  // 版本信息
  electronVersion: process.versions.electron
});
