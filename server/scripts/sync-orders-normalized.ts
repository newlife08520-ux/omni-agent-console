/**
 * Phase 2：手動同步訂單至本地索引（orders_normalized）。
 * 執行：npx tsx server/scripts/sync-orders-normalized.ts [brand_id] [days]
 * - 一頁商店：依日期拉取 SuperLanding 訂單。
 * - Shopline：依列表 API 分頁拉取，再以 created_at 過濾最近 N 天。
 */
import { storage } from "../storage";
import { getSuperLandingConfig } from "../superlanding";
import { fetchOrders } from "../superlanding";
import { upsertOrderNormalized } from "../order-index";
import { fetchShoplineOrdersListPaginated } from "../shopline";

async function main() {
  const brandIdArg = process.argv[2];
  const daysArg = process.argv[3];
  const days = Math.min(90, Math.max(1, parseInt(daysArg || "7", 10) || 7));

  const brands = storage.getBrands();
  const targetBrands = brandIdArg
    ? brands.filter((b) => String(b.id) === brandIdArg)
    : brands;

  if (targetBrands.length === 0) {
    console.log("無符合品牌（請傳正確 brand_id）");
    process.exit(0);
  }

  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  const beginDate = start.toISOString().split("T")[0];
  const endDate = end.toISOString().split("T")[0];
  const startMs = start.getTime();

  for (const brand of targetBrands) {
    const config = getSuperLandingConfig(brand.id);
    if (config.merchantNo && config.accessKey) {
      console.log(`[Sync SL] Brand ${brand.id} (${brand.name}) ${beginDate} ~ ${endDate} ...`);
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
        console.log(`[Sync SL] Brand ${brand.id} 寫入 ${total} 筆`);
      } catch (e: any) {
        console.error(`[Sync SL] Brand ${brand.id} 失敗:`, e?.message || e);
      }
    }

    const token = brand.shopline_api_token?.trim();
    if (token) {
      console.log(`[Sync Shopline] Brand ${brand.id} (${brand.name}) 最近 ${days} 天 ...`);
      try {
        const cfg = {
          storeDomain: (brand.shopline_store_domain || "").trim(),
          apiToken: token,
        };
        const { orders, pagesFetched } = await fetchShoplineOrdersListPaginated(cfg, {
          maxPages: 50,
          perPage: 100,
        });
        let n = 0;
        for (const o of orders) {
          const t = new Date(o.created_at || o.order_created_at || 0).getTime();
          if (t < startMs) continue;
          upsertOrderNormalized(brand.id, "shopline", o);
          n++;
        }
        console.log(`[Sync Shopline] Brand ${brand.id} pages=${pagesFetched} 寫入 ${n} 筆（時間窗內）`);
      } catch (e: any) {
        console.error(`[Sync Shopline] Brand ${brand.id} 失敗:`, e?.message || e);
      }
    }
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
