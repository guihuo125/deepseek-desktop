// cuckoo 执行器的 utilityProcess 入口
//
// 为什么要单独一个进程：
// vm 沙箱不是安全边界（Node 官方文档明确说明这一点），执行 AI 生成的代码
// 本质上等于执行任意代码。把它关进 utilityProcess 之后，即使沙箱被完全绕过，
// 拿到的也只是一个不含 Electron 能力的普通 Node 进程 —— 摸不到 BrowserWindow、
// safeStorage 里的 GLM API Key、主进程的 ipcMain handler，而且能随时杀掉重启。
//
// 顺带解决了另一个问题：旧实现把 spawnSync / 大文件读取 / 正则全放在主进程，
// 首次探测 Python 最坏能卡住界面 9 秒。
//
// 注意：这个文件不要从主进程 require，只能通过 utilityProcess.fork 启动。

const runner = require("./runner.js");

// 日志总量上限，防止 AI 代码疯狂 log() 撑爆进程间消息通道
const MAX_LOGS = 500;
const MAX_LOG_CHARS = 2000;

let busy = false;
const queue = [];

function post(msg) {
  try {
    process.parentPort.postMessage(msg);
  } catch (e) {
    // 父进程可能已经关闭，这里没法上报，忽略即可
  }
}

async function execute(task) {
  const id = task.id;
  const logs = [];

  try {
    const result = await runner.runCuckooCode(task.code, {
      workspace: task.workspace,
      deadline: task.deadline,
      onLog: function (msg) {
        const text = String(msg).substring(0, MAX_LOG_CHARS);
        if (logs.length < MAX_LOGS) {
          logs.push(text);
          post({ id: id, type: "log", msg: text });
        }
      }
    });

    // runCuckooCode 返回的字段全是字符串/数字/数组，可以直接结构化克隆。
    // logs 用这里截断过的副本，保证不会超限。
    result.logs = logs;
    if (typeof result.errorStack === "string") result.errorStack = result.errorStack.substring(0, 4000);
    if (typeof result.rawCode === "string") result.rawCode = result.rawCode.substring(0, 20000);

    post({ id: id, type: "done", payload: result });
  } catch (e) {
    post({ id: id, type: "fatal", error: (e && e.message) || String(e), logs: logs });
  }
}

// 串行执行：Agent 循环本来就是「AI 出一个代码块 → 等结果 → 再出下一个」，
// 不存在并发需求；串行还能保证 runner 里那个全局的 liveProcs 看门狗语义正确
// （超时要杀进程树时，不会误杀另一次执行的子进程）。
function pump() {
  if (busy || queue.length === 0) return;
  busy = true;
  const task = queue.shift();
  execute(task).then(
    function () { busy = false; pump(); },
    function () { busy = false; pump(); }
  );
}

process.parentPort.on("message", function (event) {
  const data = event && event.data;
  if (!data || typeof data !== "object") return;

  if (data.type === "execute") {
    queue.push({
      id: data.id,
      code: typeof data.code === "string" ? data.code : "",
      workspace: typeof data.workspace === "string" ? data.workspace : "",
      deadline: typeof data.deadline === "number" && data.deadline > 0 ? data.deadline : 120000
    });
    pump();
  } else if (data.type === "cancel") {
    // 用户在确认框点了取消 / 关掉了窗口：立刻终止正在跑的子进程树
    try { runner.killAllLiveProcs(); } catch (e) {}
  } else if (data.type === "ping") {
    post({ type: "pong" });
  }
});

// 父进程消失时自己退出，别留孤儿进程
process.parentPort.on("disconnect", function () {
  try { runner.killAllLiveProcs(); } catch (e) {}
  process.exit(0);
});

process.on("uncaughtException", function (e) {
  post({ type: "crashed", error: (e && e.message) || String(e) });
});

post({ type: "ready" });
