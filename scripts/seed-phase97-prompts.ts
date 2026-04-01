/**
 * Phase 97：將瘦身後全域主腦與各品牌 system_prompt 寫入 SQLite。
 * 執行：npx tsx scripts/seed-phase97-prompts.ts
 * 預覽：npx tsx scripts/seed-phase97-prompts.ts --dry-run
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import db from "../server/db";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.join(__dirname, "..");

function readUtf8(p: string): string {
  return fs.readFileSync(p, "utf8").trim();
}

function main(): void {
  const dry = process.argv.includes("--dry-run");
  const globalPath = path.join(root, "docs", "persona", "PHASE97_MASTER_SLIM.txt");
  const g = readUtf8(globalPath);
  const b1 = readUtf8(path.join(root, "docs", "persona", "brands", "brand_1_phase97_slim.txt"));
  const b2 = readUtf8(path.join(root, "docs", "persona", "brands", "brand_2_phase97_slim.txt"));

  console.log("[seed-phase97] global chars:", g.length);
  console.log("[seed-phase97] brand 1 chars:", b1.length);
  console.log("[seed-phase97] brand 2 chars:", b2.length);

  if (dry) {
    console.log("[seed-phase97] --dry-run：未寫入 DB。");
    return;
  }

  const uSet = db.prepare("UPDATE settings SET value = ? WHERE key = 'system_prompt'");
  const r0 = uSet.run(g);
  if (r0.changes === 0) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('system_prompt', ?)").run(g);
    console.log("[seed-phase97] INSERT settings.system_prompt");
  } else {
    console.log("[seed-phase97] UPDATE settings.system_prompt");
  }

  const ub = db.prepare("UPDATE brands SET system_prompt = ? WHERE id = ?");
  ub.run(b1, 1);
  ub.run(b2, 2);
  console.log("[seed-phase97] UPDATE brands.system_prompt id=1,2");
}

main();
