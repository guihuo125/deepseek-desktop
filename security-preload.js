const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("secAPI", {
  onState: function (cb) { ipcRenderer.on("security-state", function (_e, s) { cb(s); }); },
  onTheme: function (cb) { ipcRenderer.on("theme-changed", function (_e, d) { cb(d); }); },
  onOpen: function (cb) { ipcRenderer.on("security-open", function () { cb(); }); },
  close: function () { ipcRenderer.send("close-security-panel"); },
  getTheme: function () { return ipcRenderer.invoke("get-theme"); }
});
