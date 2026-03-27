/**
 * 寫入 verify_output 用的 parity 檔（與 diagnose / stats 同一 getDataDir）。
 * 用法: npx tsx server/scripts/emit-runtime-parity-artifacts.ts <輸出目錄>
 */
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { getDataDir } from "../data-dir";
import { getOrderIndexStats } from "../order-index";

function safeCount(db: Database.Database, sql: string): number {
  try {
    const row = db.prepare(sql).get() as { c: number };
    return row?.c ?? 0;
  } catch {
    return -1;
  }
}

function main() {
  const outDir = path.resolve(process.argv[2] || ".");
  fs.mkdirSync(outDir, { recursive: true });

  const dataDir = getDataDir();
  const dbPath = path.join(dataDir, "omnichannel.db");
  const identity = {
    generated_at: new Date().toISOString(),
    node_env: process.env.NODE_ENV ?? null,
    data_dir_env: process.env.DATA_DIR?.trim() || null,
    cwd: process.cwd(),
    resolved_data_dir: dataDir,
    db_path: dbPath,
    db_exists: fs.existsSync(dbPath),
    note: "與 diagnose-review-bundle-db、export-review-db-masked、stats:order-index 相同 getDataDir()",
  };
  fs.writeFileSync(path.join(outDir, "runtime_db_identity.txt"), JSON.stringify(identity, null, 2), "utf8");

  const stats = getOrderIndexStats();
  fs.writeFileSync(
    path.join(outDir, "stats_order_index_live.txt"),
    JSON.stringify(stats, null, 2) + "\n",
    "utf8"
  );

  const diag: Record<string, unknown> = {
    ...identity,
    table_counts: {} as Record<string, number>,
    orders_normalized_by_source: {} as Record<string, number>,
    brands: { total: 0, shopline_configured: 0 },
  };

  if (identity.db_exists) {
    const db = new Database(dbPath, { readonly: true });
    try {
      const tables = [
        "orders_normalized",
        "order_items_normalized",
        "product_aliases",
        "order_lookup_cache",
        "contact_active_order",
        "ai_logs",
        "messages",
        "contacts",
      ];
      const tc = diag.table_counts as Record<string, number>;
      for (const t of tables) {
        tc[t] = safeCount(db, `SELECT COUNT(*) AS c FROM "${t}"`);
      }
      const srcRows = db
        .prepare(`SELECT COALESCE(source, '') AS s, COUNT(*) AS c FROM orders_normalized GROUP BY source`)
        .all() as { s: string; c: number }[];
      const by = diag.orders_normalized_by_source as Record<string, number>;
      for (const r of srcRows) {
        by[r.s || "(null)"] = r.c;
      }
      (diag.brands as { total: number; shopline_configured: number }).total = safeCount(
        db,
        `SELECT COUNT(*) AS c FROM brands`
      );
      (diag.brands as { total: number; shopline_configured: number }).shopline_configured = safeCount(
        db,
        `SELECT COUNT(*) AS c FROM brands WHERE TRIM(COALESCE(shopline_api_token,'')) != '' AND TRIM(COALESCE(shopline_store_domain,'')) != ''`
      );
    } finally {
      db.close();
    }
  }

  fs.writeFileSync(
    path.join(outDir, "diagnose_review_bundle_db_live.txt"),
    JSON.stringify(diag, null, 2) + "\n",
    "utf8"
  );

  fs.writeFileSync(
    path.join(outDir, "live_db_table_counts.txt"),
    JSON.stringify(
      {
        generated_at: identity.generated_at,
        table_counts: (diag.table_counts as Record<string, number>) || {},
        stats_order_index: stats,
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  console.log("[emit-runtime-parity] wrote:", outDir);
}

main();
