/**
 * 將 docs/persona/PHASE97_MASTER_SLIM.txt 的內容同步到 settings.system_prompt。
 * 執行：npm run sync:prompt
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { storage } from "../storage";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "../..");

const promptPath = path.join(root, "docs/persona/PHASE97_MASTER_SLIM.txt");
if (!fs.existsSync(promptPath)) {
  console.error(`[sync-global-prompt] 找不到 ${promptPath}`);
  process.exit(1);
}
const newPrompt = fs.readFileSync(promptPath, "utf-8").trim();
console.log(`[sync-global-prompt] 讀取 Global Prompt，${newPrompt.length} 字元`);

const current = storage.getSetting("system_prompt") || "";
if (current.trim() === newPrompt) {
  console.log("[sync-global-prompt] DB 已是最新，無需更新。");
  process.exit(0);
}

storage.setSetting("system_prompt", newPrompt);
console.log(`[sync-global-prompt] 已更新 settings.system_prompt（${current.length} → ${newPrompt.length} 字元）`);
