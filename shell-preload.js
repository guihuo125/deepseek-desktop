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

  // 检查更新
  checkUpdate: function() { return ipcRenderer.invoke("check-update"); },
  onUpdateStatus: function(cb) { ipcRenderer.on("update-status", function(_e, data) { cb(data); }); },

  // 版本信息
  electronVersion: process.versions.electron
});