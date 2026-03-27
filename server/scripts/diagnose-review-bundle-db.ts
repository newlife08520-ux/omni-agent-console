/**
 * Review bundle / 審計用：列印目前行程解析到的 DB 路徑與關鍵表列數（無遮罩、僅計數與品牌 Shopline 是否「有設定」）。
 * 與 `scripts/export-review-db-masked.mjs` 對照時，請確認 **同一 DATA_DIR / cwd**。
 *
 * 執行：npx tsx server/scripts/diagnose-review-bundle-db.ts
 */
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { getDataDir } from "../data-dir";

function safeCount(db: Database.Database, sql: string): number {
  try {
    const row = db.prepare(sql).get() as { c: number };
    return row?.c ?? 0;
  } catch {
    return -1;
  }
}

function main() {
  const dataDir = getDataDir();
  const dbPath = path.join(dataDir, "omnichannel.db");
  const out = {
    node_env: process.env.NODE_ENV ?? null,
    data_dir_env: process.env.DATA_DIR?.trim() || null,
    resolved_data_dir: dataDir,
    cwd: process.cwd(),
    db_path: dbPath,
    db_exists: fs.existsSync(dbPath),
    table_counts: {} as Record<string, number>,
    orders_normalized_by_source: {} as Record<string, number>,
    brands: { total: 0, shopline_configured: 0 } as {
      total: number;
      shopline_configured: number;
    },
  };

  if (!out.db_exists) {
    console.log(JSON.stringify(out, null, 2));
    console.error("[diagnose-review-bundle-db] DB 檔不存在，請檢查 DATA_DIR 與 cwd。");
    process.exit(1);
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    const tables = [
      "orders_normalized",
      "order_lookup_cache",
      "contact_active_order",
      "ai_logs",
      "messages",
      "contacts",
    ];
    for (const t of tables) {
      out.table_counts[t] = safeCount(db, `SELECT COUNT(*) AS c FROM "${t}"`);
    }

    const srcRows = db
      .prepare(
        `SELECT COALESCE(source, '') AS s, COUNT(*) AS c FROM orders_normalized GROUP BY source`
      )
      .all() as { s: string; c: number }[];
    for (const r of srcRows) {
      out.orders_normalized_by_source[r.s || "(null)"] = r.c;
    }

    out.brands.total = safeCount(db, `SELECT COUNT(*) AS c FROM brands`);
    out.brands.shopline_configured = safeCount(
      db,
      `SELECT COUNT(*) AS c FROM brands WHERE TRIM(COALESCE(shopline_api_token,'')) != '' AND TRIM(COALESCE(shopline_store_domain,'')) != ''`
    );
  } finally {
    db.close();
  }

  console.log(JSON.stringify(out, null, 2));
}

main();
