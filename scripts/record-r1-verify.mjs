/**
 * 將 verify:r1 完整輸出寫入 verify_output/verify_r1.txt（UTF-8）。
 * Windows：chcp 65001 後再執行 npm，減少主控台亂碼。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outPath = path.join(root, "verify_output", "verify_r1.txt");
fs.mkdirSync(path.dirname(outPath), { recursive: true });

const isWin = process.platform === "win32";
const proc = isWin
  ? spawnSync("cmd.exe", ["/c", "chcp 65001 >nul && npm run verify:r1"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "0" },
    })
  : spawnSync("npm", ["run", "verify:r1"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "0" },
    });

const text = (proc.stdout || "") + (proc.stderr || "");
fs.writeFileSync(outPath, text, "utf8");
process.exit(proc.status ?? 1);
