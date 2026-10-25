// 生成 electron-updater 的 latest.yml
//
// 为什么要有这个脚本：build.win.target 是 dir（安装包交给 Inno Setup），electron-builder
// 就不产更新元数据了，latest.yml 只能手写。手写漏一次或 hash 算错，已装用户就静默
// 收不到更新 —— 发布看起来完成了，其实更新通道是断的。
//
// 跑法：node make-latest-yml.mjs        （在 npm run build / 发布前调用）
// 它只认与 package.json 同版本号的那个安装包，版本对不上直接失败。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(appDir, "inno-out");

const pkg = JSON.parse(fs.readFileSync(path.join(appDir, "package.json"), "utf-8"));
const ver = pkg.version;

const exeName = `DeepSeek-Setup-${ver}.exe`;
const exePath = path.join(outDir, exeName);
if (!fs.existsSync(exePath)) {
  console.error(`找不到与 package.json 版本(${ver})对应的安装包: ${exeName}`);
  console.error("  先跑完整构建 + ISCC 编译 installer.iss，再生成 latest.yml。");
  process.exit(1);
}

const buf = fs.readFileSync(exePath);
const sha512 = crypto.createHash("sha512").update(buf).digest("base64");
const size = buf.length;
// electron-updater 只把 releaseDate 当展示用，但格式要和它自己产的一致（带毫秒的 ISO）
const releaseDate = fs.statSync(exePath).mtime.toISOString();

const yml =
  `version: ${ver}\n` +
  `files:\n` +
  `  - url: ${exeName}\n` +
  `    sha512: ${sha512}\n` +
  `    size: ${size}\n` +
  `path: ${exeName}\n` +
  `sha512: ${sha512}\n` +
  `releaseDate: '${releaseDate}'\n`;

fs.writeFileSync(path.join(outDir, "latest.yml"), yml, "utf-8");
console.log(`latest.yml 已生成（v${ver}，${size} B）`);
console.log(`  sha512 ${sha512}`);
