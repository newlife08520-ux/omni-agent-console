/**
 * Phase 95 / 96：將 Persona 寫入 DB `settings.system_prompt`。
 *
 * Phase 96 預設：瘦身主腦 `docs/persona/PHASE96_MASTER_SLIM.txt`（不含厚重訂單決策樹；查單細節由工具／policy 承載）。
 * 舊版長文：`--legacy` 自 `全區域人格設定.txt` 擷取（你是品牌…至…進退換貨或真人流程）。
 *
 * 執行：npx tsx scripts/seed-master-persona.ts
 * 預覽：npx tsx scripts/seed-master-persona.ts --dry-run
 * 舊版：npx tsx scripts/seed-master-persona.ts --legacy
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import db from "../server/db";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function extractLegacyMasterPersonaText(): string {
  const personaPath = path.join(__dirname, "..", "docs", "persona", "全區域人格設定.txt");
  if (!fs.existsSync(personaPath)) {
    throw new Error(`[seed-master-persona] 找不到 Persona 檔: ${personaPath}`);
  }
  const full = fs.readFileSync(personaPath, "utf8");
  const lines = full.split(/\r?\n/);
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (start < 0 && /你是品牌的線上購物顧問/.test(lines[i])) {
      start = i;
    }
    if (start >= 0 && /進退換貨或真人流程/.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (start < 0 || end < 0) {
    throw new Error("[seed-master-persona] 無法在檔案中定位 Persona 起迄（你是品牌…／進退換貨或真人流程）");
  }
  const chunk = lines.slice(start, end + 1).join("\n");
  return chunk.replace(/^@\s*/, "").trimEnd();
}

function loadPhase96SlimMasterText(): string {
  const p = path.join(__dirname, "..", "docs", "persona", "PHASE96_MASTER_SLIM.txt");
  if (!fs.existsSync(p)) {
    throw new Error(`[seed-master-persona] 找不到 Phase96 瘦身主腦: ${p}`);
  }
  return fs.readFileSync(p, "utf8").trim();
}

/** Phase 96 預設寫入 DB 之正文 */
export const MASTER_PERSONA_TEXT_SLIM = loadPhase96SlimMasterText();

/** --legacy 時之長篇（含訂單決策樹大段等） */
export const MASTER_PERSONA_TEXT_LEGACY = extractLegacyMasterPersonaText();

/** 向後相容：等同 SLIM（Phase 96 預設） */
export const MASTER_PERSONA_TEXT = MASTER_PERSONA_TEXT_SLIM;

function main(): void {
  const dryRun = process.argv.includes("--dry-run");
  const legacy = process.argv.includes("--legacy");
  const text = legacy ? MASTER_PERSONA_TEXT_LEGACY : MASTER_PERSONA_TEXT_SLIM;
  console.log(
    "[seed-master-persona] 模式:",
    legacy ? "LEGACY（全區域長文擷取）" : "SLIM（Phase96_MASTER_SLIM）",
    "| 長度:",
    text.length,
    "字元"
  );
  if (dryRun) {
    console.log("[seed-master-persona] --dry-run：未寫入 DB。");
    console.log(text.slice(0, 500) + "\n…\n" + text.slice(-280));
    return;
  }
  const upd = db.prepare("UPDATE settings SET value = ? WHERE key = 'system_prompt'");
  const r = upd.run(text);
  if (r.changes === 0) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('system_prompt', ?)").run(text);
    console.log("[seed-master-persona] 已 INSERT system_prompt。");
  } else {
    console.log("[seed-master-persona] 已 UPDATE system_prompt。");
  }
}

main();
