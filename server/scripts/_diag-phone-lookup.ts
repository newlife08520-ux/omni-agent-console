import db from "../db";
import {
  getOrdersByPhoneMerged,
  normalizePhone,
  getOrderLookupCache,
  cacheKeyPhone,
} from "../order-index";

console.log("========== 診斷 1：brandId ==========\n");
const rows = db
  .prepare(
    "SELECT brand_id, global_order_id, buyer_phone_normalized, source FROM orders_normalized WHERE buyer_phone_normalized = '0962090673' LIMIT 5"
  )
  .all();
console.log("brand_id 分布：", rows);

const b1 = db
  .prepare(
    "SELECT COUNT(*) as cnt FROM orders_normalized WHERE brand_id = 1 AND buyer_phone_normalized != ''"
  )
  .get();
console.log("品牌1 有手機號的訂單數：", b1);

const exact = db
  .prepare(
    "SELECT COUNT(*) as cnt FROM orders_normalized WHERE brand_id = 1 AND buyer_phone_normalized = '0962090673'"
  )
  .get();
console.log("品牌1 + 0962090673：", exact);

console.log("\n========== 診斷 2：實際查詢路徑 ==========\n");
const phone = "0962090673";
const brandId = 1;
console.log("normalizePhone 結果：", normalizePhone(phone));
const results = getOrdersByPhoneMerged(brandId, phone);
console.log("getOrdersByPhoneMerged 結果數：", results.length);
if (results.length > 0) {
  console.log("第一筆：", results[0].global_order_id, results[0].source);
} else {
  console.log("查無結果！");
}

console.log("\n========== 診斷 3：order_lookup_cache ==========\n");
const ck1 = cacheKeyPhone(1, "0962090673", "any");
const ck2 = cacheKeyPhone(1, "0962090673", "superlanding");
const ck3 = cacheKeyPhone(1, "0962090673", "shopline");
console.log("cache key any:", ck1, "→", getOrderLookupCache(ck1));
console.log("cache key sl:", ck2, "→", getOrderLookupCache(ck2));
console.log("cache key shopline:", ck3, "→", getOrderLookupCache(ck3));

const deleted = db
  .prepare("DELETE FROM order_lookup_cache WHERE cache_key LIKE '%0962090673%'")
  .run();
console.log("清除 cache：", deleted.changes, "筆");
