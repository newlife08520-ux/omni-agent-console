/**
 * 匯出給 AI 解析用：全域/品牌 system_prompt（人格）、相關設定鍵、近期 ai_logs。
 * Phase 31：預設 redact 敏感鍵、遮罩 PII，bundle 不得帶出 secret／個資。
 * 用法：node scripts/export-ai-bundle-context.mjs <輸出.json>
 * 環境：DATA_DIR（可選）、EXPORT_RAW_SECRETS=1（僅除錯用，預設不輸出 raw secret）
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const allowRawSecrets = process.env.EXPORT_RAW_SECRETS === "1";

const SENSITIVE_KEY_PATTERN = /api_key|apikey|secret|password|token|access_key|auth|credential/i;

function redactValue(key, value) {
  if (value == null || typeof value !== "string") return value;
  if (allowRawSecrets) return value;
  if (SENSITIVE_KEY_PATTERN.test(String(key))) return "[REDACTED]";
  return value;
}

function maskPII(str) {
  if (str == null || typeof str !== "string") return str;
  let s = str;
  s = s.replace(/09\d{8}/g, "09********");
  s = s.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[EMAIL]");
  s = s.replace(/\d{3,4}[- ]?\d{3,4}[- ]?\d{4}/g, "[PHONE]");
  return s;
}

function getDataDir() {
  if (process.env.DATA_DIR?.trim()) return path.resolve(process.env.DATA_DIR.trim());
  if (process.env.NODE_ENV === "production") return "/data";
  return root;
}

const outPath = process.argv[2] || path.join(root, "AI-BUNDLE-CONTEXT.json");

async function main() {
  const dataDir = getDataDir();
  const dbPath = path.join(dataDir, "omnichannel.db");
  const base = {
    exported_at: new Date().toISOString(),
    note: "人格＝settings.system_prompt（全域）+ brands.system_prompt（品牌）。回覆邏輯見 server/routes.ts。此 bundle 已做 secret redact 與 PII 遮罩。",
    db_path_attempted: allowRawSecrets ? dbPath : "[REDACTED_PATH]",
    db_found: fs.existsSync(dbPath),
    global_system_prompt: null,
    brands_persona: [],
    settings_ai_related: {},
    recent_ai_logs: [],
    export_error: null,
  };

  if (!fs.existsSync(dbPath)) {
    base.export_error = `找不到資料庫：${dbPath}。請在專案目錄執行或設定 DATA_DIR 指向含 omnichannel.db 的目錄後再匯出。`;
    fs.writeFileSync(outPath, JSON.stringify(base, null, 2), "utf8");
    console.log("Wrote", outPath, "(no DB)");
    return;
  }

  let db;
  try {
    const { default: Database } = await import("better-sqlite3");
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (e) {
    base.export_error = `無法開啟 DB（唯讀）：${e?.message || e}`;
    fs.writeFileSync(outPath, JSON.stringify(base, null, 2), "utf8");
    console.log("Wrote", outPath, "(open failed)");
    return;
  }

  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get("system_prompt");
    base.global_system_prompt = row?.value ?? "";

    const brands = db
      .prepare("SELECT id, name, slug, system_prompt FROM brands ORDER BY id")
      .all();
    base.brands_persona = brands.map((b) => ({
      id: b.id,
      name: b.name,
      slug: b.slug,
      system_prompt: b.system_prompt || "",
    }));

    const keys = db.prepare("SELECT key, value FROM settings").all();
    for (const { key, value } of keys) {
      const k = String(key || "");
      if (
        /prompt|persona|人格|ai_|model|openai|llm|system/i.test(k) ||
        k === "system_prompt"
      ) {
        let v = String(value ?? "");
        v = redactValue(k, v);
        if (typeof v === "string" && !v.includes("[REDACTED]")) v = maskPII(v);
        base.settings_ai_related[k] = v.length > 8000 ? v.slice(0, 8000) + "\n…(truncated)" : v;
      }
    }

    const logs = db
      .prepare(
        `SELECT id, contact_id, brand_id, reply_source, used_llm, plan_mode, reason_if_bypassed,
         transfer_triggered, transfer_reason, prompt_profile, reply_renderer, result_summary,
         model, response_time_ms, created_at
         FROM ai_logs ORDER BY id DESC LIMIT 80`
      )
      .all();
    base.recent_ai_logs = logs.map((r) => {
      let summary = r.result_summary;
      if (summary != null) {
        summary = String(summary);
        if (summary.length > 1200) summary = summary.slice(0, 1200) + "…";
        summary = maskPII(summary);
      }
      return { ...r, result_summary: summary };
    });
  } catch (e) {
    base.export_error = String(e?.message || e);
  } finally {
    try {
      db.close();
    } catch (_) {}
  }

  fs.writeFileSync(outPath, JSON.stringify(base, null, 2), "utf8");
  console.log("OK:", outPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
