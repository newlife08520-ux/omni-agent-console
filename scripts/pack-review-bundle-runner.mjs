/**
 * 1) 確保 pack-review-bundle.ps1 為 UTF-8 **含 BOM**（Windows PowerShell 5.1 對無 BOM 檔案會用 ANSI 解讀，易解析錯亂／當機感）
 * 2) 以 -File 執行該腳本，繼承目前 process 環境變數（含 REVIEW_BUNDLE_SKIP_LONG_VERIFY）
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

function findProjectRoot(startDir) {
  let d = path.resolve(startDir);
  for (let i = 0; i < 12; i++) {
    if (existsSync(path.join(d, "package.json")) && existsSync(path.join(d, "server"))) {
      return d;
    }
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const root = findProjectRoot(path.join(scriptsDir, ".."));
const ps1 = path.join(scriptsDir, "pack-review-bundle.ps1");

if (!existsSync(ps1)) {
  console.error("Missing:", ps1);
  process.exit(1);
}

let buf = readFileSync(ps1);
if (buf[0] !== 0xef || buf[1] !== 0xbb || buf[2] !== 0xbf) {
  buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), buf]);
  writeFileSync(ps1, buf);
  console.log("[pack-review-bundle-runner] Added UTF-8 BOM to pack-review-bundle.ps1 (PS 5.1 safe).");
}

const r = spawnSync(
  "powershell.exe",
  ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1],
  { cwd: root, stdio: "inherit", env: process.env, windowsHide: true }
);

process.exit(r.status === null ? 1 : r.status);
