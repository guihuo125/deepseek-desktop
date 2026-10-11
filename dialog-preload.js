const { contextBridge, ipcRenderer } = require("electron");

// 从 additionalArguments 读取数据（process.argv 里找 --dialog-data=xxx）
let dialogData = { reasons: [] };
try {
  for (const arg of process.argv) {
    if (arg.startsWith("--dialog-data=")) {
      const b64 = arg.substring("--dialog-data=".length);
      const json = Buffer.from(b64, "base64").toString("utf-8");
      dialogData = JSON.parse(json);
      break;
    }
  }
} catch (e) {
  console.error("[dialog] 解析数据失败:", e.message);
}

contextBridge.exposeInMainWorld("dialogAPI", {
  data: dialogData,
  respond: function(allow) {
    ipcRenderer.send("dialog-respond", { allow: !!allow });
  }
});