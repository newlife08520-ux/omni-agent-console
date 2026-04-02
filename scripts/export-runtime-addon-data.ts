/**
 * One-off: export anonymized DB samples for CHATGPT_REVIEW_RUNTIME_ADDON.
 * Run: npx tsx scripts/export-runtime-addon-data.ts <outputDir>
 */
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const outDir = process.argv[2] || path.join(process.cwd(), "review_runtime_addon_staging", "db_snapshot_anonymized");
const dataRoot = process.env.DATA_DIR?.trim()
  ? path.resolve(process.env.DATA_DIR.trim())
  : process.cwd();
const dbPath = path.join(dataRoot, "omnichannel.db");

const SENSITIVE_KEY_SUBSTR = ["token", "secret", "key", "password", "credential", "api", "openai", "shopline", "merchant", "access"];

function maskString(s: unknown, maxLen = 2000): string {
  if (s == null) return "";
  let t = String(s);
  t = t.replace(/\b09\d{8}\b/g, "09*******");
  t = t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "***@***");
  t = t.replace(/sk-[a-zA-Z0-9]{10,}/g, "sk-[REDACTED]");
  t = t.replace(/Bearer\s+[a-zA-Z0-9._-]+/gi, "Bearer [REDACTED]");
  if (t.length > maxLen) t = t.slice(0, maxLen) + "\n...[truncated]";
  return t;
}

function maskNestedJsonString(s: string): string {
  try {
    const o = JSON.parse(s) as Record<string, unknown>;
    const redact = ["buyer_name", "buyer_phone", "buyer_email", "full_address", "address", "note", "receiver_name", "receiver_phone"];
    for (const key of redact) {
      if (o[key] != null && String(o[key]).length > 0) {
        o[key] = typeof o[key] === "string" && String(o[key]).length > 3 ? "[MASKED]" : o[key];
      }
    }
    return JSON.stringify(o);
  } catch {
    return maskString(s, 4000);
  }
}

function maskRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    const kl = k.toLowerCase();
    if (SENSITIVE_KEY_SUBSTR.some((s) => kl.includes(s))) {
      if (v == null || v === "") out[k] = v;
      else if (typeof v === "string" && v.length > 0)
        out[k] = `[REDACTED len=${v.length}]`;
      else out[k] = "[REDACTED]";
      continue;
    }
    if (kl.includes("platform_user_id") && typeof v === "string") {
      const h = crypto.createHash("sha256").update(v).digest("hex").slice(0, 12);
      out[k] = `U_masked_${h}`;
      continue;
    }
    if (kl.includes("display_name") || kl === "buyer_name" || kl === "username") {
      out[k] = typeof v === "string" ? maskString(v, 80) : v;
      continue;
    }
    if (typeof v === "string") {
      if (k === "payload" || k === "value" || k === "body" || k === "raw_json") {
        out[k] = maskNestedJsonString(v);
      } else out[k] = maskString(v, 8000);
    } else out[k] = v;
  }
  return out;
}

const TABLES = [
  "settings",
  "brands",
  "channels",
  "knowledge_files",
  "meta_page_settings",
  "meta_comment_rules",
  "meta_comment_risk_rules",
  "meta_post_mappings",
  "contacts",
  "messages",
  "ai_logs",
  "orders_normalized",
  "order_lookup_cache",
] as const;

function main() {
  if (!fs.existsSync(dbPath)) {
    console.error("No omnichannel.db at", dbPath);
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const db = new Database(dbPath, { readonly: true });
  const summary: Record<string, { rows_exported: number; error?: string }> = {};

  for (const t of TABLES) {
    try {
      const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
      if (!exists) {
        summary[t] = { rows_exported: 0, error: "table_missing" };
        continue;
      }
      const n = Math.min(20, Math.max(5, 15));
      const rows = db.prepare(`SELECT * FROM "${t}" ORDER BY rowid DESC LIMIT ?`).all(n) as Record<string, unknown>[];
      const masked = rows.map((row) => {
        if (t === "knowledge_files" && typeof row.content === "string") {
          let full = row.content as string;
          // CSV 風格「姓名,09…」列：遮罩姓名（避免測試客戶檔外洩）
          full = full.replace(/[\u4e00-\u9fff]{2,4}(?=,09)/g, "[NAME]");
          const r = { ...row };
          r.content = `[OMITTED full_len=${String(row.content).length}]\n${maskString(full, 450)}`;
          return maskRow(r);
        }
        return maskRow(row);
      });
      fs.writeFileSync(path.join(outDir, `${t}.json`), JSON.stringify(masked, null, 2), "utf8");
      summary[t] = { rows_exported: masked.length };
    } catch (e: any) {
      summary[t] = { rows_exported: 0, error: String(e?.message || e) };
    }
  }

  fs.writeFileSync(path.join(outDir, "_export_summary.json"), JSON.stringify(summary, null, 2), "utf8");
  db.close();
  console.log("Wrote to", outDir, JSON.stringify(summary));
}

main();
