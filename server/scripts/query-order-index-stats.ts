/**
 * 查詢 orders_normalized / order_lookup_cache 統計，供 Shopline Integration Truth Report 使用。
 * 執行：npx tsx server/scripts/query-order-index-stats.ts
 */
import "../data-dir";
import db from "../db";

function main() {
  console.log("=== orders_normalized 各 source 筆數 ===");
  const bySource = db.prepare(
    "SELECT source, COUNT(*) as cnt FROM orders_normalized GROUP BY source"
  ).all() as { source: string; cnt: number }[];
  for (const row of bySource) {
    console.log(`  source=${row.source}  count=${row.cnt}`);
  }
  if (bySource.length === 0) console.log("  (無資料)");

  console.log("\n=== order_lookup_cache 總筆數 ===");
  const cacheTotal = db.prepare("SELECT COUNT(*) as cnt FROM order_lookup_cache").get() as { cnt: number };
  console.log("  total:", cacheTotal.cnt);

  console.log("\n=== order_lookup_cache 依 key 前綴（order_id vs phone）===");
  const cacheKeys = db.prepare("SELECT cache_key FROM order_lookup_cache").all() as { cache_key: string }[];
  let orderIdKeys = 0;
  let phoneKeys = 0;
  for (const r of cacheKeys) {
    if (r.cache_key.startsWith("order_id:")) orderIdKeys++;
    else if (r.cache_key.startsWith("phone:")) phoneKeys++;
  }
  console.log("  order_id:* count:", orderIdKeys);
  console.log("  phone:* count:", phoneKeys);

  console.log("\n=== 最近 10 筆 source=shopline 的 orders_normalized ===");
  const shoplineRows = db.prepare(
    "SELECT id, brand_id, source, global_order_id, buyer_phone_normalized, synced_at FROM orders_normalized WHERE source = ? ORDER BY synced_at DESC LIMIT 10"
  ).all("shopline") as { id: number; brand_id: number; source: string; global_order_id: string; buyer_phone_normalized: string; synced_at: string }[];
  if (shoplineRows.length === 0) {
    console.log("  (無 source=shopline 資料)");
  } else {
    for (const r of shoplineRows) {
      console.log(`  id=${r.id} brand_id=${r.brand_id} order_id=${r.global_order_id} phone_norm=${r.buyer_phone_normalized} synced_at=${r.synced_at}`);
    }
  }
}

main();
