/**
 * 可選執行：整理 DB 內 settings.system_prompt，依 "--- 標題 ---" 區塊去重（保留首次出現）。
 * 執行：npx tsx server/scripts/normalize-global-prompt.ts [--write]
 * 不加 --write 時僅印出差異，不寫回 DB。
 */
import db from "../db";
import { normalizeSections } from "../services/prompt-builder";

const row = db.prepare("SELECT value FROM settings WHERE key = ?").get("system_prompt") as { value: string } | undefined;
const raw = row?.value ?? "";
const normalized = normalizeSections(raw);

if (raw === normalized) {
  console.log("[normalize-global-prompt] 無重複區塊，無需更新。");
  process.exit(0);
}

console.log("[normalize-global-prompt] 偵測到重複區塊，去重後長度:", raw.length, "->", normalized.length);
if (process.argv.includes("--write")) {
  db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(normalized, "system_prompt");
  console.log("[normalize-global-prompt] 已寫回 DB。");
} else {
  console.log("[normalize-global-prompt] 未加 --write，未寫回。若要套用請執行: npx tsx server/scripts/normalize-global-prompt.ts --write");
}
