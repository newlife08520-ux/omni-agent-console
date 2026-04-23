/**
 * 臨時：orders_normalized 內 SuperLanding（一頁商店）的
 *   status × fulfillment_status_raw × delivery_status_raw（payload）組合統計。
 * 執行：npx tsx server/scripts/_diag-superlanding-status-stats.ts
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
        COALESCE(json_extract(payload, '$.fulfillment_status_raw'), '(null)') AS fulfillment_status_raw,
        COALESCE(json_extract(payload, '$.delivery_status_raw'), '(null)') AS delivery_status_raw,
        COUNT(*) AS cnt
      FROM orders_normalized
      WHERE source = 'superlanding'
      GROUP BY
        status,
        json_extract(payload, '$.fulfillment_status_raw'),
        json_extract(payload, '$.delivery_status_raw')
      ORDER BY cnt DESC
    `;
    const rows = db.prepare(sql).all() as {
      status: string;
      fulfillment_status_raw: string;
      delivery_status_raw: string;
      cnt: number;
    }[];
    const total = rows.reduce((s, r) => s + r.cnt, 0);

    // 同時撈一筆 payload 範例，方便確認欄位是否真的存在
    const sample = db
      .prepare(
        `SELECT payload FROM orders_normalized WHERE source = 'superlanding' LIMIT 1`,
      )
      .get() as { payload?: string } | undefined;

    let payloadKeys: string[] = [];
    if (sample?.payload) {
      try {
        const parsed = JSON.parse(sample.payload);
        payloadKeys = Object.keys(parsed);
      } catch {
        // ignore
      }
    }

    console.log(
      JSON.stringify(
        {
          total_superlanding_rows: total,
          combinations: rows,
          sample_payload_keys: payloadKeys,
        },
        null,
        2,
      ),
    );
  } finally {
    db.close();
  }
}

main();
