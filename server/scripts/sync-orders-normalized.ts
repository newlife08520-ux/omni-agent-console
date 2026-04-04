/**
 * Phase 2 / 2.9：手動同步訂單至本地索引（orders_normalized）。
 *
 * 執行：
 *   npx tsx server/scripts/sync-orders-normalized.ts [brand_id] [days]
 *   npx tsx server/scripts/sync-orders-normalized.ts [brand_id] --backfill
 *
 * - 預設 days：**90**（Phase 2.9 由 7 調高，避免 older orders 進不了索引）
 * - **--backfill**：歷史回填，一頁商店與 Shopline 皆用 **365** 天視窗
 * - Shopline：列表 API 分頁後以 created_at 過濾時間窗內訂單
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { storage } from "../storage";
import { getSuperLandingConfig, fetchOrders } from "../superlanding";
import { upsertOrderNormalized, getOrderIndexStats } from "../order-index";
import { fetchShoplineOrdersListPaginated } from "../shopline";

export async function runOrderSync(options?: {
  brandId?: number;
  days?: number;
  backfill?: boolean;
}): Promise<{ synced: number; errors: number }> {
  const backfill = options?.backfill === true;
  const days = backfill ? 365 : Math.min(365, Math.max(1, options?.days ?? 90));

  let totalSynced = 0;
  let totalErrors = 0;

  console.log(
    `[sync-orders-normalized] mode=${backfill ? "HISTORICAL_BACKFILL_365D" : "DEFAULT_RECENT"} days=${days} (default_recent=90, backfill=365)`
  );

  const brands = storage.getBrands();
  const targetBrands =
    options?.brandId != null ? brands.filter((b) => b.id === options.brandId) : brands;

  if (targetBrands.length === 0) {
    console.log("無符合品牌（請傳正確 brand_id）");
    return { synced: 0, errors: 0 };
  }

  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  const beginDate = start.toISOString().split("T")[0];
  const endDate = end.toISOString().split("T")[0];
  const startMs = start.getTime();

  for (const brand of targetBrands) {
    const config = getSuperLandingConfig(brand.id);
    if (config.merchantNo && config.accessKey) {
      console.log(`[Sync SL] Brand ${brand.id} (${brand.name}) ${beginDate} ~ ${endDate}（${days} 天）...`);
      let page = 1;
      const perPage = 200;
      const maxPages = backfill ? 80 : 50;
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
        totalSynced += total;
      } catch (e: any) {
        totalErrors++;
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
          maxPages: backfill ? 80 : 50,
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
        totalSynced += n;
      } catch (e: any) {
        totalErrors++;
        console.error(`[Sync Shopline] Brand ${brand.id} 失敗:`, e?.message || e);
      }
    }
  }

  try {
    const stats = getOrderIndexStats();
    console.log("[Order index stats]", JSON.stringify(stats, null, 2));
  } catch (_e) {
    /* ignore */
  }

  return { synced: totalSynced, errors: totalErrors };
}

function isDirectCliRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return entry.includes("sync-orders-normalized");
  }
}

if (isDirectCliRun()) {
  const argv = process.argv.slice(2);
  const backfill = argv.includes("--backfill") || argv.includes("--full");
  const rest = argv.filter((a) => a !== "--backfill" && a !== "--full");
  const brandIdArgResolved = rest[0] && /^\d+$/.test(rest[0]) ? parseInt(rest[0], 10) : undefined;
  const daysFromArg = rest[1] && /^\d+$/.test(rest[1]) ? parseInt(rest[1], 10) : undefined;

  runOrderSync({
    brandId: brandIdArgResolved,
    days: daysFromArg,
    backfill,
  })
    .then((r) => {
      console.log(`同步完成：${r.synced} 筆成功，${r.errors} 筆失敗（區塊錯誤計數）`);
      process.exit(0);
    })
    .catch((e) => {
      console.error("同步失敗:", e);
      process.exit(1);
    });
}
