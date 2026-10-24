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

// dialog.html 假定 reasons 每一项都是字符串并直接调 .match()。只要主进程传来
// 非 string 项，那段渲染就会抛异常，风险详情和删除警告整块消失 —— 弹窗看起来
// 「没有风险」，反而诱导用户点允许。统一转成字符串再暴露。
const safeData = {
  reasons: Array.isArray(dialogData.reasons)
    ? dialogData.reasons.map((r) => String(r)).filter((r) => r.length > 0)
    : []
};

contextBridge.exposeInMainWorld("dialogAPI", {
  data: safeData,
  respond: function(allow) {
    ipcRenderer.send("dialog-respond", { allow: !!allow });
  }
});