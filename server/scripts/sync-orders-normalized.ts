/**
 * Phase 2 / 2.9：手動同步訂單至本地索引（orders_normalized）。
 *
 * 執行：
 *   npx tsx server/scripts/sync-orders-normalized.ts [brand_id] [days]
 *   npx tsx server/scripts/sync-orders-normalized.ts [brand_id] --backfill
 *   npx tsx server/scripts/sync-orders-normalized.ts [brand_id] --from YYYY-MM-DD --to YYYY-MM-DD
 *
 * - 預設 days：**90**（Phase 2.9 由 7 調高，避免 older orders 進不了索引）
 * - **--backfill**：歷史回填，一頁商店與 Shopline 皆用 **365** 天視窗
 * - Shopline：列表 API 分頁後以 created_at 過濾時間窗內訂單
 * - 分頁上限：一般 maxPages=100（SL 每頁 200≈2 萬筆／次）、backfill 時 200；超量請分批執行
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { storage } from "../storage";
import { getSuperLandingConfig, fetchOrders } from "../superlanding";
import { upsertOrderNormalized, getOrderIndexStats } from "../order-index";
import { fetchShoplineOrdersListPaginated } from "../shopline";

function isYmd(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s.trim());
}

type SyncWindow = {
  beginDate: string;
  endDate: string;
  startMs: number;
  endMs: number | null;
};

function windowFromDays(days: number): SyncWindow {
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  return {
    beginDate: start.toISOString().split("T")[0],
    endDate: end.toISOString().split("T")[0],
    startMs: start.getTime(),
    endMs: null,
  };
}

export async function runOrderSync(options?: {
  brandId?: number;
  days?: number;
  backfill?: boolean;
  /** 與 toDate 併用：YYYY-MM-DD，分段拉歷史 */
  fromDate?: string;
  /** 與 fromDate 併用：YYYY-MM-DD（含當日） */
  toDate?: string;
  /** 預設 true；可只跑單一來源以配合不同排程（例：Shopline 30 分、一頁 15 分） */
  superlanding?: boolean;
  shopline?: boolean;
  /** 未指定時沿用 days（僅一般「最近 N 天」模式有效） */
  superlandingDays?: number;
  shoplineDays?: number;
}): Promise<{ synced: number; errors: number }> {
  const backfill = options?.backfill === true;
  const defaultDays = backfill ? 365 : Math.min(365, Math.max(1, options?.days ?? 90));
  const slDays = Math.min(365, Math.max(1, options?.superlandingDays ?? defaultDays));
  const shDays = Math.min(365, Math.max(1, options?.shoplineDays ?? defaultDays));
  const includeSl = options?.superlanding !== false;
  const includeSh = options?.shopline !== false;

  let totalSynced = 0;
  let totalErrors = 0;

  const fromOpt = options?.fromDate?.trim();
  const toOpt = options?.toDate?.trim();

  /** 有值時一頁與 Shopline 共用同一視窗（日期區間或 backfill） */
  let sharedWindow: SyncWindow | null = null;

  if (fromOpt && toOpt) {
    if (!isYmd(fromOpt) || !isYmd(toOpt)) {
      throw new Error("fromDate / toDate 須為 YYYY-MM-DD");
    }
    if (fromOpt > toOpt) {
      throw new Error("from 不可晚於 to");
    }
    const beginDate = fromOpt;
    const endDate = toOpt;
    sharedWindow = {
      beginDate,
      endDate,
      startMs: new Date(`${beginDate}T00:00:00.000Z`).getTime(),
      endMs: new Date(`${endDate}T23:59:59.999Z`).getTime(),
    };
    console.log(
      `[sync-orders-normalized] mode=DATE_RANGE ${beginDate} ~ ${endDate} (backfill=${backfill}, maxPages=${backfill ? 200 : 100})`
    );
  } else if (fromOpt || toOpt) {
    throw new Error("請同時提供 fromDate 與 toDate（或皆不傳，改用 days）");
  } else if (backfill) {
    sharedWindow = windowFromDays(365);
    console.log(
      `[sync-orders-normalized] mode=HISTORICAL_BACKFILL_365D days=365 (maxPages=200)`
    );
  } else {
    console.log(
      `[sync-orders-normalized] mode=DEFAULT_RECENT superlandingDays=${slDays} shoplineDays=${shDays} (fallback days=${defaultDays})`
    );
  }

  const brands = storage.getBrands();
  const targetBrands =
    options?.brandId != null ? brands.filter((b) => b.id === options.brandId) : brands;

  if (targetBrands.length === 0) {
    console.log("無符合品牌（請傳正確 brand_id）");
    return { synced: 0, errors: 0 };
  }

  for (const brand of targetBrands) {
    const config = getSuperLandingConfig(brand.id);
    if (includeSl && config.merchantNo && config.accessKey) {
      const w = sharedWindow ?? windowFromDays(slDays);
      const slNote = w.endMs != null ? "（指定區間）" : `（最近 ${slDays} 天）`;
      console.log(`[Sync SL] Brand ${brand.id} (${brand.name}) ${w.beginDate} ~ ${w.endDate}${slNote}...`);
      let page = 1;
      const perPage = 200;
      const maxPages = backfill ? 200 : 100;
      let total = 0;
      try {
        while (true) {
          const orders = await fetchOrders(config, {
            begin_date: w.beginDate,
            end_date: w.endDate,
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
    if (includeSh && token) {
      const w = sharedWindow ?? windowFromDays(shDays);
      console.log(
        `[Sync Shopline] Brand ${brand.id} (${brand.name}) ${
          w.endMs != null ? `區間 ${w.beginDate} ~ ${w.endDate}` : `最近 ${shDays} 天`
        } ...`
      );
      try {
        const cfg = {
          storeDomain: (brand.shopline_store_domain || "").trim(),
          apiToken: token,
        };
        const { orders, pagesFetched } = await fetchShoplineOrdersListPaginated(cfg, {
          maxPages: backfill ? 200 : 100,
          perPage: 100,
        });
        let n = 0;
        for (const o of orders) {
          const t = new Date(o.created_at || o.order_created_at || 0).getTime();
          if (t < w.startMs) continue;
          if (w.endMs != null && t > w.endMs) continue;
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

function argvFlagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v == null || v.startsWith("-")) return undefined;
  return v;
}

if (isDirectCliRun()) {
  const argv = process.argv.slice(2);
  const backfill = argv.includes("--backfill") || argv.includes("--full");
  const fromArg = argvFlagValue(argv, "--from");
  const toArg = argvFlagValue(argv, "--to");

  if ((fromArg && !toArg) || (!fromArg && toArg)) {
    console.error("同步失敗: 請同時提供 --from YYYY-MM-DD 與 --to YYYY-MM-DD");
    process.exit(1);
  }

  const rest = argv.filter((a, i) => {
    if (a === "--backfill" || a === "--full") return false;
    if (a === "--from" || a === "--to") return false;
    if (i > 0 && (argv[i - 1] === "--from" || argv[i - 1] === "--to")) return false;
    return true;
  });
  const brandIdArgResolved = rest[0] && /^\d+$/.test(rest[0]) ? parseInt(rest[0], 10) : undefined;
  const daysFromArg = rest[1] && /^\d+$/.test(rest[1]) ? parseInt(rest[1], 10) : undefined;

  runOrderSync({
    brandId: brandIdArgResolved,
    days: daysFromArg,
    backfill,
    fromDate: fromArg,
    toDate: toArg,
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
