/**
 * 將 docs/persona/brands/brand_{1,2}_phase97_slim.txt 同步到 brands.system_prompt。
 * 執行：npm run sync:brand-prompts
 */
import fs from "fs";
import path from "path";
import db from "../db";

const root = process.cwd();

function readBrandFile(rel: string): string {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) {
    console.error(`[sync-brand-prompts] 找不到 ${p}`);
    process.exit(1);
  }
  return fs.readFileSync(p, "utf-8").trim();
}

const brand1Prompt = readBrandFile("docs/persona/brands/brand_1_phase97_slim.txt");
const brand2Prompt = readBrandFile("docs/persona/brands/brand_2_phase97_slim.txt");

const r1 = db.prepare("UPDATE brands SET system_prompt = ? WHERE id = 1").run(brand1Prompt);
console.log("品牌 1 更新：", r1.changes, "筆，", brand1Prompt.length, "字元");

const r2 = db.prepare("UPDATE brands SET system_prompt = ? WHERE id = 2").run(brand2Prompt);
console.log("品牌 2 更新：", r2.changes, "筆，", brand2Prompt.length, "字元");

console.log("完成");
