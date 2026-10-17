const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("shellAPI", {
  back: function() { ipcRenderer.send("shell-back"); },
  forward: function() { ipcRenderer.send("shell-forward"); },
  reload: function() { ipcRenderer.send("shell-reload"); },
  home: function() { ipcRenderer.send("shell-home"); },
  onStateChange: function(cb) {
    ipcRenderer.on("shell-state", function(event, state) { cb(state); });
  },
  selectWorkspace: function() { return ipcRenderer.invoke("select-workspace"); },
  getWorkspace: function() { return ipcRenderer.invoke("get-workspace"); }
});