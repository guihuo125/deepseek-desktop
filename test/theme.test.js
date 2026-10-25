// Claude 主题的回归防线
//
// 为什么这些断言值得进构建前置：网页样式表是注入到远程页面的，改坏了不会报错、
// 不会让测试变红，只会让用户先看见 —— 侧栏回到冷白、按钮回到 DeepSeek 蓝、
// 或者整份样式表被重复注入四份。本轮实测踩到的每一条都在这里钉死。
//
// 事实来源：2026-10-24 用 CDP 连到真页面逐条量过（见 交接文档.txt 第十五章）。

const fs = require("fs");
const path = require("path");

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log("  ✓ " + msg); }
  else { failed++; console.log("  ✗ " + msg); }
}
function eq(a, b, msg) { ok(a === b, msg + "（期望 " + b + "，实际 " + a + "）"); }

const root = path.join(__dirname, "..");
const web = fs.readFileSync(path.join(root, "themes", "claude-web.css"), "utf8");
const shell = fs.readFileSync(path.join(root, "themes", "claude.css"), "utf8");
const mainJs = fs.readFileSync(path.join(root, "main.js"), "utf8");

// 文件头里刻意写了「不要做什么」的反例（@font-face、哈希类名、url()），
// 所以这几条断言必须只看代码、不看注释，否则永远在报自己举的例子。
const webCode = web.replace(/\/\*[\s\S]*?\*\//g, "");

console.log("\n== §2 令牌接管必须逐条 !important ==");
// 级联顺序 important-user > important-author > normal-user：DeepSeek 在 body 上
// 声明这批令牌时带了 !important，我们的普通声明会输，实测冷色会整批回来。
// 只看代码不看注释：注释里同样出现过 "--dsw-*: ... !important" 的举例，
// 拿原文匹配会让测试假绿（注释里写一条、代码里漏一条也照样通过）。
const sec2Body = blockAfter(webCode, "body,\nbody[data-ds-dark-theme]");
const tokenDecls = [...sec2Body.matchAll(/(--dsw-[a-z0-9-]+)\s*:\s*([^;]*);/g)];
ok(tokenDecls.length >= 60, "§2 至少接管 60 条宿主令牌（实际 " + tokenDecls.length + "）");
const loose = tokenDecls.filter(m => !/!important/.test(m[2])).map(m => m[1]);
eq(loose.length, 0, "所有 --dsw-* 声明都带 !important（漏掉的：" + loose.slice(0, 5).join(", ") + "）");
const dwsDeclared = new Set(tokenDecls.map((m) => m[1]));
const dwsRefs = [...new Set([...webCode.matchAll(/var\(\s*(--dsw-[\w-]+)/g)].map((m) => m[1]))];
const dwsGhost = dwsRefs.filter((v) => !dwsDeclared.has(v));
eq(dwsGhost.join(", "), "", "转发引用的宿主令牌都确实在 §2 接管列表里（写错名只会静默回退）");
ok(/--dsw-specific-sidebar-fill:\s*var\(--bg-subtle\)\s*!important/.test(web), "侧栏底色令牌指向 --bg-subtle");
ok(/--dsw-alias-brand-primary:\s*var\(--accent\)\s*!important/.test(web), "品牌色令牌指向 --accent");
ok(/--dsw-specific-bubble:\s*var\(--accent-soft\)\s*!important/.test(web), "用户气泡令牌指向 --accent-soft");
ok(/background-color:\s*var\(--bg-canvas\)\s*!important/.test(web), "画布底色兜底带 !important（深色下实测会露白底）");

console.log("\n== 禁止依赖构建期哈希类名 ==");
// DeepSeek 的容器类名形如 cb86951c / _27c9245，每次发版换一套，写进主题等于写死
// 一次性的东西 —— 命中 0 的规则不是无害的，DOM 每次变化它们都要参与匹配。
const hashed = [...webCode.matchAll(/(?:^|[\s,>])\._?[0-9a-f]{6,10}(?=[\s,.:{>\[])/g)].map(m => m[0].trim());
eq(hashed.length, 0, "样式表里不出现哈希类名选择器（发现 " + hashed.length + " 处：" + hashed.slice(0, 3).join(" / ") + "）");

console.log("\n== 远程页面不能有的东西 ==");
ok(!/@font-face/.test(webCode), "不写 @font-face（相对路径解析不到 asar，字体由主进程按字节注册）");
ok(!/url\(/.test(webCode), "不写任何 url()（受页面 CSP 管，且解析不到本地文件）");

console.log("\n== 代码块必须用主题底板 ==");
// 用户实测过「深底深字」：宿主的高亮配色是按它自己的浅色底写的，
// 强行换成深色石板就会出现背景深、文字也深，整块看不清。
const preRule = (webCode.match(/(^|\n)pre \{([^}]*)\}/) || [])[2] || "";
ok(/background-color:\s*var\(--bg-subtle\)\s*!important/.test(preRule), "pre 底色用 --bg-subtle 且带 !important");
ok(/color:\s*var\(--text-primary\)\s*!important/.test(preRule), "pre 文字用 --text-primary 且带 !important");
ok(!/--code-slab/.test(webCode), "不再保留独立的深色代码石板令牌");

console.log("\n== 字体分工：衬线只给标题 ==");
const headingRule = web.match(/h1,\s*h2,\s*h3[^{]*\{([^}]*)\}/);
ok(headingRule && /--dsc-serif/.test(headingRule[1]), "h1-h6 用衬线令牌 --dsc-serif");
const bodyFontRule = web.match(/body,\s*input,\s*textarea[^{]*\{([^}]*)\}/);
ok(bodyFontRule && /--dsc-sans/.test(bodyFontRule[1]) && !/--dsc-serif/.test(bodyFontRule[1]), "正文与控件用无衬线令牌 --dsc-sans");

// 引用有、声明无时 var() 静默解析失败：规则匹配赢了却拿到继承值，页面上不报任何错。
// 实测 --dsc-serif 正是这样漏了声明，网页侧「衬线做标题」整条链失效了一整轮才发现。
const declared = new Set([...webCode.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
const referenced = new Set([...webCode.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]));
const dangling = [...referenced].filter((v) => !declared.has(v) && !v.startsWith("--dsw-"));
eq(dangling.join(", "), "", "每个 var() 引用都指得到自己的声明（转发宿主 --dsw-* 除外）");
for (const tok of ["--dsc-serif", "--dsc-sans", "--dsc-mono"]) {
  ok(declared.has(tok), tok + " 有声明");
}
// Cascade 4 的普通声明是【作者 > 用户】，我们站在用户这一档，字体族不加 !important
// 就会被宿主的 `font:` 简写压掉 —— 而且不报错，只表现为"改了没反应"。
const serifBlocks = [...webCode.matchAll(/\{[^}]*var\(\s*--dsc-serif[^}]*\}/g)].map((m) => m[0]);
ok(serifBlocks.length >= 2, "衬线令牌至少被两处规则引用（实测 " + serifBlocks.length + "）");
ok(serifBlocks.every((b) => /--dsc-serif\)\s*!important/.test(b)),
  "每个 --dsc-serif 引用都带 !important");

console.log("\n== 两份深色令牌必须逐字一致 ==");
// 两条生效路径互不同步：@media 跟系统主题（nativeTheme），.dark 跟 DeepSeek 自己的开关。
// 两份漂移的症状是"某个组合下页面一半深一半浅"，最难查；文件里反复写了"必须逐字一致"，
// 但在此之前没有任何测试守着它。
function blockAfter(src, marker) {
  const i = src.indexOf(marker);
  if (i < 0) return "";
  const open = src.indexOf("{", i), close = src.indexOf("\n}", open);
  return src.slice(open + 1, close);
}
function tokensOf(body) {
  const out = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}
const darkSystem = tokensOf(blockAfter(webCode, "@media (prefers-color-scheme: dark)"));
const darkHost = tokensOf(blockAfter(webCode, "html.dark,"));
eq(Object.keys(darkSystem).length, 28, "系统深色段令牌数");
eq(Object.keys(darkHost).length, 28, "宿主深色段令牌数");
const onlySystem = Object.keys(darkSystem).filter((k) => !(k in darkHost));
const onlyHost = Object.keys(darkHost).filter((k) => !(k in darkSystem));
eq(onlySystem.concat(onlyHost).join(","), "",
  "两份深色令牌名一致（只在系统段：" + onlySystem.join(",") + "；只在宿主段：" + onlyHost.join(",") + "）");
const drift = Object.keys(darkSystem).filter((k) => k in darkHost && darkSystem[k] !== darkHost[k]);
eq(drift.join(","), "", "两份深色令牌值一致（漂移：" + drift.join(",") + "）");

console.log("\n== 与壳层设计源不能漂移 ==");
// 两份文件同名同值是刻意的（远程页面读不到本地 :root），一旦漂移，壳层和网页
// 就不像同一个应用 —— 这比某个颜色不好看更糟。网页侧可以多出壳层没有的令牌
// （代码块专用），但两边都有的必须一个不差。
for (const tok of ["--bg-canvas", "--bg-subtle", "--accent", "--text-primary", "--border-default"]) {
  const inShell = (shell.match(new RegExp(tok + ":\\s*(#[0-9A-Fa-f]{6})", "i")) || [])[1];
  const inWeb = (web.match(new RegExp(tok + ":\\s*(#[0-9A-Fa-f]{6})", "i")) || [])[1];
  // 先确认两边都解析到了值：两个 undefined 相等也会判"同值"通过，
  // 于是把色值改成 oklch() 或两边一起改名时，这五条全绿而契约已断。
  ok(inWeb !== undefined && inShell !== undefined, tok + " 在两份文件里都能解析到 6 位 hex");
  eq(inWeb, inShell, tok + " 两份文件同值");
}

const shellCode = shell.replace(/\/\*[\s\S]*?\*\//g, "");
function tokensIn(src, marker, tokensOfBody) {
  const i = src.indexOf(marker);
  if (i < 0) return {};
  const open = src.indexOf("{", i), close = src.indexOf("\n}", open);
  return tokensOfBody(src.slice(open + 1, close));
}
const normValue = (v) => v.toLowerCase().replace(/\s+/g, "").replace(/(^|[(,])0\./g, "$1.");
function driftBetween(name, shellTokens, webTokens) {
  const shared = Object.keys(shellTokens).filter((k) => k in webTokens);
  const bad = shared.filter((k) => normValue(shellTokens[k]) !== normValue(webTokens[k]));
  eq(bad.join(","), "", name + "壳层与网页同值（共有 " + shared.length + " 个，漂移：" + bad.join(",") + "）");
  return shared.length;
}
// 壳层浅色写在 :root 与 [data-theme="light"] 的合并块里；深色只在 [data-theme="dark"]。
const shellLight = tokensIn(shellCode, ":root,", tokensOf);
const shellDark = tokensIn(shellCode, '[data-theme="dark"]', tokensOf);
const webLight = tokensIn(webCode, ":root {", tokensOf);
ok(driftBetween("浅色", shellLight, webLight) >= 25, "浅色共有令牌数够多（防止解析落空后假绿）");
ok(driftBetween("深色", shellDark, darkHost) >= 25, "深色共有令牌数够多（防止解析落空后假绿）");
ok(!("--code-slab" in shellDark), "代码块令牌只存在于网页侧（壳层没有代码块）");

console.log("\n== 样式表只注入一次 ==");
// removeInsertedCSS 对 cssOrigin:"user" 的表不生效：每重注入一次就多留一份，
// 实测切两次主题后同一批规则匹配到 4 份，样式重算成本直接乘倍。
const broadcast = (mainJs.match(/function broadcastTheme\(\)[\s\S]*?\n\}/) || [""])[0];
ok(broadcast.length > 0, "找到 broadcastTheme");
ok(!/applyWebTheme/.test(broadcast), "broadcastTheme 不重注入网页样式表（深色靠媒体查询自动跟随）");
ok(/insertCSS\([\s\S]{0,80}cssOrigin:\s*"user"/.test(mainJs), "网页样式表按 user origin 注入");

console.log("\n== 启动与导航时的主题时序 ==");
// 冷启动如果只在 broadcastTheme 里设 themeSource，用户上次选了深色、系统是浅色时，
// 网页会按系统渲染成浅色 —— 深壳浅页。必须赶在任何页面加载前设好。
const startup = (mainJs.match(/app\.whenReady\(\)\.then\([\s\S]*?createWindow\(\);/) || [""])[0];
ok(/loadThemeConfig\(\);[\s\S]{0,300}applyWindowTheme\(\);[\s\S]{0,300}createWindow\(\)/.test(startup),
  "whenReady 里 loadThemeConfig → applyWindowTheme → createWindow 顺序正确");
// 两条注入钩子的分工不能对调：dom-ready 强制插（新文档 key 为空，force 是保险），
// did-finish-load 只能兜底。反过来会在每次导航后多插一份，removeInsertedCSS 删不掉。
ok(/on\("dom-ready",\s*\(\)\s*=>\s*\{\s*applyWebTheme\(true\)/.test(mainJs), "dom-ready 用 force=true");
ok(/on\("did-finish-load",\s*\(\)\s*=>\s*\{\s*applyWebTheme\(false\)/.test(mainJs), "did-finish-load 用 force=false 兜底");
ok(/did-navigate"[\s\S]{0,400}webCssKey\s*=\s*null/.test(mainJs), "did-navigate 清掉 webCssKey（旧文档的 key 对新文档无效）");
// 隐藏是二值接管：作者源只要在该元素上有一条 display，普通声明就压不住。
ok(/\[data-ds-hidden="1"\]\s*\{\s*display:\s*none\s*!important/.test(webCode), "隐藏免责行的 display:none 带 !important");

console.log("\n== preload 写入的属性与样式表契约一致 ==");
// 两边靠字符串契约连接：preload 打什么值，CSS 就得用同一个值。
// 任何一边改名都不会报错，只会静默失效（侧栏退回冷灰、气泡不再染色）。
const preloadJs = fs.readFileSync(path.join(root, "preload.js"), "utf8");
const regionEmitted = new Set([...preloadJs.matchAll(/setAttribute\("data-ds-region",\s*"([^"]+)"\)/g)].map((m) => m[1]));
const regionUsed = new Set([...webCode.matchAll(/\[data-ds-region="([^"]+)"\]/g)].map((m) => m[1]));
eq([...regionUsed].sort().join(","), [...regionEmitted].sort().join(","),
  "CSS 用到的 data-ds-region 值都由 preload 写入（CSS：" + [...regionUsed].join(",") + "；preload：" + [...regionEmitted].join(",") + "）");
ok(/setAttribute\("data-ds-hidden",\s*"1"\)/.test(preloadJs), "preload 写入 data-ds-hidden=1");

console.log("\n== 侧栏识别不得退回全页扫描 ==");
// 曾经每 3 秒 querySelectorAll("div") + 逐个量矩形，侧栏收起时会一直空转。
// 现在的做法是只从 .ds-scroll-area / .ds-button 向上取候选，这条断言守住它。
const preloadCode = preloadJs.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const tagFn = (preloadCode.match(/function tagSidebarRegion\(\)[\s\S]*?\n\}/) || [""])[0];
ok(tagFn.length > 0, "找到 tagSidebarRegion");
ok(!/querySelectorAll\("div"\)/.test(tagFn), "不再对整页 div 全量取矩形");
ok(/querySelectorAll\("\.ds-scroll-area, \.ds-button"\)/.test(tagFn), "从两个稳定钩子向上取候选");
// 收起成图标栏后那一栏也要上暖灰：旧的 170px 下限会把它整条挡掉，
// 实测结果是栏底色与画布同为 #FAF9F5，等于没上主题。
ok(/var narrow = r\.width >= 48 && r\.width < 170/.test(tagFn), "收起态窄栏（≥48px）参与判定");
ok(/r\.height < \(narrow \? vh \* 0\.9 : vh \* 0\.55\)/.test(tagFn), "窄栏要求几乎撑满全高，避免误判正文窄列");
ok(/wide\.length\) cands = wide/.test(tagFn), "宽候选优先，展开态判定与原来一致");
// 标记会随 React 换节点丢失。缓存成"成功一次就停"后不再补标，收起/展开后侧栏就没暖灰。
ok(!/if \(!regionState\.side\)/.test(preloadCode), "侧栏标记不再成功一次就停");
ok(/getBoundingClientRect\(\)\.width > 0/.test(tagFn), "旧标记节点不可见时清标记重判");

console.log("\n== 动效：只做合成友好过渡，且可降级 ==");
// 网页是远程页面，过渡一旦挂在布局属性（width/top/margin）上，就会在滚动和
// 流式输出时反复触发布局；命中集也不能用 * 通配，上万节点各挂一条 transition
// 的代价远大于收益。两条都要守住。
const motionScope = webCode.match(/:\s*where\(a,[\s\S]{0,400}?\)\s*\{([^}]*)\}/);
ok(motionScope && /transition:/.test(motionScope[1]), "过渡声明挂在列出的交互元素上");
const transDecls = [...webCode.matchAll(/transition:\s*([^;]+);/g)].map((m) => m[1]);
ok(transDecls.length >= 1, "网页侧存在过渡声明（实际 " + transDecls.length + " 条）");
const composited = new Set(["color", "background-color", "border-color", "box-shadow", "transform", "opacity"]);
const layoutMoves = [];
for (const decl of transDecls) {
  for (const part of decl.split(",")) {
    const prop = part.trim().split(/\s+/)[0];
    if (prop && !composited.has(prop)) layoutMoves.push(prop);
  }
}
eq([...new Set(layoutMoves)].join(","), "", "过渡只动颜色/阴影/位移，不动宽高与位置");
// 1ms 而不是 0：保留 transitionend 事件语义，依赖它的逻辑不会因为降级而卡住。
const reducedWeb = blockAfter(webCode, "@media (prefers-reduced-motion: reduce)");
ok(/transition-duration:\s*1ms/.test(reducedWeb), "网页侧有减弱动效降级");
const reducedShell = blockAfter(shellCode, "@media (prefers-reduced-motion: reduce)");
ok(/transition-duration:\s*1ms/.test(reducedShell), "壳层有减弱动效降级");
ok(!/@keyframes/.test(webCode), "网页侧不自造关键帧动画（不与宿主动画叠加）");

console.log("\n== 内核：执行进程空闲回收与日志上限 ==");
// 执行器常驻会白占一份 utilityProcess 内存；长任务日志无上限会把主进程撑大。
// 只钉常量声明没有意义（把使用它的那行删掉，常量还在、测试全绿），
// 所以每条都同时钉住「声明」与「真实使用点」。
ok(/WORKER_IDLE_MS\s*=\s*5 \* 60 \* 1000/.test(mainJs), "执行进程空闲 5 分钟后回收");
ok(/\}, WORKER_IDLE_MS\)/.test(mainJs), "空闲计时器真的用这个常量设时长");
ok(/if \(workerPending\.size !== 0\) return;/.test(mainJs), "有在飞任务时不回收执行进程");
ok(/MAX_WORKER_LOGS\s*=\s*400/.test(mainJs), "单任务日志条数上限常量");
ok(/entry\.logs\.length >= MAX_WORKER_LOGS/.test(mainJs), "条数上限真的参与截断判定");
ok(/MAX_WORKER_LOG_CHARS\s*=\s*128 \* 1024/.test(mainJs), "单任务日志字符上限常量");
ok(/entry\.logChars >= MAX_WORKER_LOG_CHARS/.test(mainJs), "字符上限真的参与截断判定");
ok(/clearWorkerIdle\(\);\s*\n\s*const id = "w"/.test(mainJs), "开始执行前取消空闲计时");
ok(!/跳过（无工具调用）/.test(preloadCode), "扫描热路径不再打印跳过日志");

console.log("\n== 连接信息浮层：独立视图，不再挤开页面 ==");
// 壳层是窗口底层 webContents，aiView 盖在它上面。旧做法是把网页缩窄让位，
// 症状就是打开锁面板时正文列被整块推走。改成独立 WebContentsView 后，
// 网页几何必须一点不动 —— 这几条守住那个结构。
const shellHtml = fs.readFileSync(path.join(root, "shell.html"), "utf8");
const securityHtml = fs.readFileSync(path.join(root, "security.html"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const issText = fs.readFileSync(path.join(root, "installer.iss"), "utf8");
ok(/security\.html/.test(mainJs) && /security-preload\.js/.test(mainJs), "主进程加载独立的安全浮层文档");
// main.js 引用了 ≠ 会进包：漏加 build.files 时 electron-builder 静默不打包，
// 装完后浮层是空白页，而上面那两条断言照样绿。
for (const f of ["security.html", "security-preload.js"]) {
  ok(pkg.build.files.includes(f), "build.files 收录了 " + f + "（漏了就装包里没这个文件）");
}
const idxAi = mainJs.indexOf("addChildView(aiView)");
const idxSec = mainJs.indexOf("addChildView(securityView)");
ok(idxAi >= 0 && idxSec >= 0, "两处 addChildView 都还在（任一处改名会让下面的比较失去意义）");
ok(idxSec > idxAi, "安全浮层在 aiView 之后添加，层级在其上方");
ok(!/id="security-panel"/.test(shellHtml), "壳层不再保留安全面板 DOM");
ok(!/setSecPanel/.test(shellHtml), "壳层不再为安全面板申请网页让位");
ok(/insetForPanel\(true, settingsPanel/.test(shellHtml), "设置面板仍保留让位（按用户要求保持现状）");
ok(/lockBtn\.getBoundingClientRect\(\)/.test(shellHtml) && /toggleSecurityPanel\(r\.left\)/.test(shellHtml),
  "浮层锚点取自锁图标坐标");
ok(/link rel="stylesheet" href="themes\/claude\.css"/.test(securityHtml), "浮层复用同一份主题令牌");
ok(/onTheme/.test(securityHtml) && /data-theme/.test(securityHtml), "浮层跟随主题切换");
ok(/Escape/.test(securityHtml), "浮层内按 Esc 可关闭");
// 钉使用点而不是函数定义：定义摆在那里就永远绿，把 close 通道上的守卫删掉也发现不了
ok(/ipcMain\.on\("close-security-panel"[\s\S]{0,160}senderIsSecurityView\(event\)/.test(mainJs),
  "关闭浮层的通道校验来源（壳层或浮层本身，别的文档不认）");

console.log("\n== 设置页：功能补齐且不写假信息 ==");
ok(!/DeepSeek 桌面客户端 v1\.0\.0/.test(shellHtml), "版本号不再写死 v1.0.0");
ok(/getAppInfo/.test(shellHtml) && /sp-app-ver/.test(shellHtml), "版本号来自主进程 app.getVersion()");
for (const id of ["sp-ws-change", "sp-ws-open", "sp-login", "sp-reload", "sp-clear-cache", "sp-diag"]) {
  ok(shellHtml.includes('id="' + id + '"'), "设置页含 #" + id);
}
for (const ipc of ["get-app-info", "open-workspace-folder", "get-login-item", "set-login-item", "clear-cache"]) {
  const re = new RegExp('ipcMain\\.handle\\("' + ipc + '"[\\s\\S]{0,200}?senderIsShell\\(event\\)');
  ok(re.test(mainJs), "IPC " + ipc + " 只接受壳层来源");
}
const pickTrans = (b) => [...b.matchAll(/transition:\s*([^;]+);/g)].map((m) => m[1]).join(",");
const toggleBlock = (shellHtml.match(/\.sp-toggle \{([^}]*)\}/) || [])[1] || "";
const actionBlock = (shellHtml.match(/\.sp-action-btn \{([^}]*)\}/) || [])[1] || "";
ok(pickTrans(toggleBlock).length > 0 && pickTrans(actionBlock).length > 0, "新设置控件有过渡声明");
ok(!/(width|height|top|left|right|bottom|margin|padding)\s/.test(pickTrans(toggleBlock) + pickTrans(actionBlock)),
  "新设置控件的过渡只动颜色/位移，不动物理尺寸");

console.log("\n== GLM 标识：用 Z.ai 官方轮廓，不再手画沙漏 ==");
// 轮廓逐字取自 @lobehub/icons 的 ZAI 图标（viewBox 0 0 24 24）。
// 早期版本是手绘的两个三角形，跟智谱实际标识不是一回事。
const ZAI_PATH = "M12.105 2L9.927 4.953H.653L2.83 2h9.276zM23.254 19.048L21.078 22h-9.242l2.174-2.952h9.244zM24 2L9.264 22H0L14.736 2H24z";
eq((preloadCode.match(new RegExp(ZAI_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length, 3,
  "悬浮球 / 面板标题 / 空态三处用同一份 Z.ai 轮廓");
ok(!/M9 6 L15 6|M8 8L16 8/.test(preloadCode), "手画的沙漏轮廓已清除");
// 写死颜色有三种写法都算"不跟随主题"，只挡 white 一种等于没挡
ok(!/fill=\\?["'](?:white|#fff(?:fff)?|#[Ff][Aa][Ff]9[Ff]5)\\?["']/.test(preloadCode),
  "标识不再写死 white/#fff/#FAF9F5，改用 currentColor 跟随令牌");
// 面板标题与空态那两处在 JS 字符串里，**两侧引号都是转义的**，正则要认这种形态
eq((preloadCode.match(/fill=\\?"currentColor\\?"/g) || []).length, 3, "三处标识都用 currentColor");
ok(/width="24" height="24"[^>]*aria-hidden="true"/.test(preloadCode), "56px 悬浮球里的标识占 24px 且对读屏隐藏");

console.log("\n== 交付链路：版本号一致、语法可解析、引用文件都在包里 ==");
// 2026-10-25 审查发现的三类静默失效，都在这里钉住：
// ① package.json 与 installer.iss 各升各的 → 安装包里装的可能是上一次的产物；
// ② npm test 从不检查 main.js 能否解析 → 语法错误照样打出"成功"的安装包；
// ③ main.js 新引用的文件忘了进 build.files → 装完是空白浮层/缺字体。
const issVer = (issText.match(/#define MyAppVersion\s+"([^"]+)"/) || [])[1];
eq(issVer, pkg.version, "installer.iss 的 MyAppVersion 与 package.json 的 version 同值");
ok(!/#define UnpackedDir\s+"dist/.test(issText),
  "installer.iss 不给默认打包目录（默认值会停在旧产物，编出名字新、内容旧的包）");

const { spawnSync } = require("child_process");
const RUNTIME = ["main.js", "preload.js", "security.js", "runner.js", "runner-worker.js",
  "shell-preload.js", "dialog-preload.js", "security-preload.js"];
for (const f of RUNTIME) {
  const r = spawnSync(process.execPath, ["--check", path.join(root, f)], { encoding: "utf8" });
  eq(r.status, 0, f + " 能通过 node --check（语法错会被 electron-builder 原样打进包里）");
}

// main.js 用 path.join(__dirname, "...") 引用的每个顶层文件/目录都必须在 build.files 里
const refSeg = new Set();
for (const m of mainJs.matchAll(/path\.join\(__dirname,\s*["']([^"'/\\]+)(?:[\\/][^"']*)?["']/g)) {
  refSeg.add(m[1]);
}
const plain = pkg.build.files.filter((f) => !f.startsWith("!") && !f.includes("**"));
const globs = pkg.build.files.filter((f) => !f.startsWith("!") && f.includes("**")).map((f) => f.split("/")[0]);
ok(refSeg.size >= 8, "确实从 main.js 抽到了 __dirname 引用（抽到 0 条时下面的循环会空跑）");
for (const seg of refSeg) {
  ok(plain.includes(seg) || globs.includes(seg), "main.js 引用的 " + seg + " 已在 build.files 中");
}

console.log("\n==================================================");
if (failed) { console.log("失败 " + failed + " 项，通过 " + passed + " 项"); process.exit(1); }
console.log("全部通过（" + passed + " 项）");
