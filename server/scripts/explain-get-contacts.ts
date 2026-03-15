/**
 * 第一刀驗收：getContacts 查詢計畫與耗時
 * 執行：npx tsx server/scripts/explain-get-contacts.ts（專案根目錄）
 * 會先載入 storage 以執行 migration，再對 DB 做 EXPLAIN。
 */
import Database from "better-sqlite3";
import path from "path";
import { getDataDir } from "../data-dir";

// 先執行 initDatabase（含 migration），確保 effective_case_priority 等欄位存在
await import("../storage").then((m) => m.storage);

const dbPath = path.join(getDataDir(), "omnichannel.db");
const db = new Database(dbPath, { readonly: true });

console.log("=== EXPLAIN QUERY PLAN: getContacts 主查詢（After 優化，使用 effective_case_priority）===\n");

// 目前 getContacts 實際使用的 SQL（ORDER BY 與 storage 一致）
const currentQuery = `
SELECT c.*, b.name as brand_name, ch.channel_name, u.display_name as assigned_agent_name, u.avatar_url as assigned_agent_avatar_url
FROM contacts c
LEFT JOIN brands b ON c.brand_id = b.id
LEFT JOIN channels ch ON c.channel_id = ch.id
LEFT JOIN users u ON c.assigned_agent_id = u.id
ORDER BY c.is_pinned DESC, c.effective_case_priority ASC, c.last_message_at DESC
LIMIT 100
`;

console.log("主查詢（無 WHERE）:");
const planNoWhere = db.prepare(`EXPLAIN QUERY PLAN ${currentQuery}`).all();
planNoWhere.forEach((r: any) => console.log(r.detail || r.explain));

console.log("\n主查詢（WHERE brand_id = 1）:");
const queryWithBrand = `
SELECT c.*, b.name as brand_name, ch.channel_name, u.display_name as assigned_agent_name, u.avatar_url as assigned_agent_avatar_url
FROM contacts c
LEFT JOIN brands b ON c.brand_id = b.id
LEFT JOIN channels ch ON c.channel_id = ch.id
LEFT JOIN users u ON c.assigned_agent_id = u.id
WHERE c.brand_id = 1
ORDER BY c.is_pinned DESC, c.effective_case_priority ASC, c.last_message_at DESC
LIMIT 100
`;
const planBrand = db.prepare(`EXPLAIN QUERY PLAN ${queryWithBrand}`).all();
planBrand.forEach((r: any) => console.log(r.detail || r.explain));

console.log("\n=== 舊版 getContacts 完整 SQL（Before）：主查詢 + messages 子查詢 ===\n");
const contactIds = db.prepare("SELECT id FROM contacts ORDER BY id LIMIT 100").all() as { id: number }[];
const ids = contactIds.map((r) => r.id);
const placeholders = ids.length ? ids.map(() => "?").join(",") : "0";
const oldMainQuery = `
SELECT c.*, b.name as brand_name, ch.channel_name, u.display_name as assigned_agent_name, u.avatar_url as assigned_agent_avatar_url
FROM contacts c
LEFT JOIN brands b ON c.brand_id = b.id
LEFT JOIN channels ch ON c.channel_id = ch.id
LEFT JOIN users u ON c.assigned_agent_id = u.id
ORDER BY c.is_pinned DESC, (CASE WHEN c.case_priority IS NULL THEN 999 ELSE c.case_priority END) ASC, c.last_message_at DESC
LIMIT 100
`;
console.log("舊版主查詢 EXPLAIN (無 messages 子查詢，同表):");
const oldMainPlan = db.prepare(`EXPLAIN QUERY PLAN ${oldMainQuery}`).all();
oldMainPlan.forEach((r: any) => console.log(r.detail || r.explain));

const oldSubquery = `
SELECT m.contact_id, m.content, m.sender_type
FROM messages m
INNER JOIN (
  SELECT contact_id, MAX(id) AS max_id
  FROM messages
  WHERE contact_id IN (${placeholders})
  GROUP BY contact_id
) t ON m.contact_id = t.contact_id AND m.id = t.max_id
`;
console.log("\n舊版 messages 子查詢 EXPLAIN (contactIds 規模=" + ids.length + "):");
try {
  const oldPlan = db.prepare(`EXPLAIN QUERY PLAN ${oldSubquery}`).all(...ids);
  oldPlan.forEach((r: any) => console.log(r.detail || r.explain));
} catch (e) {
  console.log("(執行失敗，可能 IN 變數過多):", (e as Error).message);
}

console.log("\n=== 耗時：storage.getContacts 直接呼叫 10 次 ===\n");
const storage = (await import("../storage")).storage;
const times: number[] = [];
for (let i = 0; i < 10; i++) {
  const t0 = Date.now();
  storage.getContacts(undefined, undefined, undefined, 100, 0);
  times.push(Date.now() - t0);
}
times.sort((a, b) => a - b);
const sum = times.reduce((a, b) => a + b, 0);
const avg = sum / times.length;
const p95 = times[Math.ceil(times.length * 0.95) - 1];
const max = times[times.length - 1];
console.log("平均(ms):", Math.round(avg));
console.log("p95(ms):", p95);
console.log("最慢(ms):", max);
console.log("10 次依序(ms):", times.join(", "));

db.close();
console.log("\nDone.");
