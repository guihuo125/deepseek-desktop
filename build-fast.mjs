import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = __dirname;
const tmpDir = path.join(appDir, ".fast-asar-src");
const asarOut = path.join(appDir, "dist", "win-unpacked", "resources", "app.asar");

// 清空临时目录
if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
fs.mkdirSync(tmpDir, { recursive: true });

// 复制运行时文件
const files = ["main.js", "preload.js", "probe.js", "security.js", "runner.js", "package.json"];
for (const f of files) {
  fs.copyFileSync(path.join(appDir, f), path.join(tmpDir, f));
}

// ★ 从 package.json 读取所有生产依赖，递归复制
const pkg = JSON.parse(fs.readFileSync(path.join(appDir, "package.json"), "utf-8"));
const prodDeps = Object.keys(pkg.dependencies || {});

// 递归收集传递依赖（读取每个依赖的 package.json）
const collected = new Set();
function collectDeps(pkgName, nmRoot) {
  if (collected.has(pkgName)) return;
  collected.add(pkgName);
  const depPkgJson = path.join(nmRoot, pkgName, "package.json");
  if (!fs.existsSync(depPkgJson)) return;
  try {
    const dep = JSON.parse(fs.readFileSync(depPkgJson, "utf-8"));
    const subDeps = Object.keys(dep.dependencies || {});
    for (const s of subDeps) collectDeps(s, nmRoot);
  } catch (e) {}
}

const nmSrc = path.join(appDir, "node_modules");
for (const d of prodDeps) collectDeps(d, nmSrc);

console.log(`生产依赖（含传递）: ${collected.size} 个`);
for (const d of collected) console.log(`  - ${d}`);

// 复制所有依赖
const nmDst = path.join(tmpDir, "node_modules");
fs.mkdirSync(nmDst, { recursive: true });
for (const pkgName of collected) {
  const src = path.join(nmSrc, pkgName);
  const dst = path.join(nmDst, pkgName);
  if (!fs.existsSync(src)) {
    console.warn(`  ⚠ 缺失: ${pkgName}`);
    continue;
  }
  // scoped 包（@xxx/yyy）需要建父目录
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
}

// 打包
try {
  console.log("打包中...");
  execSync(`npx asar pack "${tmpDir}" "${asarOut}"`, { cwd: appDir, stdio: "inherit" });
} catch (e) {
  console.error("打包失败:", e.message);
  process.exit(1);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

const stat = fs.statSync(asarOut);
console.log(`✅ asar: ${(stat.size / 1024 / 1024).toFixed(2)} MB @ ${stat.mtime.toISOString()}`);