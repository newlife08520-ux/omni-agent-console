/**
 * 依 LINE display_name 在 AQUILA／天鷹座品牌下查 contacts，並可選呼叫 GET /api/admin/contact-state/:id
 * 用法（在專案根目錄，與 omnichannel.db 同目錄或設 DATA_DIR）：
 *   npx tsx server/scripts/query-aquila-contacts-by-line-names.ts
 *   BASE_URL=http://127.0.0.1:5000 ADMIN_DEBUG_TOKEN=xxx npx tsx server/scripts/query-aquila-contacts-by-line-names.ts
 */
import Database from "better-sqlite3";
import path from "path";
import { getDataDir } from "../data-dir";

const dbPath = path.join(getDataDir(), "omnichannel.db");
const db = new Database(dbPath);

function handoffFlag(row: {
  needs_human: number;
  status: string;
}): boolean {
  return (
    row.needs_human === 1 ||
    row.status === "awaiting_human" ||
    row.status === "high_risk"
  );
}

const sql = `
SELECT
  c.display_name AS name,
  c.id AS contact_id,
  c.status AS contact_state,
  c.needs_human,
  COALESCE(ch.is_ai_enabled, -1) AS channel_ai_enabled,
  c.last_message_at AS last_msg_at,
  b.id AS brand_id,
  b.name AS brand_name
FROM contacts c
INNER JOIN brands b ON c.brand_id = b.id
LEFT JOIN channels ch ON c.channel_id = ch.id
WHERE (
  LOWER(COALESCE(b.name, '')) LIKE '%aquila%'
  OR b.name LIKE '%天鷹%'
)
AND (
  TRIM(c.display_name) IN ('Jie', '詠全', '林芷蕎', '剉麻那')
  OR TRIM(c.display_name) LIKE '%童永志%'
  OR TRIM(c.display_name) LIKE '%鍵億管線%'
)
ORDER BY c.id
`;

const rows = db.prepare(sql).all() as {
  name: string;
  contact_id: number;
  contact_state: string;
  needs_human: number;
  channel_ai_enabled: number;
  last_msg_at: string | null;
  brand_id: number;
  brand_name: string;
}[];

console.log("DB:", dbPath);
console.log("");
console.log("| name | contact_id | state | ai_enabled | handoff | last_msg_at |");
console.log("| --- | --- | --- | --- | --- | --- |");
for (const r of rows) {
  const ai =
    r.channel_ai_enabled === -1 ? "null" : r.channel_ai_enabled === 1 ? "1" : "0";
  const ho = handoffFlag({ needs_human: r.needs_human, status: r.contact_state }) ? "true" : "false";
  const last = r.last_msg_at ?? "null";
  console.log(`| ${r.name} | ${r.contact_id} | ${r.contact_state} | ${ai} | ${ho} | ${last} |`);
}

const base = process.env.BASE_URL?.replace(/\/$/, "");
const tok = process.env.ADMIN_DEBUG_TOKEN?.trim();
if (base && tok) {
  console.log("\n--- contact-state JSON ---\n");
  for (const r of rows) {
    const url = `${base}/api/admin/contact-state/${r.contact_id}?token=${encodeURIComponent(tok)}`;
    const res = await fetch(url);
    const text = await res.text();
    console.log(`# contact_id=${r.contact_id} HTTP ${res.status}`);
    console.log(text);
    console.log("");
  }
} else {
  console.log("\n(略過 HTTP：請設定 BASE_URL 與 ADMIN_DEBUG_TOKEN 以抓取 /api/admin/contact-state)");
  for (const r of rows) {
    console.log(`curl "${base ?? "http://127.0.0.1:PORT"}/api/admin/contact-state/${r.contact_id}?token=ADMIN_DEBUG_TOKEN"`);
  }
}

db.close();
