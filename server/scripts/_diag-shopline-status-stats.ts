/**
 * 臨時：orders_normalized 內 Shopline 的 status × delivery_status_raw（payload）組合統計。
 * 執行：npx tsx server/scripts/_diag-shopline-status-stats.ts
 */
import path from "path";
import Database from "better-sqlite3";
import { getDataDir } from "../data-dir";

function main() {
  const dbPath = path.join(getDataDir(), "omnichannel.db");
  const db = new Database(dbPath, { readonly: true });
  try {
    const sql = `
      SELECT
        COALESCE(status, '(null)') AS status,
        COALESCE(json_extract(payload, '$.delivery_status_raw'), '(null)') AS delivery_status_raw,
        COUNT(*) AS cnt
      FROM orders_normalized
      WHERE source = 'shopline'
      GROUP BY status, json_extract(payload, '$.delivery_status_raw')
      ORDER BY cnt DESC
    `;
    const rows = db.prepare(sql).all() as {
      status: string;
      delivery_status_raw: string;
      cnt: number;
    }[];
    const total = rows.reduce((s, r) => s + r.cnt, 0);
    console.log(JSON.stringify({ total_shopline_rows: total, combinations: rows }, null, 2));
  } finally {
    db.close();
  }
}

main();
