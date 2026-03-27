/**
 * 審查 bundle 用：從 omnichannel.db 匯出指定表為 JSON（PII / 長識別碼遮罩）。
 * 不含 .db / .db-wal；供 ChatGPT 檢視 schema 與資料型態，非還原用備份。
 *
 * 用法: node scripts/export-review-db-masked.mjs <輸出目錄>
 * 環境: DATA_DIR（可選，與 export-ai-bundle-context 相同）
 *       REVIEW_DB_LIMIT_ORDERS=5000 REVIEW_DB_LIMIT_MESSAGES=2500 REVIEW_DB_LIMIT_AI_LOGS=2500 ...
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function numEnv(name, def) {
  const v = process.env[name];
  if (v == null || v === "") return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

const LIMITS = {
  orders_normalized: numEnv("REVIEW_DB_LIMIT_ORDERS", 8000),
  order_lookup_cache: numEnv("REVIEW_DB_LIMIT_CACHE", 5000),
  messages: numEnv("REVIEW_DB_LIMIT_MESSAGES", 2500),
  ai_logs: numEnv("REVIEW_DB_LIMIT_AI_LOGS", 2500),
  contact_active_order: numEnv("REVIEW_DB_LIMIT_ACTIVE_ORDER", 5000),
};

function getDataDir() {
  if (process.env.DATA_DIR?.trim()) return path.resolve(process.env.DATA_DIR.trim());
  if (process.env.NODE_ENV === "production") return "/data";
  return root;
}

function maskPII(str) {
  if (str == null || typeof str !== "string") return str;
  let s = str;
  s = s.replace(/09\d{8}/g, "09********");
  s = s.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[EMAIL]");
  s = s.replace(/\d{3,4}[- ]?\d{3,4}[- ]?\d{4}/g, "[PHONE]");
  s = s.replace(/\b\d{10,20}\b/g, (m) => (m.length <= 6 ? m : m.slice(0, 4) + "***" + m.slice(-2)));
  return s;
}

function maskOrderIdLike(s) {
  if (typeof s !== "string" || s.length < 6) return s;
  if (/^[A-Za-z0-9_-]{6,40}$/.test(s)) return s.slice(0, 4) + "***" + (s.length > 8 ? s.slice(-2) : "");
  return maskPII(s);
}

function maskDeep(value, depth = 0) {
  if (depth > 14) return "[DEPTH_TRUNC]";
  if (value == null) return value;
  if (typeof value === "string") return maskPII(value);
  if (typeof value === "number") return value;
  if (Array.isArray(value)) return value.map((x) => maskDeep(x, depth + 1));
  if (typeof value === "object") {
    const o = {};
    for (const [k, v] of Object.entries(value)) {
      const lk = String(k).toLowerCase();
      if (/phone|mobile|tel|email|token|secret|password|apikey|access_token|line_user|userid|address|recipient/i.test(lk)) {
        if (typeof v === "string") o[k] = maskPII(v);
        else o[k] = maskDeep(v, depth + 1);
      } else o[k] = maskDeep(v, depth + 1);
    }
    return o;
  }
  return value;
}

function maskJsonField(raw) {
  if (raw == null || raw === "") return raw;
  const s = String(raw);
  try {
    const j = JSON.parse(s);
    return JSON.stringify(maskDeep(j));
  } catch {
    return maskPII(s);
  }
}

function tableExists(db, name) {
  const r = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
  return !!r;
}

function exportTable(db, table, limit, columnMaskHints, orderByCol) {
  if (!tableExists(db, table)) {
    return { _export_note: `table_missing: ${table}`, rows: [] };
  }
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  const names = cols.map((c) => c.name);
  const ob =
    orderByCol && names.includes(orderByCol)
      ? orderByCol
      : names.includes("id")
        ? "id"
        : names.includes("created_at")
          ? "created_at"
          : null;
  const orderSql = ob
    ? `SELECT * FROM ${table} ORDER BY ${ob} DESC LIMIT ?`
    : `SELECT * FROM ${table} LIMIT ?`;
  const rows = db.prepare(orderSql).all(limit);
  const masked = rows.map((row) => {
    const out = {};
    for (const k of names) {
      let v = row[k];
      const hint = columnMaskHints[k];
      if (hint === "json") v = maskJsonField(v);
      else if (hint === "phone_norm") v = typeof v === "string" ? maskPII(v) : v;
      else if (hint === "order_id") v = typeof v === "string" ? maskOrderIdLike(v) : v;
      else if (typeof v === "string") v = maskPII(v);
      out[k] = v;
    }
    return out;
  });
  return { row_count_returned: masked.length, row_limit: limit, rows: masked };
}

async function main() {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error("Usage: node scripts/export-review-db-masked.mjs <output_directory>");
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });

  const dataDir = getDataDir();
  const dbPath = path.join(dataDir, "omnichannel.db");
  const meta = {
    exported_at: new Date().toISOString(),
    db_location_note: "omnichannel.db under DATA_DIR or project root (path redacted in bundle)",
    db_found: fs.existsSync(dbPath),
    limits: LIMITS,
    tables: {},
    note:
      "PII masked JSON exports for review. active_order_context maps to SQLite table contact_active_order. No .db/.wal in bundle.",
  };

  if (!fs.existsSync(dbPath)) {
    meta.export_error =
      "DB not found (omnichannel.db). Set DATA_DIR or run from project directory where DB exists.";
    fs.writeFileSync(path.join(outDir, "_export_meta.json"), JSON.stringify(meta, null, 2), "utf8");
    console.log("Wrote stub (no DB):", outDir);
    return;
  }

  let db;
  try {
    const { default: Database } = await import("better-sqlite3");
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (e) {
    meta.export_error = String(e?.message || e);
    fs.writeFileSync(path.join(outDir, "_export_meta.json"), JSON.stringify(meta, null, 2), "utf8");
    console.log("Wrote stub (open failed):", outDir);
    return;
  }

  try {
    meta.tables.orders_normalized = exportTable(
      db,
      "orders_normalized",
      LIMITS.orders_normalized,
      {
        payload: "json",
        buyer_phone_normalized: "phone_norm",
        global_order_id: "order_id",
        page_id: "order_id",
      }
    );
    meta.tables.order_lookup_cache = exportTable(db, "order_lookup_cache", LIMITS.order_lookup_cache, {
      result_payload: "json",
      cache_key: "phone_norm",
    });
    meta.tables.messages = exportTable(db, "messages", LIMITS.messages, {
      content: "phone_norm",
      image_url: "phone_norm",
    });
    meta.tables.ai_logs = exportTable(db, "ai_logs", LIMITS.ai_logs, {
      knowledge_hits: "json",
      tools_called: "json",
    });
    meta.tables.contact_active_order = exportTable(
      db,
      "contact_active_order",
      LIMITS.contact_active_order,
      {
        order_id: "order_id",
        payload: "json",
        matched_confidence: "json",
      },
      "contact_id"
    );

    fs.writeFileSync(
      path.join(outDir, "orders_normalized.masked.json"),
      JSON.stringify(meta.tables.orders_normalized, null, 2),
      "utf8"
    );
    fs.writeFileSync(
      path.join(outDir, "order_lookup_cache.masked.json"),
      JSON.stringify(meta.tables.order_lookup_cache, null, 2),
      "utf8"
    );
    fs.writeFileSync(
      path.join(outDir, "messages.masked.json"),
      JSON.stringify(meta.tables.messages, null, 2),
      "utf8"
    );
    fs.writeFileSync(
      path.join(outDir, "ai_logs.masked.json"),
      JSON.stringify(meta.tables.ai_logs, null, 2),
      "utf8"
    );
    fs.writeFileSync(
      path.join(outDir, "active_order_context.masked.json"),
      JSON.stringify(
        {
          _note:
            "SQLite table name: contact_active_order (active order context for order lookup thread). Same rows as contact_active_order export.",
          ...meta.tables.contact_active_order,
        },
        null,
        2
      ),
      "utf8"
    );
    fs.writeFileSync(
      path.join(outDir, "contact_active_order.masked.json"),
      JSON.stringify(meta.tables.contact_active_order, null, 2),
      "utf8"
    );
    fs.writeFileSync(path.join(outDir, "_export_meta.json"), JSON.stringify(meta, null, 2), "utf8");

    const readme = `# db_export_masked

遮罩後的資料表快照（JSON），**非**完整資料庫備份；bundle 內刻意不含 \`.db\` / \`.db-wal\`。

| 檔案 | 來源表 |
|------|--------|
| orders_normalized.masked.json | orders_normalized |
| order_lookup_cache.masked.json | order_lookup_cache |
| messages.masked.json | messages |
| ai_logs.masked.json | ai_logs |
| active_order_context.masked.json | **contact_active_order**（查單主線「目前訂單上下文」） |
| contact_active_order.masked.json | 同上表（重複一份方便搜尋表名） |
| _export_meta.json | 匯出時間、筆數上限、錯誤訊息 |

筆數上限可用環境變數調整：REVIEW_DB_LIMIT_ORDERS、REVIEW_DB_LIMIT_MESSAGES、REVIEW_DB_LIMIT_AI_LOGS 等。
`;
    fs.writeFileSync(path.join(outDir, "README.md"), readme, "utf8");
    console.log("OK:", outDir);
  } finally {
    try {
      db.close();
    } catch (_) {}
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
