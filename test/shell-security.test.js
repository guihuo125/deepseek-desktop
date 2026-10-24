// 地址栏锁图标三态判定的测试
//
// 这个函数决定用户看到的锁是绿/灰/红，以及面板上写"能力已启用"还是"已关闭"。
// 判错的后果不是显示不准，而是**给用户错误的安全感**：比如明文 HTTP 下显示绿色
// 并宣称本地执行已启用，或者把第三方站点标成官方域导致能力真的被打开。
// 判定本体在 security.js，与注入侧 preload 门控共用同一份实现，这里锁住它。

const security = require("../security.js");

let passed = 0, failed = 0;
function eq(actual, expected, msg) {
  if (actual === expected) { passed++; console.log("  ✓ " + msg); }
  else { failed++; console.log("  ✗ " + msg + "（期望 " + expected + "，实际 " + actual + "）"); }
}

function info(url, opts) { return security.shellSecurityInfo(url, opts || {}); }

console.log("\n== 绿色 secure-app：https + DeepSeek 官方域 ==");
for (const u of ["https://chat.deepseek.com/", "https://deepseek.com",
                 "https://www.deepseek.com/abc?x=1", "https://api.deepseek.com"]) {
  const r = info(u);
  eq(r.level, "secure-app", "secure-app: " + u);
  eq(r.capability, "enabled", "  能力启用: " + u);
}

console.log("\n== 灰色 secure-web：https + 第三方 ==");
for (const u of ["https://www.bing.com/", "https://example.net",
                 "https://localhost:3000/", "https://127.0.0.1/"]) {
  const r = info(u);
  eq(r.level, "secure-web", "secure-web: " + u);
  eq(r.capability, "disabled-third-party", "  能力关闭: " + u);
}

console.log("\n== 红色 insecure：明文一律不算安全 ==");
// 关键用例：http 的 DeepSeek 官方域绝不能显示绿色 —— 明文下中间人可以直接
// 往页面注入代码块，而本应用具备本地执行能力
for (const u of ["http://chat.deepseek.com/", "http://deepseek.com", "http://example.com"]) {
  const r = info(u);
  eq(r.level, "insecure", "insecure: " + u);
  eq(r.https, false, "  https=false: " + u);
}

console.log("\n== 后缀伪造不得判成官方域 ==");
for (const u of ["https://deepseek.com.evil.net/", "https://chat.deepseek.com.evil.io/",
                 "https://evildeepseek.com/", "https://fakedeepseek.com/", "https://deepseek.comx.io/"]) {
  eq(info(u).level, "secure-web", "不是 secure-app: " + u);
}

console.log("\n== 大小写与端口不影响判定 ==");
eq(info("HTTPS://Chat.DeepSeek.COM/").level, "secure-app", "大写协议与混合大小写主机");
eq(info("https://chat.deepseek.com:8443/").level, "secure-app", "带端口的官方域");
eq(info("https://CHAT.DeepSeek.COM.EVIL.NET/").level, "secure-web", "带端口的伪造域");

console.log("\n== 异常输入按不可信处理 ==");
for (const u of ["", "not a url", "file:///C:/Windows/win.ini", "javascript:alert(1)",
                 "data:text/html,<pre>dir</pre>", "search-ms:q=x"]) {
  const r = info(u);
  eq(r.level, "insecure", "insecure: " + JSON.stringify(u));
  eq(r.isDeepSeek, false, "  非官方: " + JSON.stringify(u));
}

console.log("\n== 隐私：工作区路径只在能力启用时透出 ==");
// 第三方站点下把本地路径写进面板没有意义，且一旦这些信息被别的通道带出去就是泄漏
{
  const ws = "D:\\Users\\me\\secret-project";
  eq(info("https://www.bing.com/", { workspace: ws }).workspace, "", "第三方站点不返回工作区路径");
  eq(info("http://chat.deepseek.com/", { workspace: ws }).workspace, "", "明文下不返回工作区路径");
  eq(info("https://chat.deepseek.com/", { workspace: ws }).workspace, ws, "官方 https 才返回");
}

console.log("\n== 证书错误只随对应文档显示 ==");
{
  const err = { url: "https://badcert.example.com/", error: "CERT_DATE_INVALID", issuer: "Evil CA" };
  eq(info("https://badcert.example.com/", { certError: err }).certError, err, "同 URL 时带出证书错误");
  eq(info("https://chat.deepseek.com/", { certError: err }).certError, null,
     "导航后不得继续显示上一条的证书错误");
}

console.log("\n== 与注入侧门控的一致性（同一份实现）==");
// preload.js 里的门控是 location.hostname + protocol 自己写的（隔离世界拿不到本模块），
// 所以这里至少保证 isDeepSeekUrl 与 shellSecurityInfo 不会互相矛盾
for (const u of ["https://chat.deepseek.com/", "https://evildeepseek.com/", "http://chat.deepseek.com/"]) {
  eq(security.isDeepSeekUrl(u), info(u).isDeepSeek, "isDeepSeekUrl 与三态一致: " + u);
}

console.log("\n==================================================");
if (failed === 0) console.log(`全部通过（${passed} 项）`);
else { console.log(`失败 ${failed} 项 / 通过 ${passed} 项`); process.exit(1); }
