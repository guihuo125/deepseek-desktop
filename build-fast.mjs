import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// 直接用本地 @electron/asar 的 API 打包：不经过 shell（没有元字符注入面），
// 也不像 npx 那样每次联网拉包。
const asar = createRequire(import.meta.url)("@electron/asar");

// 快速打包：只重写 app.asar，不重编 Electron 本体。
// 注意它不会更新 DeepSeek.exe 里的版本资源，也不会重算 exe 内的 asar 完整性哈希
// 之外的任何东西 —— 升版本号那一次必须走 npm run build（完整 electron-builder）。
//
// 目标目录默认 dist\win-unpacked（即包含 resources\app.asar 的那一层）。
// 若该目录被文件句柄锁住（本项目常见），用环境变量指向别的构建输出：
//   ASAR_OUT=dist-fix2/win-unpacked node build-fast.mjs

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = __dirname;
const tmpDir = path.join(appDir, ".fast-asar-src");

let unpackedDir = path.join(appDir, "dist", "win-unpacked");
if (process.env.ASAR_OUT) {
  const target = path.resolve(appDir, process.env.ASAR_OUT);
  // 这个变量只是用来切换构建输出目录，不该变成任意路径写入
  const rel = path.relative(appDir, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    console.error("ASAR_OUT 必须指向项目目录内，收到: " + process.env.ASAR_OUT);
    process.exit(1);
  }
  unpackedDir = target;
}
const asarOut = path.join(unpackedDir, "resources", "app.asar");

let failed = false;

function cleanup() {
  // 必须在 process.exit 之前显式调用：exit 会跳过 finally 块，
  // 而本文件大部分逻辑原先写在 try 之外，抛错就把 .fast-asar-src 留在盘上。
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

try {
  if (!fs.existsSync(path.join(unpackedDir, "DeepSeek.exe"))) {
    throw new Error(
      `目标构建目录不完整（缺 DeepSeek.exe）: ${unpackedDir}\n` +
      `  该目录可能已被清理成残缺状态。跑一次完整构建，或用 ASAR_OUT=dist-fixN/win-unpacked 指定输出。`
    );
  }

  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  // 运行时文件清单直接取自 package.json 的 build.files，避免两处各写一份必然漂移
  const pkg = JSON.parse(fs.readFileSync(path.join(appDir, "package.json"), "utf-8"));
  const declared = (pkg.build && Array.isArray(pkg.build.files)) ? pkg.build.files : [];

  // 单文件条目（不含通配符）
  const plainFiles = declared.filter((f) => !f.startsWith("!") && !f.includes("**"));
  const files = ["package.json", ...plainFiles.filter((f) => f !== "package.json")];

  const missing = files.filter((f) => !fs.existsSync(path.join(appDir, f)));
  if (missing.length) throw new Error("build.files 声明的文件不存在: " + missing.join(", "));

  for (const f of files) {
    fs.copyFileSync(path.join(appDir, f), path.join(tmpDir, f));
  }
  console.log(`已复制 ${files.length} 个运行时文件（取自 package.json build.files）`);

  // 目录通配条目（"assets/**/*"、"themes/**/*"）→ 整目录复制，
  // 并应用同目录的排除规则（"!assets/*.png" 这类只匹配该目录根下的文件）。
  // 之前这里只特判了 assets，新增 themes 后若不通用化，快速包就会缺文件。
  const dirSet = new Set(
    declared.filter((f) => !f.startsWith("!") && f.includes("**")).map((f) => f.split("/")[0])
  );
  for (const dir of dirSet) {
    const srcRoot = path.join(appDir, dir);
    if (!fs.existsSync(srcRoot)) { console.warn(`  ⚠ 目录不存在: ${dir}`); continue; }
    const pats = declared
      .filter((f) => f.startsWith("!" + dir + "/"))
      .map((g) => {
        const base = g.slice(("!"+dir+"/").length);
        return new RegExp("^" + base.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i");
      });
    let kept = 0, skipped = 0;
    for (const name of fs.readdirSync(srcRoot)) {
      if (pats.some((re) => re.test(name))) { skipped++; continue; }
      fs.cpSync(path.join(srcRoot, name), path.join(tmpDir, dir, name), { recursive: true });
      kept++;
    }
    console.log(`${dir}/: 复制 ${kept} 项` + (pats.length ? `，按 build.files 排除 ${skipped} 项` : ""));
  }

  // 生产依赖（含传递依赖）
  const prodDeps = Object.keys(pkg.dependencies || {});
  const collected = new Set();
  function collectDeps(pkgName, nmRoot) {
    if (collected.has(pkgName)) return;
    collected.add(pkgName);
    const depPkgJson = path.join(nmRoot, pkgName, "package.json");
    if (!fs.existsSync(depPkgJson)) return;
    try {
      const dep = JSON.parse(fs.readFileSync(depPkgJson, "utf-8"));
      for (const s of Object.keys(dep.dependencies || {})) collectDeps(s, nmRoot);
    } catch (e) {}
  }
  const nmSrc = path.join(appDir, "node_modules");
  for (const d of prodDeps) collectDeps(d, nmSrc);

  const nmDst = path.join(tmpDir, "node_modules");
  fs.mkdirSync(nmDst, { recursive: true });
  let absent = 0;
  for (const pkgName of collected) {
    const src = path.join(nmSrc, pkgName);
    if (!fs.existsSync(src)) { absent++; continue; }
    // cpSync 递归复制整棵子树，因此依赖自带的 node_modules（版本可能与顶层不同）
    // 会一并进来 —— Node 解析时嵌套优先，这正是需要的行为，不要"优化"掉。
    fs.mkdirSync(path.dirname(path.join(nmDst, pkgName)), { recursive: true });
    fs.cpSync(src, path.join(nmDst, pkgName), { recursive: true });
  }
  console.log(`生产依赖（含传递）: ${collected.size} 个` + (absent ? `，顶层未找到 ${absent} 个（由嵌套副本提供）` : ""));

  console.log("打包中...");
  await asar.createPackage(tmpDir, asarOut);
} catch (e) {
  cleanup();
  console.error("打包失败:", e.message);
  failed = true;
}

if (!failed) {
  cleanup();
  const stat = fs.statSync(asarOut);
  console.log(`✅ asar: ${(stat.size / 1024 / 1024).toFixed(2)} MB @ ${stat.mtime.toISOString()}`);
  console.log(`   目标: ${asarOut}`);
}
process.exit(failed ? 1 : 0);
