/**
 * Phase 2：手動同步訂單至本地索引（orders_normalized）。
 * 執行：npx tsx server/scripts/sync-orders-normalized.ts [brand_id] [days]
 * - brand_id 可選，未傳則同步所有具一頁商店設定的品牌。
 * - days 預設 7，為要同步的最近天數。
 */
import { storage } from "../storage";
import { getSuperLandingConfig } from "../superlanding";
import { fetchOrders } from "../superlanding";
import { upsertOrderNormalized } from "../order-index";

async function main() {
  const brandIdArg = process.argv[2];
  const daysArg = process.argv[3];
  const days = Math.min(90, Math.max(1, parseInt(daysArg || "7", 10) || 7));

  const brands = storage.getBrands();
  const toSync = brandIdArg
    ? brands.filter((b) => String(b.id) === brandIdArg)
    : brands.filter((b) => b.superlanding_merchant_no?.trim() && b.superlanding_access_key?.trim());

  if (toSync.length === 0) {
    console.log("無可同步品牌（請設定一頁商店 merchant_no / access_key，或指定正確 brand_id）");
    process.exit(0);
  }

  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  const beginDate = start.toISOString().split("T")[0];
  const endDate = end.toISOString().split("T")[0];

  for (const brand of toSync) {
    const config = getSuperLandingConfig(brand.id);
    if (!config.merchantNo || !config.accessKey) continue;
    console.log(`[Sync] Brand ${brand.id} (${brand.name}) ${beginDate} ~ ${endDate} ...`);
    let page = 1;
    const perPage = 200;
    const maxPages = 50;
    let total = 0;
    try {
      while (true) {
        const orders = await fetchOrders(config, {
          begin_date: beginDate,
          end_date: endDate,
          per_page: String(perPage),
          page: String(page),
        });
        for (const order of orders) {
          upsertOrderNormalized(brand.id, "superlanding", order);
          total++;
        }
        if (orders.length < perPage) break;
        page++;
        if (page > maxPages) break;
      }
      console.log(`[Sync] Brand ${brand.id} 寫入 ${total} 筆`);
    } catch (e: any) {
      console.error(`[Sync] Brand ${brand.id} 失敗:`, e?.message || e);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
