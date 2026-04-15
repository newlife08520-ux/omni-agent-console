---
產出時間: 2026-04-14（Asia/Taipei）
Phase 版本: Phase 106 交接包（含 106.1–106.17 與 debug endpoint）
檔案用途: 【檔案 6】訂單／一頁／閒置結案相關原始碼
---

## server/order-service.ts

```typescript
import type { OrderInfo } from "@shared/schema";
import type { SuperLandingConfig } from "./superlanding";
import type { ShoplineConfig } from "./shopline";
import { lookupOrderById, lookupOrdersByPageAndPhone, lookupOrdersByDateAndFilter, lookupOrdersByPhone, getStatusLabel } from "./superlanding";
import { lookupShoplineOrderById, lookupShoplineOrdersByPhone, lookupShoplineOrdersByEmail, lookupShoplineOrdersByName, getShoplineStatusLabel } from "./shopline";
import { storage } from "./storage";
import {
  getOrderByOrderId,
  getOrdersByPhoneMerged,
  getOrderLookupCache,
  setOrderLookupCache,
  normalizePhone,
  upsertOrderNormalized,
  cacheKeyOrderId,
  cacheKeyPhone,
  lookupOrdersByProductAliasAndPhoneLocal,
} from "./order-index";
import { filterOrdersByProductQuery } from "./order-product-filter";
import { derivePaymentStatus } from "./order-payment-utils";
import { resolveOrderSourceIntent } from "./order-lookup-policy";
import { classifyOrderStatus, shouldRefreshFromLive } from "./order-status";

/** Phase 106.3：手機查單預設僅保留近日訂單（關鍵字可關閉）；「其他訂單」不觸發關閉 */
export const PHONE_ORDER_LOOKUP_MAX_AGE_DAYS = 90;

export function shouldDisablePhoneOrderAgeFilter(userMessage: string, recentUserMessages: string[]): boolean {
  const tail = (recentUserMessages || []).slice(-5).join(" ");
  const combined = `${userMessage || ""} ${tail}`;
  return /(歷史|以前|去年|前年|完整歷史|舊單|全部)/.test(combined);
}

/** 依訂單建立時間過濾；無法解析時間者保守保留在 kept */
export function filterOrdersByMaxAge(
  orders: OrderInfo[],
  maxAgeDays: number,
  disableAgeFilter: boolean
): { kept: OrderInfo[]; filtered: OrderInfo[] } {
  if (disableAgeFilter || orders.length === 0) {
    return { kept: orders, filtered: [] };
  }
  const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const kept: OrderInfo[] = [];
  const filtered: OrderInfo[] = [];
  for (const o of orders) {
    const raw = String(o.order_created_at || o.created_at || "").trim();
    let ms: number | null = null;
    if (raw) {
      const t = Date.parse(raw);
      ms = Number.isNaN(t) ? null : t;
    }
    if (ms === null) {
      kept.push(o);
      continue;
    }
    if (ms >= cutoffMs) kept.push(o);
    else filtered.push(o);
  }
  return { kept, filtered };
}

function applyPhoneAgeFilterToUnifiedResult(
  input: UnifiedOrderResult,
  disableAgeFilter: boolean,
  phase: string
): UnifiedOrderResult {
  if (!input.found || input.orders.length === 0) return input;
  const before = input.orders.length;
  const { kept, filtered } = filterOrdersByMaxAge(input.orders, PHONE_ORDER_LOOKUP_MAX_AGE_DAYS, disableAgeFilter);
  const sampleIds = filtered
    .slice(0, 5)
    .map((o) => o.global_order_id || "")
    .filter(Boolean);
  console.log("[order-lookup] phone_age_filter_applied", {
    phase,
    beforeCount: before,
    afterCount: kept.length,
    filteredCount: filtered.length,
    filteredOrderIdsSample: sampleIds,
  });
  if (kept.length === 0 && filtered.length > 0) {
    console.log("[order-lookup] all_orders_filtered_by_age", { phase, filteredCount: filtered.length });
    return {
      ...input,
      orders: [],
      found: false,
      needs_live_confirm: false,
    };
  }
  if (kept.length === before) return input;
  return { ...input, orders: kept };
}

/** Phase 30／106.9：資料覆蓋來源；106.9 by_id 智能 live-fallback 增補 live_fresh 等 */
export type DataCoverage =
  | "local_only"
  | "api_only"
  | "merged_local_api"
  | "live_fresh"
  | "local_trusted"
  | "local_stale_fallback";

/** Phase 31：覆蓋信心 — local_only 單筆為 low，API 或合併為 high */
export type CoverageConfidence = "low" | "medium" | "high";

export interface UnifiedOrderResult {
  orders: OrderInfo[];
  source: "superlanding" | "shopline" | "unknown";
  found: boolean;
  crossBrand?: boolean;
  crossBrandName?: string;
  /** 若為 local_only，表示未打 API，資料可能不全，不應單筆直接定案 */
  data_coverage?: DataCoverage;
  /** Phase 31：覆蓋信心；local_only 單筆為 low */
  coverage_confidence?: CoverageConfidence;
  /** Phase 31：單筆且 local_only 時為 true，不可直接當最終真相 */
  needs_live_confirm?: boolean;
}

function getShoplineConfig(brandId?: number): ShoplineConfig | null {
  if (brandId) {
    const brand = storage.getBrand(brandId);
    if (brand?.shopline_api_token?.trim() && brand?.shopline_store_domain?.trim()) {
      return {
        storeDomain: brand.shopline_store_domain.trim(),
        apiToken: brand.shopline_api_token.trim(),
      };
    }
  }
  return null;
}

/** R1：是否可打 Shopline live API（token+domain 齊備）；未設定時須對客降級，不可假裝可查官網 */
export function isShoplineLookupConfiguredForBrand(brandId?: number): boolean {
  return getShoplineConfig(brandId) != null;
}

/** Phase 32/33：薄封裝；clear/unknown 皆不 prefer shopline */
export function shouldPreferShoplineLookup(userMessage: string, recentUserMessages?: string[]): boolean {
  return resolveOrderSourceIntent(userMessage, recentUserMessages ?? []) === "shopline";
}

/** 商品關鍵字 + 手機：本地 order_items_normalized／別名表（與 tool 共用索引邏輯） */
export function lookupOrdersByProductAndPhone(
  brandId: number,
  productNameKeyword: string,
  phone: string
): OrderInfo[] {
  return lookupOrdersByProductAliasAndPhoneLocal(brandId, phone, productNameKeyword);
}

export type OrderLookupPreferSource = "superlanding" | "shopline";

function dedupeOrdersBySourceId(orders: OrderInfo[]): OrderInfo[] {
  const m = new Map<string, OrderInfo>();
  for (const o of orders) {
    const src = (o.source || "superlanding") as string;
    const k = `${src}:${(o.global_order_id || "").toUpperCase()}`;
    if (!m.has(k)) m.set(k, o);
  }
  return [...m.values()].sort((a, b) =>
    String(b.created_at || b.order_created_at || "").localeCompare(String(a.created_at || a.order_created_at || ""))
  );
}

function cacheAndUpsertByIdResult(result: UnifiedOrderResult, idNorm: string, brandId: number): void {
  if (!result.found || result.orders.length === 0 || result.crossBrand) return;
  const o0 = result.orders[0];
  const src = (o0.source as "superlanding" | "shopline") || "superlanding";
  setOrderLookupCache(cacheKeyOrderId(brandId, idNorm, src), {
    orders: result.orders.length === 1 ? result.orders : [o0],
    source: src,
    found: true,
  });
  setOrderLookupCache(cacheKeyOrderId(brandId, idNorm, "any"), {
    orders: result.orders,
    source: result.source,
    found: true,
  });
  for (const o of result.orders) {
    if (o?.global_order_id && o.source) upsertOrderNormalized(brandId, o.source as "superlanding" | "shopline", o);
  }
}

/** 僅 live API（無 local 短路）；供 by_id 在需刷新時呼叫 */
async function runLiveUnifiedLookupById(
  slConfig: SuperLandingConfig,
  orderId: string,
  brandId?: number,
  preferSource?: OrderLookupPreferSource,
  allowCrossBrand = true
): Promise<UnifiedOrderResult> {
  const tryShoplineFirst = preferSource === "shopline";

  async function runShopline(): Promise<UnifiedOrderResult | null> {
    const shoplineConfig = getShoplineConfig(brandId);
    if (!shoplineConfig) return null;
    try {
      const order = await lookupShoplineOrderById(shoplineConfig, orderId);
      if (order) {
        order.source = "shopline";
        return { orders: [order], source: "shopline", found: true };
      }
    } catch (_e) {
      console.log("[UnifiedOrder] SHOPLINE 查詢失敗:", (_e as Error).message);
    }
    return null;
  }

  async function runSuperlanding(): Promise<UnifiedOrderResult | null> {
    if (!slConfig.merchantNo || !slConfig.accessKey) return null;
    try {
      const order = await lookupOrderById(slConfig, orderId);
      if (order) {
        order.source = "superlanding";
        return { orders: [order], source: "superlanding", found: true };
      }
    } catch (_e) {
      console.log("[UnifiedOrder] SuperLanding 查詢失敗:", (_e as Error).message);
    }
    if (!allowCrossBrand) return null;
    const allBrands = storage.getBrands();
    for (const brand of allBrands) {
      if (brand.id === brandId) continue;
      if (!brand.superlanding_merchant_no || !brand.superlanding_access_key) continue;
      try {
        const altOrder = await lookupOrderById(
          { merchantNo: brand.superlanding_merchant_no, accessKey: brand.superlanding_access_key },
          orderId
        );
        if (altOrder) {
          altOrder.source = "superlanding";
          return { orders: [altOrder], source: "superlanding", found: true, crossBrand: true, crossBrandName: brand.name };
        }
      } catch (_e) {}
    }
    return null;
  }

  let result: UnifiedOrderResult;
  if (preferSource === undefined && brandId) {
    const [sl, shop] = await Promise.all([runSuperlanding(), runShopline()]);
    if (sl?.found && shop?.found && sl.orders[0] && shop.orders[0]) {
      const merged = dedupeOrdersBySourceId([...sl.orders, ...shop.orders]);
      result = { orders: merged, source: merged.length > 1 ? "unknown" : merged[0].source || "unknown", found: true };
    } else if (sl?.found) result = sl;
    else if (shop?.found) result = shop;
    else result = { orders: [], source: "unknown", found: false };
  } else if (tryShoplineFirst) {
    const shop = await runShopline();
    if (shop?.found) result = shop;
    else {
      result = { orders: [], source: "shopline", found: false };
    }
  } else {
    const sl = await runSuperlanding();
    if (sl?.found) result = sl;
    else {
      const shop = await runShopline();
      result = shop ?? { orders: [], source: "unknown", found: false };
    }
  }
  return result;
}

export async function unifiedLookupById(
  slConfig: SuperLandingConfig,
  orderId: string,
  brandId?: number,
  preferSource?: OrderLookupPreferSource,
  /** Phase 1：前台查單時傳 false，不搜其他品牌 */
  allowCrossBrand = true
): Promise<UnifiedOrderResult> {
  const idNorm = (orderId || "").trim().toUpperCase();

  let localResult: UnifiedOrderResult | null = null;

  if (idNorm && brandId) {
    const scope = preferSource === "shopline" ? "shopline" : preferSource === "superlanding" ? "superlanding" : "any";
    if (scope !== "any") {
      const ck = cacheKeyOrderId(brandId, idNorm, scope);
      const cached = getOrderLookupCache(ck);
      if (cached?.found && cached.orders[0]?.source === scope) {
        localResult = cached as UnifiedOrderResult;
      } else {
        const loc = getOrderByOrderId(brandId, idNorm, scope);
        if (loc) {
          localResult = { orders: [loc], source: loc.source || scope, found: true };
          setOrderLookupCache(ck, localResult);
          setOrderLookupCache(cacheKeyOrderId(brandId, idNorm, "any"), localResult);
        }
      }
    } else {
      const ckAny = cacheKeyOrderId(brandId, idNorm, "any");
      const cachedAny = getOrderLookupCache(ckAny);
      if (cachedAny?.found) {
        localResult = cachedAny as UnifiedOrderResult;
      } else {
        const locSl = getOrderByOrderId(brandId, idNorm, "superlanding");
        const locSh = getOrderByOrderId(brandId, idNorm, "shopline");
        if (locSl) {
          localResult = { orders: [locSl], source: "superlanding", found: true };
          setOrderLookupCache(cacheKeyOrderId(brandId, idNorm, "superlanding"), localResult);
          setOrderLookupCache(ckAny, localResult);
        } else if (locSh) {
          localResult = { orders: [locSh], source: "shopline", found: true };
          setOrderLookupCache(cacheKeyOrderId(brandId, idNorm, "shopline"), localResult);
          setOrderLookupCache(ckAny, localResult);
        }
      }
    }
  }

  if (localResult?.found && localResult.orders.length > 0) {
    const localStatus = localResult.orders[0]?.status;
    const cls = classifyOrderStatus(localStatus);
    if (!shouldRefreshFromLive(localStatus)) {
      console.log("[reply-trace] lookup_id_local_trusted", {
        orderId: idNorm,
        brandId,
        status: localStatus,
        classification: cls,
      });
      return {
        ...localResult,
        data_coverage: "local_trusted",
        coverage_confidence: "high",
        needs_live_confirm: false,
      };
    }

    console.log("[reply-trace] lookup_id_check_live", {
      orderId: idNorm,
      brandId,
      localStatus,
      classification: cls,
    });

    const LIVE_TIMEOUT_MS = 3000;
    let liveResult: UnifiedOrderResult | null = null;
    try {
      liveResult = await Promise.race([
        runLiveUnifiedLookupById(slConfig, orderId, brandId, preferSource, allowCrossBrand),
        new Promise<UnifiedOrderResult | null>((resolve) => {
          setTimeout(() => {
            console.warn("[unifiedLookupById] live > 3s, fallback to local stale", { orderId: idNorm });
            resolve(null);
          }, LIVE_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      console.warn("[unifiedLookupById] live error, fallback to local", { orderId: idNorm, error: String(err) });
      liveResult = null;
    }

    if (liveResult?.found && liveResult.orders.length > 0) {
      if (idNorm && brandId && !liveResult.crossBrand) {
        cacheAndUpsertByIdResult(liveResult, idNorm, brandId);
      }
      console.log("[reply-trace] lookup_id_live_fresh", {
        orderId: idNorm,
        oldStatus: localStatus,
        newStatus: liveResult.orders[0]?.status,
      });
      return {
        ...liveResult,
        data_coverage: "live_fresh",
        coverage_confidence: "high",
        needs_live_confirm: false,
      };
    }

    return {
      ...localResult,
      data_coverage: "local_stale_fallback",
      coverage_confidence: "medium",
    };
  }

  const result = await runLiveUnifiedLookupById(slConfig, orderId, brandId, preferSource, allowCrossBrand);
  if (result.found && result.orders.length > 0 && idNorm && brandId && !result.crossBrand) {
    cacheAndUpsertByIdResult(result, idNorm, brandId);
  }
  if (result.found) {
    return {
      ...result,
      data_coverage: "live_fresh",
      coverage_confidence: "high",
    };
  }
  return result;
}

export async function unifiedLookupByProductAndPhone(
  slConfig: SuperLandingConfig,
  matchedPages: { pageId: string; productName: string }[],
  phone: string,
  brandId?: number,
  preferSource?: OrderLookupPreferSource,
  /** Phase 2.1：前台查單時傳 false，不搜其他品牌 */
  allowCrossBrand = true,
  /** 商品關鍵字：Shopline 手機查詢後必須過濾，不可整包回傳 */
  productQueryForShoplineFilter?: string
): Promise<UnifiedOrderResult> {
  const tryShoplineFirst = preferSource === "shopline";
  const shoplineProductQuery =
    (productQueryForShoplineFilter || "").trim() ||
    matchedPages.map((m) => m.productName).filter(Boolean).join(" ").trim();

  async function runShopline(): Promise<UnifiedOrderResult | null> {
    const shoplineConfig = getShoplineConfig(brandId);
    if (!shoplineConfig) return null;
    try {
      const result = await lookupShoplineOrdersByPhone(shoplineConfig, phone);
      if (result.orders.length > 0) {
        result.orders.forEach((o: OrderInfo) => {
          o.source = "shopline";
        });
        if (shoplineProductQuery.length >= 2) {
          const filtered = filterOrdersByProductQuery(result.orders, shoplineProductQuery, brandId);
          if (filtered.length === 0) {
            console.log(
              "[UnifiedOrder] SHOPLINE product filter: phone hit n=%s → 0 after product match query=%s",
              result.orders.length,
              shoplineProductQuery.slice(0, 40)
            );
            return { orders: [], source: "shopline", found: false };
          }
          return { orders: filtered, source: "shopline", found: true };
        }
        return { orders: result.orders, source: "shopline", found: true };
      }
    } catch (_e) {
      console.log("[UnifiedOrder] SHOPLINE 手機查詢失敗:", (_e as Error).message);
    }
    return null;
  }

  async function runSuperlanding(): Promise<UnifiedOrderResult | null> {
    if (!slConfig.merchantNo || !slConfig.accessKey || matchedPages.length === 0) return null;
    const batchSize = 3;
    let allResults: OrderInfo[] = [];
    for (let i = 0; i < matchedPages.length; i += batchSize) {
      const batch = matchedPages.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(mp => lookupOrdersByPageAndPhone(slConfig, mp.pageId, phone))
      );
      for (const br of batchResults) {
        allResults = allResults.concat(br.orders);
      }
      if (allResults.length > 0) break;
    }
    if (allResults.length > 0) {
      allResults.forEach(o => { o.source = "superlanding"; });
      return { orders: allResults, source: "superlanding", found: true };
    }
    if (!allowCrossBrand) return null;
    const allBrands = storage.getBrands();
    for (const brand of allBrands) {
      if (brand.id === brandId) continue;
      if (!brand.superlanding_merchant_no || !brand.superlanding_access_key) continue;
      const altConfig: SuperLandingConfig = {
        merchantNo: brand.superlanding_merchant_no,
        accessKey: brand.superlanding_access_key,
      };
      try {
        for (const mp of matchedPages) {
          const altResult = await lookupOrdersByPageAndPhone(altConfig, mp.pageId, phone);
          if (altResult.orders.length > 0) {
            altResult.orders.forEach(o => { o.source = "superlanding"; });
            return { orders: altResult.orders, source: "superlanding", found: true, crossBrand: true, crossBrandName: brand.name };
          }
        }
      } catch (_e) {}
    }
    return null;
  }

  if (tryShoplineFirst) {
    const shop = await runShopline();
    if (shop?.found) return shop;
    /** R1-1：官網（商品+手機）不回落一頁 */
    return { orders: [], source: "shopline", found: false };
  }
  const sl = await runSuperlanding();
  if (sl?.found) return sl;
  const shop = await runShopline();
  if (shop?.found) return shop;

  return { orders: [], source: "unknown", found: false };
}

/** Shopline／合併結果：僅保留訂單建立時間在 [beginDate, endDate] 內（含當日終） */
export function filterOrdersByDateRange(orders: OrderInfo[], beginDate: string, endDate: string): OrderInfo[] {
  const bNorm = beginDate.replace(/\//g, "-").trim();
  const eNorm = endDate.replace(/\//g, "-").trim();
  const b = new Date(bNorm + "T00:00:00").getTime();
  const e = new Date(eNorm + "T23:59:59.999").getTime();
  if (!Number.isFinite(b) || !Number.isFinite(e)) return orders;
  return orders.filter((o) => {
    const raw = (o.order_created_at || o.created_at || "").trim();
    if (!raw) return false;
    const t = new Date(raw).getTime();
    return Number.isFinite(t) && t >= b && t <= e;
  });
}

export async function unifiedLookupByDateAndContact(
  slConfig: SuperLandingConfig,
  contact: string,
  beginDate: string,
  endDate: string,
  pageId?: string,
  brandId?: number,
  preferSource?: OrderLookupPreferSource
): Promise<UnifiedOrderResult> {
  const tryShoplineFirst = preferSource === "shopline";

  async function runShopline(): Promise<UnifiedOrderResult | null> {
    const shoplineConfig = getShoplineConfig(brandId);
    if (!shoplineConfig) return null;
    try {
      const isEmail = contact.includes("@");
      const isPhone = /^[\d\-+\s()]+$/.test(contact) && contact.replace(/\D/g, "").length >= 8;
      let orders: OrderInfo[] = [];
      if (isEmail) {
        const r = await lookupShoplineOrdersByEmail(shoplineConfig, contact);
        orders = r.orders;
      } else if (isPhone) {
        const r = await lookupShoplineOrdersByPhone(shoplineConfig, contact);
        orders = r.orders;
      } else {
        const r = await lookupShoplineOrdersByName(shoplineConfig, contact);
        orders = r.orders;
      }
      if (orders.length > 0) {
        orders.forEach(o => { o.source = "shopline"; });
        const inRange = filterOrdersByDateRange(orders, beginDate, endDate);
        if (inRange.length === 0) {
          console.log("[UnifiedOrder] SHOPLINE 日期查詢：API 回傳筆數在區間外已濾除", orders.length);
          return null;
        }
        return { orders: inRange, source: "shopline", found: true };
      }
    } catch (_e) {
      console.log("[UnifiedOrder] SHOPLINE 日期查詢失敗:", (_e as Error).message);
    }
    return null;
  }

  async function runSuperlanding(): Promise<UnifiedOrderResult | null> {
    if (!slConfig.merchantNo || !slConfig.accessKey) return null;
    try {
      const result = await lookupOrdersByDateAndFilter(slConfig, contact, beginDate, endDate);
      if (result.orders.length > 0) {
        result.orders.forEach(o => { o.source = "superlanding"; });
        return { orders: result.orders, source: "superlanding", found: true };
      }
    } catch (_e) {
      console.log("[UnifiedOrder] SuperLanding 日期查詢失敗:", (_e as Error).message);
    }
    return null;
  }

  if (tryShoplineFirst) {
    const shop = await runShopline();
    if (shop?.found) return shop;
    /** R1-1：官網日期／聯絡查詢不回落一頁 */
    return { orders: [], source: "shopline", found: false };
  }
  const sl = await runSuperlanding();
  if (sl?.found) return sl;
  const shop = await runShopline();
  if (shop?.found) return shop;

  return { orders: [], source: "unknown", found: false };
}

/** Phase 106.1：本地合併命中後，依 preferSource 排序（同來源內維持新→舊） */
function sortLocalPhoneHitsByPreferredSource(
  orders: OrderInfo[],
  preferSource?: OrderLookupPreferSource
): OrderInfo[] {
  const t = (o: OrderInfo) => String(o.order_created_at || o.created_at || "").trim();
  if (preferSource === "shopline") {
    return [...orders].sort((a, b) => {
      const ra = (a.source || "") === "shopline" ? 0 : 1;
      const rb = (b.source || "") === "shopline" ? 0 : 1;
      if (ra !== rb) return ra - rb;
      return t(b).localeCompare(t(a));
    });
  }
  if (preferSource === "superlanding") {
    return [...orders].sort((a, b) => {
      const ra = (a.source || "") === "superlanding" ? 0 : 1;
      const rb = (b.source || "") === "superlanding" ? 0 : 1;
      if (ra !== rb) return ra - rb;
      return t(b).localeCompare(t(a));
    });
  }
  return orders;
}

/** 依手機號碼跨管道查單（一頁商店不限定 page，SHOPLINE 依 phone），合併回傳 */
export async function unifiedLookupByPhoneGlobal(
  slConfig: SuperLandingConfig,
  phone: string,
  brandId?: number,
  preferSource?: OrderLookupPreferSource,
  /** Phase 2.1：前台查單時傳 false，不搜其他品牌、不污染當前品牌 cache/index */
  allowCrossBrand = true,
  /** Phase 33：跳過本地索引與 cache 早退，強制 live API（「全部訂單」展開等） */
  bypassLocalIndex = false,
  /** Phase 106.3：為 true 時不套用 90 天過濾（客人明示要看歷史／舊單等） */
  disableAgeFilter = false
): Promise<UnifiedOrderResult> {
  const phoneNorm = normalizePhone(phone);
  if (phoneNorm && brandId && !bypassLocalIndex) {
    /** Phase 106.1：本地一律合併雙來源；preferSource 僅影響快取 key、排序與彙總 source，不縮窄查詢 */
    const localCacheKey =
      preferSource === "shopline"
        ? cacheKeyPhone(brandId, phoneNorm, "shopline")
        : preferSource === "superlanding"
          ? cacheKeyPhone(brandId, phoneNorm, "superlanding")
          : cacheKeyPhone(brandId, phoneNorm, "any");
    const cached = getOrderLookupCache(localCacheKey);
    if (cached?.found) {
      const afterCache = applyPhoneAgeFilterToUnifiedResult(cached as UnifiedOrderResult, disableAgeFilter, "cache_read");
      if (afterCache.found && afterCache.orders.length > 0) return afterCache;
    }

    const mergedLocal = getOrdersByPhoneMerged(brandId, phone);
    if (mergedLocal.length > 0) {
      const ordersSorted = sortLocalPhoneHitsByPreferredSource(mergedLocal, preferSource);
      const { kept, filtered } = filterOrdersByMaxAge(ordersSorted, PHONE_ORDER_LOOKUP_MAX_AGE_DAYS, disableAgeFilter);
      const sampleIds = filtered
        .slice(0, 5)
        .map((o) => o.global_order_id || "")
        .filter(Boolean);
      console.log("[order-lookup] phone_age_filter_applied", {
        phase: "local_merged",
        beforeCount: ordersSorted.length,
        afterCount: kept.length,
        filteredCount: filtered.length,
        filteredOrderIdsSample: sampleIds,
      });
      if (kept.length === 0 && filtered.length > 0) {
        console.log("[order-lookup] all_orders_filtered_by_age", {
          phase: "local_merged",
          filteredCount: filtered.length,
        });
      } else if (kept.length > 0) {
        const src = kept.every((o) => o.source === "shopline")
          ? "shopline"
          : kept.every((o) => o.source === "superlanding")
            ? "superlanding"
            : "unknown";
        const single = kept.length === 1;
        const result: UnifiedOrderResult = {
          orders: kept,
          source: src,
          found: true,
          data_coverage: "local_only",
          coverage_confidence: single ? "low" : "medium",
          needs_live_confirm: single,
        };
        setOrderLookupCache(localCacheKey, result);
        return result;
      }
    }
  }

  const tryShoplineFirst = preferSource === "shopline";
  const superlandingOnly = preferSource === "superlanding";
  const shoplineOnly = preferSource === "shopline";

  async function runShopline(): Promise<UnifiedOrderResult | null> {
    const shoplineConfig = getShoplineConfig(brandId);
    if (!shoplineConfig) return null;
    try {
      const result = await lookupShoplineOrdersByPhone(shoplineConfig, phone);
      if (result.orders.length > 0) {
        result.orders.forEach((o: OrderInfo) => { o.source = "shopline"; });
        return { orders: result.orders, source: "shopline", found: true, data_coverage: "api_only", coverage_confidence: "high", needs_live_confirm: false };
      }
    } catch (_e) {
      console.log("[UnifiedOrder] SHOPLINE 手機全域查詢失敗:", (_e as Error).message);
    }
    return null;
  }

  async function runSuperlanding(): Promise<UnifiedOrderResult | null> {
    if (!slConfig.merchantNo || !slConfig.accessKey) return null;
    try {
      const result = await lookupOrdersByPhone(slConfig, phone);
      if (result.orders.length > 0) {
        result.orders.forEach((o: OrderInfo) => { o.source = "superlanding"; });
        return { orders: result.orders, source: "superlanding", found: true, data_coverage: "api_only", coverage_confidence: "high", needs_live_confirm: false };
      }
    } catch (_e) {
      console.log("[UnifiedOrder] SuperLanding 手機全域查詢失敗:", (_e as Error).message);
    }
    if (!allowCrossBrand) return null;
    const allBrands = storage.getBrands();
    for (const brand of allBrands) {
      if (brand.id === brandId) continue;
      if (!brand.superlanding_merchant_no || !brand.superlanding_access_key) continue;
      try {
        const result = await lookupOrdersByPhone(
          { merchantNo: brand.superlanding_merchant_no, accessKey: brand.superlanding_access_key },
          phone
        );
        if (result.orders.length > 0) {
          result.orders.forEach((o: OrderInfo) => { o.source = "superlanding"; });
          return { orders: result.orders, source: "superlanding", found: true, crossBrand: true, crossBrandName: brand.name };
        }
      } catch (_e) {}
    }
    return null;
  }

  let result: UnifiedOrderResult;
  if (shoplineOnly) {
    const shop = await runShopline();
    result = shop ?? { orders: [], source: "shopline", found: false };
  } else if (superlandingOnly) {
    const sl = await runSuperlanding();
    result = sl ?? { orders: [], source: "unknown", found: false };
  } else {
    /** Phase 106：SL 全域掃描可能遠慢於 Shopline，8 秒後放棄 SL 以免雙邊一起卡死 */
    const slPromise = Promise.race([
      (async (): Promise<UnifiedOrderResult | null> => {
        try {
          return await runSuperlanding();
        } catch (e) {
          console.warn("[UnifiedOrder] SuperLanding 查詢失敗:", (e as Error)?.message || e);
          return null;
        }
      })(),
      new Promise<UnifiedOrderResult | null>((resolve) => {
        setTimeout(() => {
          console.warn("[UnifiedOrder] SuperLanding 查詢超過 8 秒,強制切斷以保護 Shopline 回應");
          resolve(null);
        }, 8000);
      }),
    ]);
    const [sl, shop] = await Promise.all([slPromise, runShopline()]);
    const parts: OrderInfo[] = [];
    if (sl?.found) parts.push(...sl.orders);
    if (shop?.found) parts.push(...shop.orders);
    const merged = dedupeOrdersBySourceId(parts);
    if (merged.length > 0) {
      const src = merged.every((o) => o.source === "shopline")
        ? "shopline"
        : merged.every((o) => o.source === "superlanding")
          ? "superlanding"
          : "unknown";
      result = { orders: merged, source: src, found: true, data_coverage: "merged_local_api", coverage_confidence: "high", needs_live_confirm: false };
    } else if (tryShoplineFirst) {
      result = { orders: [], source: "unknown", found: false };
    } else {
      result = { orders: [], source: "unknown", found: false };
    }
  }
  result = applyPhoneAgeFilterToUnifiedResult(result, disableAgeFilter, "live_pipeline_final");
  if (result.found && result.orders.length > 0 && phoneNorm && brandId && !result.crossBrand) {
    const cachePayload = {
      orders: result.orders,
      source: result.source,
      found: true as const,
      data_coverage: result.data_coverage,
    };
    if (preferSource === "shopline") {
      setOrderLookupCache(cacheKeyPhone(brandId, phoneNorm, "shopline"), { ...cachePayload, source: "shopline" });
    } else if (preferSource === "superlanding") {
      setOrderLookupCache(cacheKeyPhone(brandId, phoneNorm, "superlanding"), { ...cachePayload, source: "superlanding" });
    } else {
      setOrderLookupCache(cacheKeyPhone(brandId, phoneNorm, "any"), cachePayload);
    }
    for (const o of result.orders) {
      if (o?.global_order_id && o.source)
        upsertOrderNormalized(brandId, o.source as "superlanding" | "shopline", o);
    }
  }
  return result;
}

export function getUnifiedStatusLabel(status: string, source?: string): string {
  if (source === "shopline") {
    return getShoplineStatusLabel(status);
  }
  return getStatusLabel(status);
}

/**
 * 給第一輪 LLM 的付款解讀：單一真相，與 derivePaymentStatus 一致（含 COD 一頁 pending 特例）。
 */
export function getPaymentInterpretationForAI(order: OrderInfo, orderStatusLabel: string, source: string): string {
  const { kind } = derivePaymentStatus(order, orderStatusLabel, source);
  const pm = (order.payment_method || "").trim().toLowerCase();
  if (kind === "cod") {
    return "此筆為貨到付款（到收／取件時付款）。請告知客戶不是線上付款失敗；直接說明訂單狀態與出貨／取貨門市，勿說需先線上付清。";
  }
  if (kind === "failed") {
    return "此筆線上付款未完成或失敗。請明確告知需重新下單或洽客服；勿誤導已可出貨。";
  }
  if (kind === "success") {
    return "此筆已付款或已進入可出貨流程。直接說明訂單狀態與物流即可。";
  }
  if (kind === "pending") {
    return "此筆可能待付款或確認中。說明目前狀態即可；勿一口咬定失敗。";
  }
  if (pm === "virtual_account" || pm === "ibon" || pm === "atm" || pm === "轉帳" || /超商繳費|atm/i.test(pm)) {
    return "此筆為轉帳或超商繳費。入帳後才會安排出貨；可請客人確認是否已繳費。";
  }
  if (!pm) {
    return "付款方式未明。以訂單狀態為主回覆；勿單方面推測需先付款才能出貨。";
  }
  return "以訂單狀態與物流為主回覆；若客人說明付款方式請依其說法調整。";
}

```
## server/order-status.ts

```typescript
// Phase 106.9：訂單狀態三層分類（lookup_order_by_id 是否打 live）
// 老闆確認：英式 cancelled 屬「未知」→ 須打 live；美式 canceled 為終態

/** 🟢 終態：信任 local index，不打 live */
export const TERMINAL_ORDER_STATUSES = new Set([
  "shipped",
  "shipping",
  "canceled",
  "returned",
  "refunded",
]);

/** 🟡 準終態：信任 local index */
export const PRE_TERMINAL_ORDER_STATUSES = new Set([
  "awaiting_for_shipment",
  "confirmed",
  "replacement",
  "delay_handling",
]);

/** 🔴 早期態：必須打 live 確認最新 */
export const EARLY_ORDER_STATUSES = new Set([
  "new_order",
  "pending",
  "confirming",
  "refunding",
]);

export type OrderStatusClass = "terminal" | "pre_terminal" | "early" | "unknown";

export function classifyOrderStatus(status: string | null | undefined): OrderStatusClass {
  if (!status) return "unknown";
  const normalized = status.toLowerCase().trim();
  if (TERMINAL_ORDER_STATUSES.has(normalized)) return "terminal";
  if (PRE_TERMINAL_ORDER_STATUSES.has(normalized)) return "pre_terminal";
  if (EARLY_ORDER_STATUSES.has(normalized)) return "early";
  return "unknown";
}

/** unknown／早期態 → 打 live */
export function shouldRefreshFromLive(status: string | null | undefined): boolean {
  const cls = classifyOrderStatus(status);
  return cls === "early" || cls === "unknown";
}

```
## server/order-reply-utils.ts

```typescript
/**
 * 訂單回覆格式與付款狀態（供 fast path / tool 共用）
 * 付款狀態一律走 derivePaymentStatus；對客卡片見 formatOrderOnePage。
 */
import type { OrderInfo, ActiveOrderContext } from "@shared/schema";
import { derivePaymentStatus, isCodPaymentMethod, type PaymentKind } from "./order-payment-utils";
import { maskName, maskPhone } from "./tool-llm-sanitize";
import { getUnifiedStatusLabel } from "./order-service";

/** 訂單狀態轉成客人聽得懂的極簡業務語言（Phase 106.10） */
export function customerFacingStatusLabel(rawStatus: string | null | undefined): string {
  if (!rawStatus) return "處理中";

  const s = rawStatus.toLowerCase().trim();

  if (s === "shipped" || s === "shipping" || /已出貨|出貨中/.test(rawStatus)) {
    return "已出貨";
  }
  if (s === "canceled" || s === "cancelled" || /已取消|取消/.test(rawStatus)) {
    return "已取消";
  }
  if (s === "returned" || /已退貨|退貨/.test(rawStatus)) {
    return "已退貨";
  }
  if (s === "refunded" || /已退款|退款完成/.test(rawStatus)) {
    return "已退款";
  }
  if (s === "awaiting_for_shipment" || /待出貨/.test(rawStatus)) {
    return "待出貨";
  }
  if (s === "confirmed" || /已確認/.test(rawStatus)) {
    return "已確認";
  }
  if (s === "replacement" || /換貨/.test(rawStatus)) {
    return "換貨處理中";
  }
  if (s === "delay_handling" || /延遲/.test(rawStatus)) {
    return "出貨稍有延遲";
  }
  if (s === "new_order" || /新訂單/.test(rawStatus)) {
    return "訂單已收到";
  }
  if (s === "pending" || /待處理/.test(rawStatus)) {
    return "處理中";
  }
  if (s === "confirming" || /確認中/.test(rawStatus)) {
    return "訂單確認中";
  }
  if (s === "refunding" || /退款中/.test(rawStatus)) {
    return "退款處理中";
  }
  if (/\[本地快取/i.test(rawStatus)) {
    return "確認中";
  }
  return rawStatus;
}

/**
 * 依訂單狀態 + 配送方式組配套提醒（僅單筆完整卡片使用，Phase 106.10）
 */
export function buildOrderStatusFollowupHint(
  rawStatus: string | null | undefined,
  shippingMethod: string | null | undefined
): string {
  if (!rawStatus) return "";

  const s = rawStatus.toLowerCase().trim();
  const ship = shippingMethod ?? "";

  const isHomeDelivery = /(宅配|宅急便|home|tcat|takkyu|hct|新竹|黑貓)/i.test(ship);
  const isStorePickup = /(7-?11|seven|family|全家|店配|超商|cvs|store|萊爾富|hi[- ]?life|ok mart)/i.test(ship);

  if (s === "shipped" || s === "shipping" || /已出貨|出貨中/.test(rawStatus)) {
    if (isHomeDelivery) {
      return "\n\n📦 已出貨囉～請留意司機電話通知，通常 1-2 天會送達唷！";
    }
    if (isStorePickup) {
      return "\n\n📦 已出貨囉～商品到店後會收到取貨簡訊，記得 7 天內取貨唷！";
    }
    return "\n\n📦 已出貨囉～請留意後續通知唷！";
  }

  if (s === "awaiting_for_shipment" || s === "confirmed" || /待出貨|已確認/.test(rawStatus)) {
    return "\n\n⏰ 已安排出貨中，預計 2-3 天內出貨唷～";
  }

  if (s === "replacement" || /換貨/.test(rawStatus)) {
    return "\n\n🔄 換貨處理中，專員會盡快處理唷～";
  }

  if (s === "delay_handling" || /延遲/.test(rawStatus)) {
    return "\n\n⚠️ 出貨稍有延遲，專員處理中，造成不便請多包涵～";
  }

  if (
    s === "canceled" ||
    s === "cancelled" ||
    s === "returned" ||
    s === "refunded" ||
    /已取消|已退貨|已退款/.test(rawStatus)
  ) {
    return "";
  }

  if (s === "new_order" || s === "pending" || s === "confirming" || /新訂單|待處理|確認中/.test(rawStatus)) {
    return "\n\n📝 訂單已收到，正在為您安排，請稍候唷～";
  }

  if (s === "refunding" || /退款中/.test(rawStatus)) {
    return "\n\n💰 退款處理中，請耐心等候唷～";
  }

  return "";
}

/** 付款標籤對客清洗——去掉工程感文字 */
export function customerFacingPaymentLabel(raw: string): string {
  const s = (raw || "").trim();
  if (!s) return "";
  if (/^(success|paid)$/i.test(s)) return "已付款";
  if (/^failed$/i.test(s)) return "付款失敗";
  if (/^pending$/i.test(s)) return "未付款";
  if (/^cod$/i.test(s)) return "貨到付款";
  if (/^unknown$/i.test(s)) return "未付款";
  if (/貨到付款/i.test(s)) return "貨到付款";
  if (/已付款|付款成功|已收款|已收/i.test(s)) return "已付款";
  if (/失敗|取消|未成立|授權失敗|刷卡不成功/i.test(s)) return "付款失敗";
  if (/未付款|待付款/i.test(s)) return "未付款";
  if (/同步中|確認中|processing|syncing|pending/i.test(s)) return "未付款";
  return s;
}

/** 宅配地址隱碼：只顯示縣市區 + *** */
export function maskAddress(addr: string): string {
  const s = (addr || "").trim();
  if (!s) return "";
  const match = s.match(/^(.{2,8}(?:市|區|鎮|鄉|里|村))/);
  if (match) return match[1] + "***";
  return s.length > 6 ? s.slice(0, 6) + "***" : s;
}

const CVS_SHIPPING_KEYWORDS = ["超商", "門市", "7-11", "7-ELEVEN", "全家", "OK", "萊爾富"];

/** 對客顯示用：辨識常見付款方式；無法辨識則回空字串（由付款狀態列處理）。 */
export function displayPaymentMethod(raw: string | null | undefined): string {
  const t = (raw || "").trim();
  if (!t) return "";

  if (
    /貨到付款|到收|取件時付款|cod|cash_on_delivery|tw_711_b2c_pay|tw_fami_b2c_pay|tw_hilife_b2c_pay|tw_ok_b2c_pay|b2c_pay|home_delivery_cod/i.test(
      t
    )
  )
    return "貨到付款";
  if (/黑貓|宅急便|t_cat/i.test(t) && /代收|貨到/.test(t)) return "貨到付款";

  const lower = t.toLowerCase().replace(/\s+/g, "_");
  if (lower === "credit_card" || lower === "creditcard" || /信用卡|刷卡/.test(t)) return "信用卡";
  if (/line[_\s-]?pay/i.test(t)) return "LINE Pay";
  if (/jkopay|街口/i.test(t)) return "街口支付";
  if (/apple[_\s-]?pay/i.test(t)) return "Apple Pay";
  if (/google[_\s-]?pay/i.test(t)) return "Google Pay";
  if (/atm|虛擬帳|轉帳|匯款/i.test(t)) return "ATM 轉帳";
  if (/ibon|超商代碼|繳費/i.test(t)) return "超商代碼繳費";

  if (lower === "pending") return "";

  if (/[\u4e00-\u9fff]/.test(t)) return t;

  return "";
}

/**
 * SuperLanding／Shopline 物流代碼轉對客文案；isCod 時加「（貨到付款）」以利宅配到付與超商取貨付款區分。
 */
export function displayShippingMethod(raw: string | null | undefined, isCod?: boolean): string {
  const original = String(raw ?? "").trim();
  const lower = original.toLowerCase();
  if (!original) return "";

  const c = !!isCod;

  // === Shopline 平台代碼（含 delivery_type / platform 片段）===
  if (/tw_711|seven|7-?11/.test(lower)) {
    return c ? "7-11 取貨付款" : "7-11 取貨";
  }
  if (/tw_family|^family$|fmt|fami|全家/.test(lower)) {
    return c ? "全家取貨付款" : "全家取貨";
  }
  if (/tw_hilife|hilife|萊爾富/.test(lower)) {
    return c ? "萊爾富取貨付款" : "萊爾富取貨";
  }
  if (/tw_okmart|okm|^ok_|ok\.?mart/.test(lower)) {
    return c ? "OK 超商取貨付款" : "OK 超商取貨";
  }
  if (/^pickup$/i.test(lower)) {
    return c ? "超商取貨付款" : "超商取貨";
  }
  if (/^home_delivery$/i.test(lower)) {
    return c ? "宅配到府（貨到付款）" : "宅配到府";
  }

  if (/to_home|home_delivery/i.test(lower) || /宅配|到府|郵寄|寄送/i.test(original)) {
    return c ? "宅配到府（貨到付款）" : "宅配到府";
  }
  if (
    lower.includes("home") &&
    !/store|cvs|711|fami|hilife|okm|seven|fmt|to_store|pickup|eleven|超商|門市|全家|萊爾富/i.test(lower)
  ) {
    return c ? "宅配到府（貨到付款）" : "宅配到府";
  }

  if (/黑貓|宅急便|t[_\s]?cat/i.test(lower)) {
    return c ? "黑貓宅配（貨到付款）" : "黑貓宅配";
  }

  if (/cvs|超商|門市|取貨|711|pickup|to_store|便利|商店/i.test(lower)) {
    return c ? "超商取貨付款" : "超商取貨";
  }

  if (/[\u4e00-\u9fff]/.test(original)) return original;

  return "";
}

export type PayKind = PaymentKind;

export function payKindForOrder(order: OrderInfo, statusLabel: string, source: string): { kind: PayKind; label: string } {
  const p = derivePaymentStatus(order, statusLabel, source);
  return { kind: p.kind, label: p.label };
}

/**
 * Phase 2.9：對客商品明細人類可讀，禁止 raw JSON。
 * 優先 items_structured，再解析 product_list JSON，最後純字串。
 */
function productLineNameFromRow(row: Record<string, unknown>): string {
  const zhTitle =
    row.title_translations != null && typeof row.title_translations === "object"
      ? String((row.title_translations as Record<string, string>)["zh-hant"] ?? "").trim()
      : "";
  const name = String(
    row.product_name ??
      row.name ??
      row.item_name ??
      row.title ??
      row.product_title ??
      row.variant_title ??
      row.variant_name ??
      row.line_item_title ??
      row.display_name ??
      zhTitle ??
      ""
  ).trim();
  const code = String(row.code ?? row.sku ?? row.variant_id ?? row.product_id ?? "").trim();
  if (name) return name;
  if (code) return `品項（${code}）`;
  return "";
}

export function formatProductLinesForCustomer(o: {
  product_list?: string;
  items_structured?: unknown;
}): string {
  let raw: unknown = o.items_structured;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (t.startsWith("[") || t.startsWith("{")) {
      try {
        raw = JSON.parse(t) as unknown;
      } catch {
        raw = null;
      }
    }
  }
  if (Array.isArray(raw) && raw.length > 0) {
    const lines = raw.map((item: unknown) => {
      if (item != null && typeof item === "object") {
        const x = item as Record<string, unknown>;
        const label = productLineNameFromRow(x);
        const qty = x.quantity ?? x.qty ?? 1;
        if (!label) return "";
        return `${label} × ${qty}`;
      }
      return String(item ?? "").trim();
    });
    const s = lines.filter(Boolean).join("；");
    if (s) return s;
  }
  const pl = o.product_list;
  if (pl == null || !String(pl).trim()) return "";
  const s = String(pl).trim();
  if (s.startsWith("[") && s.includes("{")) {
    try {
      const arr = JSON.parse(s) as unknown;
      if (Array.isArray(arr)) {
        const lines = arr.map((x: unknown) => {
          if (x != null && typeof x === "object") {
            const r = x as Record<string, unknown>;
            const label = productLineNameFromRow(r);
            const qty = r.quantity ?? r.qty ?? 1;
            return label ? `${label} × ${qty}` : "";
          }
          return String(x ?? "").trim();
        });
        const out = lines.filter(Boolean).join("；");
        if (out) return out;
      }
    } catch {
      /* fall through */
    }
  }
  return s.replace(/\s*\n\s*/g, "；");
}

export function formatOrderOnePage(o: {
  order_id?: string;
  buyer_name?: string;
  buyer_phone?: string;
  /** 手機查單時 API／快取若未帶收件電話，用客人提供的號碼做隱碼顯示 */
  display_phone_if_missing?: string;
  created_at?: string;
  payment_method?: string;
  payment_status_label?: string;
  payment_status?: string;
  payment_warning?: string;
  amount?: number;
  shipping_method?: string;
  shipping_display?: string;
  tracking_number?: string;
  address?: string;
  product_list?: string;
  items_structured?: unknown;
  status?: string;
  shipped_at?: string;
  delivery_target_type?: string;
  cvs_brand?: string;
  cvs_store_name?: string;
  store_location?: string;
  full_address?: string;
  source_channel?: string;
  /** 與 OrderInfo.source 一致時可正確套用 SuperLanding pending+to_home 等 COD 規則 */
  source?: string;
  prepaid?: boolean;
  paid_at?: string | null;
  /** API 原始 fulfillment status，供配套提醒（與對客 status 文案分離） */
  fulfillment_status_raw?: string | null;
}): string {
  const lines: string[] = [];

  if (o.order_id) lines.push(`訂單編號：${o.order_id}`);

  if (o.buyer_name) lines.push(`收件人：${maskName(o.buyer_name)}`);

  const phoneLine = String(o.buyer_phone || "").trim() || String(o.display_phone_if_missing || "").trim();
  if (phoneLine) lines.push(`電話：${maskPhone(phoneLine)}`);

  if (o.created_at) lines.push(`下單時間：${o.created_at}`);

  const prodLine = formatProductLinesForCustomer({
    product_list: o.product_list,
    items_structured: o.items_structured,
  }).trim();
  // 固定格式：一定有一行「商品」，避免 LLM／空明細時整段消失
  lines.push(`商品：${prodLine || "暫無明細"}`);

  if (o.amount != null) lines.push(`金額：NT$ ${Number(o.amount).toLocaleString()}`);

  const codProbe = {
    source: o.source,
    payment_method: o.payment_method,
    shipping_method: o.shipping_method,
    delivery_target_type: o.delivery_target_type,
    prepaid: o.prepaid,
    paid_at: o.paid_at ?? null,
  } as OrderInfo;
  const isCod =
    isCodPaymentMethod(codProbe) ||
    o.payment_status === "cod" ||
    /^cod$/i.test(String(o.payment_status || "").trim()) ||
    /貨到付款|到收/i.test(String(o.payment_status_label || ""));

  const pmLower = String(o.payment_method || "").trim().toLowerCase();
  const payMethod =
    isCod && pmLower === "pending" ? "貨到付款" : displayPaymentMethod(o.payment_method);

  let payLabel = customerFacingPaymentLabel(
    String(o.payment_status_label || "").trim() || String(o.payment_status || "").trim()
  );
  if (isCod && (!payLabel || payLabel === "未付款")) {
    payLabel = "貨到付款";
  }

  const isCvs =
    o.delivery_target_type === "cvs" ||
    o.delivery_target_type === "超商" ||
    (o.delivery_target_type !== "home" &&
      o.delivery_target_type !== "宅配" &&
      CVS_SHIPPING_KEYWORDS.some((k) => (o.shipping_method || "").toLowerCase().includes(k.toLowerCase())));

  if (payMethod === "貨到付款" && isCvs) {
    lines.push("付款：貨到付款（取貨時付款）");
  } else if (payMethod === "貨到付款") {
    lines.push("付款：貨到付款");
  } else if (payLabel && payMethod) {
    lines.push(`付款：${payLabel}（${payMethod}）`);
  } else if (payLabel) {
    lines.push(`付款：${payLabel}`);
  }

  const shipping = o.shipping_display || displayShippingMethod(o.shipping_method, isCod);

  // 1. 超商取貨 → 門市名；2. 黑貓／一般宅配 → 配送標籤 + 地址隱碼（略過「台灣」占位）
  if (isCvs) {
    if (shipping) lines.push(`配送：${shipping}`);
    const storeDisplay =
      String(o.store_location || "").trim() ||
      [o.cvs_brand, o.cvs_store_name].filter(Boolean).join(" ");
    if (storeDisplay) lines.push(`取貨門市：${storeDisplay}`);
  } else {
    if (shipping) lines.push(`配送：${shipping}`);
    const addr = o.full_address || o.address || "";
    if (addr && addr !== "台灣") {
      lines.push(`寄送地址：${maskAddress(addr)}`);
    }
  }

  if (o.tracking_number) lines.push(`物流單號：${o.tracking_number}`);

  if (o.status) lines.push(`狀態：${customerFacingStatusLabel(o.status)}`);

  if (o.shipped_at) lines.push(`出貨時間：${o.shipped_at}`);

  const card = lines.join("\n");
  const hint = buildOrderStatusFollowupHint(o.fulfillment_status_raw ?? undefined, o.shipping_method);
  return card + hint;
}

/** 台北時區日期字串（對客用，禁止輸出 ISO raw） */
export function formatDateTaipei(isoOrRaw: string | null | undefined, pattern: "YYYY-MM-DD"): string {
  if (pattern !== "YYYY-MM-DD") return "";
  const raw = String(isoOrRaw ?? "").trim();
  if (!raw) return "";
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(t));
}

const EXT_LIST_NAME_MAX = 20;
const EXT_LIST_ITEMS_MAX = 2;

function truncateProductNameForList(name: string): string {
  const t = name.trim();
  if (t.length <= EXT_LIST_NAME_MAX) return t;
  return t.slice(0, EXT_LIST_NAME_MAX) + "…";
}

/** 擴充清單：拆出品項（名稱 + 數量） */
function parseOrderLineItemsForExtendedList(o: {
  product_list?: string;
  items_structured?: unknown;
}): { name: string; qty: number }[] {
  let raw: unknown = o.items_structured;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (t.startsWith("[") || t.startsWith("{")) {
      try {
        raw = JSON.parse(t) as unknown;
      } catch {
        raw = null;
      }
    }
  }
  const out: { name: string; qty: number }[] = [];
  if (Array.isArray(raw) && raw.length > 0) {
    for (const item of raw) {
      if (item != null && typeof item === "object") {
        const x = item as Record<string, unknown>;
        const label = productLineNameFromRow(x);
        const qty = Number(x.quantity ?? x.qty ?? 1) || 1;
        if (label) out.push({ name: label, qty });
      }
    }
    if (out.length) return out;
  }
  const pl = o.product_list;
  if (pl == null || !String(pl).trim()) return [];
  const s = String(pl).trim();
  if (s.startsWith("[") && s.includes("{")) {
    try {
      const arr = JSON.parse(s) as unknown;
      if (Array.isArray(arr)) {
        for (const x of arr) {
          if (x != null && typeof x === "object") {
            const r = x as Record<string, unknown>;
            const label = productLineNameFromRow(r);
            const qty = Number(r.quantity ?? r.qty ?? 1) || 1;
            if (label) out.push({ name: label, qty });
          }
        }
      }
    } catch {
      return [];
    }
    return out;
  }
  return [];
}

function formatExtendedProductSummary(o: {
  product_list?: string;
  items_structured?: unknown;
}): string {
  const rows = parseOrderLineItemsForExtendedList(o);
  if (rows.length === 0) return "暫無明細";
  const head = rows.slice(0, EXT_LIST_ITEMS_MAX).map((r) => `${truncateProductNameForList(r.name)} ×${r.qty}`);
  const joined = head.join(", ");
  if (rows.length <= EXT_LIST_ITEMS_MAX) return joined;
  return `${joined}，等 ${rows.length} 項`;
}

function formatExtendedAmountPaymentLine(o: OrderInfo, statusLabel: string, source: string): string {
  const amt = o.final_total_order_amount;
  const amtStr = amt != null && !Number.isNaN(Number(amt)) ? `NT$${Number(amt).toLocaleString()}` : "金額未明";
  const pk = payKindForOrder(o, statusLabel, source);
  const pm = displayPaymentMethod(o.payment_method);
  const isCod =
    isCodPaymentMethod(o) ||
    pk.kind === "cod" ||
    /^cod$/i.test(String(pk.kind || "").trim()) ||
    /貨到付款|到收/i.test(String(pk.label || ""));
  let payPart = pm || customerFacingPaymentLabel(pk.label) || customerFacingPaymentLabel(String(pk.kind || ""));
  if (isCod && (!payPart || payPart === "未付款")) payPart = "貨到付款";
  if (!payPart) payPart = "未註明";
  return `金額：${amtStr}｜${payPart}`;
}

/**
 * Phase 106.3：手機多筆（4+）擴充清單；每筆 5 行，筆間空一行。
 * brandContext 保留供日後品牌語氣／幣別擴充。
 */
export function formatExtendedOrderList(orders: OrderInfo[], _brandContext?: unknown): string {
  const blocks: string[] = [];
  for (const o of orders) {
    const src = (o.source || "superlanding") as string;
    const st = getUnifiedStatusLabel(o.status, src);
    const id = String(o.global_order_id || "").trim() || "—";
    const dateStr = formatDateTaipei(o.order_created_at || o.created_at, "YYYY-MM-DD") || "—";
    const recv = String(o.buyer_name || "").trim();
    const recvLine = recv ? maskName(recv) : "—";
    const lines = [
      `${id}｜${dateStr}`,
      `收件人：${recvLine}`,
      `商品：${formatExtendedProductSummary(o)}`,
      formatExtendedAmountPaymentLine(o, st, src),
      `狀態：${customerFacingStatusLabel(st)}`,
    ];
    blocks.push(lines.join("\n"));
  }
  return (
    blocks.join("\n\n") +
    "\n\n要看哪一筆完整資訊請回覆訂單編號或「第 N 筆」。"
  );
}

export function sourceChannelLabel(src: string | undefined): string {
  if (src === "shopline") return "官網（SHOPLINE）";
  if (src === "superlanding") return "一頁商店";
  return "訂單";
}

/** 對客回覆禁止出現的 API raw token（verify 與手動檢查共用） */
export const CUSTOMER_FACING_RAW_DENYLIST = ["pending", "to_store", "credit_card"] as const;

/** 若回覆含 denylist token（獨立詞／底線形式）回傳命中項，否則 null */
export function findCustomerFacingRawLeak(text: string): string | null {
  const s = text || "";
  for (const t of CUSTOMER_FACING_RAW_DENYLIST) {
    const esc = t.replace(/_/g, "[_\\s]");
    if (new RegExp(`(?:^|[^a-z0-9])${esc}(?:$|[^a-z0-9])`, "i").test(s)) return t;
  }
  return null;
}

/**
 * Phase34B：local_only 單筆僅給「候選摘要」，非 final order card。
 * 僅含：編號、時間、商品摘要、狀態一句、下一步引導（不含電話／地址／金額／付款方式列）。
 */
export function formatLocalOnlyCandidateSummary(o: {
  order_id: string;
  created_at?: string;
  product_list?: string;
  items_structured?: unknown;
  source_channel?: string;
  status_short?: string;
}): string {
  const prod = formatProductLinesForCustomer({
    product_list: o.product_list,
    items_structured: o.items_structured,
  });
  const lines: string[] = [
    "以下是目前查到的訂單資訊：",
    `訂單編號：${o.order_id}`,
  ];
  if (o.created_at) lines.push(`下單／建立時間：${o.created_at}`);
  if (prod) lines.push(`商品摘要：${prod}`);
  if (o.status_short) lines.push(`狀態：${customerFacingStatusLabel(o.status_short)}`);
  lines.push(
    "",
    "若要看其他訂單或確認更多細節，隨時跟我說。"
  );
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Phase 2.4：deterministic 模板禁用句型（verify 掃描） */
export const PHASE24_BANNED_DETERMINISTIC_PHRASES = [
  "我會隨時在這裡幫您",
  "感謝您的耐心等候",
  "感謝您的耐心",
  "非常抱歉造成您的困擾",
];

export function deterministicReplyHasBannedPhrase(text: string): string | null {
  const t = text || "";
  for (const p of PHASE24_BANNED_DETERMINISTIC_PHRASES) {
    if (t.includes(p)) return p;
  }
  return null;
}

/** P0：久候模板已停用；若需話術請改由 DB／LLM */
export const BRAND_DELAY_SHIPPING_TEMPLATE = "";

/** P0 Minimal Safe Mode：不組確定性追問句，交還 LLM */
export function buildDeterministicFollowUpReply(_ctx: ActiveOrderContext, _userMessage?: string): string | null {
  return null;
}

```
## server/superlanding.ts

```typescript
import type { OrderInfo, DeliveryTargetType } from "@shared/schema";
import { storage } from "./storage";
import { normalizePhone as normalizePhoneDigits } from "./order-index";

const SUPERLANDING_API_BASE = "https://api.super-landing.com";

/** 延遲 ms 毫秒，用於分頁請求間隔，避免 Rate Limit */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 讓出 Event Loop 給其他請求（如客服 API），避免 TTFB 飆高、網頁載入被卡住 */
function yieldEventLoop(ms = 300): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 單次 fetch 失敗時重試（如 ECONNRESET），最多 retries 次，每次間隔 3 秒 */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries = 3
): Promise<Response> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fetch(url, options);
    } catch (err: any) {
      if (attempt < retries) {
        console.warn(`[一頁商店] 請求失敗 (${attempt}/${retries})，3 秒後重試:`, err?.message || err);
        await sleep(3000);
      } else {
        throw err;
      }
    }
  }
  throw new Error("fetchWithRetry exhausted");
}

const ORDER_STATUS_MAP: Record<string, string> = {
  new_order: "新訂單",
  confirming: "確認中",
  confirmed: "已確認",
  awaiting_for_shipment: "待出貨",
  shipping: "出貨中",
  shipped: "已出貨",
  delay_handling: "延遲出貨",
  other: "其他",
  refunding: "退款中",
  refunded: "已退款",
  replacement: "換貨中",
  temp: "臨時",
  returned: "已退貨",
  pending: "待處理",
  canceled: "已取消",
};

export interface SuperLandingConfig {
  merchantNo: string;
  accessKey: string;
}

export function getSuperLandingConfig(brandId?: number): SuperLandingConfig {
  if (brandId) {
    const brand = storage.getBrand(brandId);
    if (brand && brand.superlanding_merchant_no && brand.superlanding_access_key) {
      return {
        merchantNo: brand.superlanding_merchant_no,
        accessKey: brand.superlanding_access_key,
      };
    }
  }
  return {
    merchantNo: storage.getSetting("superlanding_merchant_no") || "",
    accessKey: storage.getSetting("superlanding_access_key") || "",
  };
}

/** 一頁商店 convenient_store 格式：BRAND_STORECODE_門市名_地址，解析為結構化欄位 */
export function parseConvenienceStore(raw: string | null | undefined): {
  cvs_brand: string;
  cvs_store_code: string;
  cvs_store_name: string;
  full_address: string;
} {
  const empty = { cvs_brand: "", cvs_store_code: "", cvs_store_name: "", full_address: "" };
  if (typeof raw !== "string" || !raw.trim()) return empty;
  const parts = raw.trim().split("_");
  if (parts.length < 4) return empty;
  const brandCode = (parts[0] || "").toUpperCase();
  const cvsBrandMap: Record<string, string> = {
    FAMI: "全家",
    UNIMART: "萊爾富",
    ELEVEN: "7-11",
    "7-11": "7-11",
    OK: "OK",
  };
  return {
    cvs_brand: cvsBrandMap[brandCode] ?? brandCode,
    cvs_store_code: parts[1] ?? "",
    cvs_store_name: parts[2] ?? "",
    full_address: parts.slice(3).join("_").trim() || "",
  };
}

/** 依 shipping_method / convenient_store 判斷宅配或超商 */
export function deriveDeliveryTargetType(
  shippingMethod: string | null | undefined,
  convenientStore: string | null | undefined
): DeliveryTargetType {
  const sm = (shippingMethod || "").toLowerCase();
  if (sm && (sm.includes("home") || sm.includes("宅配") || sm.includes("delivery"))) return "home";
  if (sm && (sm.includes("store") || sm.includes("cvs") || sm.includes("超商") || sm === "to_store")) return "cvs";
  if (typeof convenientStore === "string" && convenientStore.trim().length > 0) return "cvs";
  return "unknown";
}

/**
 * 一頁商店：從真實 payload 組出 payment_status_raw，供 derivePaymentStatus 判斷失敗／pending。
 * 不可再把 payment_method 直接當作 payment_status_raw（會把 credit_card/pending 誤當成「支付狀態」）。
 */
export function deriveSuperlandingPaymentStatusRaw(o: Record<string, unknown>): string | undefined {
  const chunks: string[] = [];
  const sn = o.system_note;
  if (sn && typeof sn === "object") {
    const note = sn as Record<string, unknown>;
    const t = String(note.type ?? "").trim();
    const m = String(note.message ?? "").trim();
    if (m) chunks.push(m);
    if (t) chunks.push(`type:${t}`);
  }
  const extraKeys = [
    "payment_status",
    "pay_status",
    "gateway_status",
    "gateway_payment_status",
    "line_pay_status",
    "payment_result",
    "ecpay_status",
    "payment_error_message",
  ] as const;
  for (const k of extraKeys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) chunks.push(v.trim());
    if (v && typeof v === "object" && !Array.isArray(v)) {
      try {
        chunks.push(JSON.stringify(v));
      } catch {
        /* skip */
      }
    }
  }
  if (typeof o.tag === "string" && o.tag.trim()) chunks.push(`tag:${o.tag.trim()}`);
  const st = o.status != null ? String(o.status) : "";
  if (st && /cancel|void|fail|refund|closed|error/i.test(st)) {
    chunks.push(`order.status=${st}`);
  }
  /** 少數 webhook／同步層會包一層 nested `order`（與 orders.json 扁平欄位並存時仍要吃失敗訊號） */
  const nested = o.order;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const no = nested as Record<string, unknown>;
    if (no.status != null) chunks.push(`nested.order.status=${String(no.status)}`);
    const ng = no.gateway_status;
    if (typeof ng === "string" && ng.trim()) chunks.push(ng.trim());
    const sn2 = no.system_note;
    if (sn2 && typeof sn2 === "object") {
      const m2 = String((sn2 as Record<string, unknown>).message ?? "").trim();
      if (m2) chunks.push(m2);
    }
  }
  const joined = chunks.join(" | ").trim();
  return joined || undefined;
}

function mapOrder(o: any): OrderInfo {
  let trackingNumber = "";
  if (Array.isArray(o.tracking_codes) && o.tracking_codes.length > 0) {
    trackingNumber = o.tracking_codes.map((t: any) => t.tracking_code || t).join(", ");
  }

  let productListStr = "";
  let itemsStructured: string | undefined;
  if (Array.isArray(o.product_list)) {
    productListStr = JSON.stringify(o.product_list);
    itemsStructured = productListStr;
  } else if (typeof o.product_list === "string") {
    productListStr = o.product_list;
  }

  let address = "";
  let addressRaw: string | undefined;
  let fullAddress: string | undefined;
  if (typeof o.address === "string") {
    addressRaw = o.address;
    try {
      const parsed = JSON.parse(o.address);
      address = [parsed.state, parsed.city, parsed.addr1, parsed.addr2].filter(Boolean).join("");
      fullAddress = address || o.address;
    } catch (_e) {
      address = o.address;
      fullAddress = o.address;
    }
  } else if (o.address != null) {
    addressRaw = JSON.stringify(o.address);
  }

  const convenientStore = o.convenient_store;
  const deliveryTargetType = deriveDeliveryTargetType(o.shipping_method, convenientStore);
  const cvsParsed = parseConvenienceStore(convenientStore);
  if (deliveryTargetType === "cvs" && cvsParsed.full_address) {
    fullAddress = cvsParsed.full_address;
  } else if (fullAddress === undefined && address) {
    fullAddress = address;
  }

  return {
    global_order_id: o.global_order_id || String(o.id || ""),
    status: o.status || "unknown",
    final_total_order_amount: Number(o.final_total_order_amount || 0),
    product_list: productListStr,
    buyer_name: o.recipient || "",
    buyer_phone: o.mobile || "",
    buyer_email: o.email || "",
    tracking_number: trackingNumber,
    created_at: o.created_date || o.order_created_at || "",
    shipped_at: o.shipped_at || "",
    order_created_at: o.order_created_at || "",
    shipping_method: o.shipping_method || "",
    payment_method: o.payment_method || "",
    prepaid: o.prepaid === true,
    paid_at: o.paid_at || null,
    address,
    note: o.note || "",
    page_id: o.page_id != null ? String(o.page_id) : undefined,
    page_title: typeof o.page_title === "string" ? o.page_title : undefined,
    payment_status_raw: deriveSuperlandingPaymentStatusRaw(o as Record<string, unknown>),
    delivery_status_raw: o.status != null ? String(o.status) : undefined,
    delivery_target_type: deliveryTargetType,
    cvs_brand: cvsParsed.cvs_brand || undefined,
    cvs_store_code: cvsParsed.cvs_store_code || undefined,
    cvs_store_name: cvsParsed.cvs_store_name || undefined,
    full_address: fullAddress,
    address_raw: addressRaw,
    payment_transaction_id: typeof o.payment_transaction_id === "string" ? o.payment_transaction_id : undefined,
    items_structured: itemsStructured,
  };
}

/** Phase34B：供 fixture / verify 走完整 payload → mapOrder → derivePaymentStatus */
export function mapSuperlandingOrderFromApiPayload(raw: Record<string, unknown>): OrderInfo {
  return mapOrder(raw as any);
}

export function getStatusLabel(status: string): string {
  return ORDER_STATUS_MAP[status] || status;
}

export async function fetchOrders(
  config: SuperLandingConfig,
  params: Record<string, string> = {}
): Promise<OrderInfo[]> {
  if (!config.merchantNo || !config.accessKey) {
    throw new Error("missing_credentials");
  }

  const queryParams = new URLSearchParams({
    merchant_no: config.merchantNo,
    access_key: config.accessKey,
    ...params,
  });

  const url = `${SUPERLANDING_API_BASE}/orders.json?${queryParams.toString()}`;
  console.log("[一頁商店] 正在查詢訂單，請求網址為:", url.replace(config.accessKey, "***"));

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "Accept": "application/json" },
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error("[一頁商店] API 回傳錯誤:", res.status, errText);
      if (res.status === 401) throw new Error("invalid_credentials");
      throw new Error(`api_error_${res.status}`);
    }

    const data = await res.json();
    console.log("[一頁商店] 回傳結果: current_page=", data.current_page, "total_entries=", data.total_entries, "orders count=", Array.isArray(data.orders) ? data.orders.length : "N/A");

    const orders = Array.isArray(data) ? data : data?.orders || [];

    return orders.map(mapOrder);
  } catch (err: any) {
    if (err.message === "missing_credentials" || err.message === "invalid_credentials") throw err;
    if (err.message?.startsWith("api_error_")) throw err;
    console.error("[一頁商店] 連線失敗:", err);
    throw new Error("connection_failed");
  }
}

export interface DateFilterResult {
  orders: OrderInfo[];
  totalFetched: number;
  truncated: boolean;
}

export async function lookupOrdersByDateAndFilter(
  config: SuperLandingConfig,
  query: string,
  beginDate: string,
  endDate: string
): Promise<DateFilterResult> {
  let page = 1;
  const perPage = 200;
  const maxPages = 25;
  let allOrders: OrderInfo[] = [];
  let truncated = false;

  while (true) {
    const orders = await fetchOrders(config, {
      begin_date: beginDate,
      end_date: endDate,
      per_page: String(perPage),
      page: String(page),
    });
    allOrders = allOrders.concat(orders);
    if (orders.length < perPage) break;
    page++;
    if (page > maxPages) {
      truncated = true;
      break;
    }
  }

  console.log(`[一頁商店] 日期範圍 ${beginDate}~${endDate} 共取得 ${allOrders.length} 筆${truncated ? "（已截斷）" : ""}，開始比對 "${query}"`);

  const normalizedQuery = query.replace(/[-\s]/g, "").toLowerCase();
  const matched = allOrders.filter((o) => {
    const phone = o.buyer_phone.replace(/[-\s]/g, "").toLowerCase();
    const email = o.buyer_email.toLowerCase();
    const name = o.buyer_name.toLowerCase();
    return (
      (phone && (phone.includes(normalizedQuery) || normalizedQuery.includes(phone))) ||
      (email && email === normalizedQuery) ||
      (name && name.includes(normalizedQuery))
    );
  });

  return { orders: matched, totalFetched: allOrders.length, truncated };
}

export interface ProductPageMapping {
  id: string;
  pageId: string;
  prefix: string;
  productName: string;
}

let cachedPages: ProductPageMapping[] = [];
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60 * 60 * 1000;

/** Phase 106.6：同一組 API 憑證背景刷新只跑一個，避免重疊打爆 SuperLanding */
const pagesBackgroundRefreshLocks = new Set<string>();

function pagesCacheCredentialKey(config: SuperLandingConfig): string {
  return `${String(config.merchantNo || "").trim()}::${String(config.accessKey || "").trim()}`;
}

export function getCachedPages(): ProductPageMapping[] {
  return cachedPages;
}

export function getCachedPagesAge(): number {
  return cacheTimestamp > 0 ? Date.now() - cacheTimestamp : Infinity;
}

export async function refreshPagesCache(
  config: SuperLandingConfig,
  opts?: { maxPages?: number }
): Promise<ProductPageMapping[]> {
  if (!config.merchantNo || !config.accessKey) {
    console.log("[銷售頁快取] 尚未設定 API 金鑰，略過同步");
    return cachedPages;
  }
  try {
    const fetchOpts = opts?.maxPages != null ? { maxPages: opts.maxPages } : undefined;
    const pages = await fetchPages(config, fetchOpts);
    cachedPages = pages;
    cacheTimestamp = Date.now();
    console.log(`[銷售頁快取] 同步完成，共 ${pages.length} 個銷售頁${opts?.maxPages != null ? `（maxPages=${opts.maxPages}）` : ""}`);
    return pages;
  } catch (err: any) {
    console.error("[銷售頁快取] 同步失敗:", err.message);
    cacheTimestamp = Date.now();
    return cachedPages;
  }
}

export async function ensurePagesCacheLoaded(config: SuperLandingConfig): Promise<ProductPageMapping[]> {
  /** review bundle：僅匯出 prompt 快照時勿打銷售頁 API（避免 100+ 頁輪詢卡住打包） */
  if (process.env.REVIEW_PROMPT_EXPORT_SKIP_CATALOG === "1") {
    return [];
  }
  const now = Date.now();
  const cacheAge = cacheTimestamp > 0 ? now - cacheTimestamp : Infinity;
  const cacheFresh = cachedPages.length > 0 && cacheAge < CACHE_TTL_MS;
  if (cacheFresh) {
    return cachedPages;
  }
  /** 完全沒資料：必須同步拉一次（完整分頁；prompt 層另有 3s 超時保護） */
  if (cachedPages.length === 0) {
    return refreshPagesCache(config);
  }
  /** stale-while-revalidate：有舊資料先回傳，過期則背景刷新（限縮頁數避免主流程以外的長尾） */
  const lockKey = pagesCacheCredentialKey(config);
  if (!pagesBackgroundRefreshLocks.has(lockKey)) {
    pagesBackgroundRefreshLocks.add(lockKey);
    refreshPagesCache(config, { maxPages: 30 })
      .catch((err) => console.error("[catalog] background refresh failed", err?.message || err))
      .finally(() => pagesBackgroundRefreshLocks.delete(lockKey));
  }
  console.log("[catalog] using stale cache while refreshing in background", {
    merchantNo: config.merchantNo,
    cacheAgeMs: Math.round(cacheAge),
    staleEntries: cachedPages.length,
  });
  return cachedPages;
}

export function buildProductCatalogPrompt(pages: ProductPageMapping[]): string {
  if (pages.length === 0) return "";
  const displayPages = pages.slice(0, 100);
  const lines = displayPages.map((p, i) => `- #${i + 1}｜${p.productName}`);
  const extraNote = pages.length > displayPages.length ? `\n（以上僅列出前 ${displayPages.length} 項，共 ${pages.length} 項商品。查詢工具已包含完整商品清單的模糊比對功能，直接將客戶描述的商品名稱傳入即可。）` : "";
  return `\n\n## [內部參考·商品清單]（自動同步，共 ${pages.length} 項）\n以下為本店部分商品，僅供你內部語意比對使用。禁止將編號、清單格式或任何內部資訊展示給客戶：\n${lines.join("\n")}${extraNote}\n\n## [內部規則] 產品辨識與查詢流程\n\n### 模糊匹配\n- 客戶可能用錯字、簡稱、俗稱或用途描述來指稱商品。\n- 你必須從上方商品清單中，用語意理解推論最佳匹配。\n\n### 二次確認（防呆）\n- 若客戶描述可能對應多個商品，用溫暖口語化的方式列出選項讓客戶確認。\n- 話術範例：「了解～因為跟○○相關的商品有幾款，想跟您確認一下，您購買的是『A商品名稱』還是『B商品名稱』呢？」\n- 只列出人類可讀的產品名稱，禁止顯示編號或任何代碼。\n\n### 自動觸發查詢\n- 確認唯一商品後，連同客戶手機號碼觸發訂單查詢。\n- 若完全找不到匹配商品，友善回覆：「不好意思，目前沒有找到跟您描述相符的商品，可以再確認一下商品名稱嗎？或者直接提供訂單編號我也能幫您查詢唷！」\n\n## [內部規則] 嚴格保密限制\n- **絕對禁止**在對話中顯示任何內部編號、API 欄位、系統代碼、技術參數。\n- **絕對禁止**提及「對應表」「商品清單」「備用查詢」「Function Calling」等系統用語。\n- 所有回覆必須像一位溫暖、專業的真人客服，使用口語化、親切的語氣。\n- 禁止使用條列式的系統說明（如「步驟一」「走備用查詢」），改用自然對話語氣。\n\n## [內部規則] 上下文實體提取\n- 執行查詢前，務必回顧整段歷史對話。\n- 若客戶先前已提過產品名稱或手機號碼，直接合併使用，**絕對不可重複詢問已提供過的資訊**。\n- 從整段對話中提取所有「產品名稱」和「電話號碼」實體，而非僅看最後一則訊息。\n\n## [內部規則] 回覆語氣指南\n- 語氣溫暖親切，像朋友般自然，適度使用「唷」「呢」「～」等語助詞。\n- 用「了解」「沒問題」「好的」開場，避免「根據系統」「依照規則」等機械用語。\n- 適度使用 emoji（😊、✨）但不過度。\n- 回覆簡潔有力，不冗長囉嗦。`;
}

export async function fetchPages(
  config: SuperLandingConfig,
  opts?: { maxPages?: number }
): Promise<ProductPageMapping[]> {
  if (!config.merchantNo || !config.accessKey) {
    throw new Error("missing_credentials");
  }

  const maxPagesLimit = opts?.maxPages;

  console.log("[一頁商店] 正在取得銷售頁列表...");

  try {
    let allPages: any[] = [];
    let pageNum = 1;
    const maxApiPages = 200;
    const delayBetweenPagesMs = 800;

    while (true) {
      if (maxPagesLimit != null && pageNum > maxPagesLimit) break;
      const queryParams = new URLSearchParams({
        merchant_no: config.merchantNo,
        access_key: config.accessKey,
        per_page: "100",
        page: String(pageNum),
      });

      const url = `${SUPERLANDING_API_BASE}/pages.json?${queryParams.toString()}`;
      let res: Response;
      try {
        res = await fetchWithRetry(url, {
          method: "GET",
          headers: { "Accept": "application/json" },
        });
      } catch (fetchErr: any) {
        console.error(`[一頁商店] 銷售頁第 ${pageNum} 頁在重試後仍失敗:`, fetchErr?.message || fetchErr);
        break;
      }

      if (!res.ok) {
        if (res.status === 401) throw new Error("invalid_credentials");
        throw new Error(`api_error_${res.status}`);
      }

      const data = await res.json();
      const pages = Array.isArray(data) ? data : data?.pages || [];
      allPages = allPages.concat(pages);

      if (pageNum === 1) {
        console.log(`[一頁商店] 銷售頁 API: total_entries=${data.total_entries || "?"} total_pages=${data.total_pages || "?"}`);
      }

      await yieldEventLoop(300);

      const totalPages = data.total_pages || 1;
      if (pageNum >= totalPages || pages.length === 0) break;
      pageNum++;
      if (pageNum > maxApiPages) break;

      await sleep(delayBetweenPagesMs);
    }

    console.log(`[一頁商店] 取得 ${allPages.length} 個銷售頁（${pageNum} 頁 API 請求）`);

    const mapped = allPages.map((p: any) => ({
      id: String(p.id),
      pageId: String(p.id),
      prefix: p.id_prefix || "",
      productName: p.title || p.name || `銷售頁 ${p.id}`,
    }));

    if (mapped.length > 0 && mapped.length <= 50) {
      console.log("[一頁商店] 產品清單:");
      mapped.forEach((m: ProductPageMapping) => console.log(`  - [${m.pageId}] ${m.productName}`));
    } else if (mapped.length > 50) {
      console.log(`[一頁商店] 產品清單（顯示前 20 筆 / 共 ${mapped.length} 筆）:`);
      mapped.slice(0, 20).forEach((m: ProductPageMapping) => console.log(`  - [${m.pageId}] ${m.productName}`));
      console.log("  ... 略");
    }

    return mapped;
  } catch (err: any) {
    if (err.message === "missing_credentials" || err.message === "invalid_credentials") throw err;
    if (err.message?.startsWith("api_error_")) throw err;
    console.error("[一頁商店] 取得銷售頁失敗:", err);
    throw new Error("connection_failed");
  }
}

export async function lookupOrdersByPageAndPhone(
  config: SuperLandingConfig,
  pageId: string,
  phone: string
): Promise<DateFilterResult> {
  const normalizedPhone = phone.replace(/[-\s]/g, "");
  const perPage = 200;

  let totalEntries = 0;
  try {
    const probeRes = await fetch(
      `${SUPERLANDING_API_BASE}/orders.json?${new URLSearchParams({
        merchant_no: config.merchantNo,
        access_key: config.accessKey,
        page_id: pageId,
        per_page: "1",
        page: "1",
      }).toString()}`,
      { method: "GET", headers: { "Accept": "application/json" } }
    );
    if (probeRes.ok) {
      const probeData = await probeRes.json();
      totalEntries = probeData.total_entries || 0;
    }
  } catch (err: any) {
    console.error(`[一頁商店] page_id=${pageId} 探測失敗:`, err.message);
  }

  /** Phase 30：多日期視窗合併去重，不可第一個視窗命中就早退（與 lookupOrdersByPhone 一致） */
  if (totalEntries > 3000) {
    console.log(`[一頁商店] page_id=${pageId} 有 ${totalEntries} 筆訂單，使用日期窗口合併搜尋`);
    const dateWindows = [{ days: 7 }, { days: 30 }, { days: 90 }, { days: 365 }];
    const byOrderId = new Map<string, OrderInfo>();
    let totalFetched = 0;

    for (const window of dateWindows) {
      const today = new Date();
      const start = new Date(today.getTime() - window.days * 24 * 60 * 60 * 1000);
      const endDate = today.toISOString().split("T")[0];
      const beginDate = start.toISOString().split("T")[0];

      let allOrders: OrderInfo[] = [];
      let p = 1;
      const maxPages = 50;

      while (true) {
        const orders = await fetchOrders(config, {
          page_id: pageId,
          begin_date: beginDate,
          end_date: endDate,
          per_page: String(perPage),
          page: String(p),
        });
        allOrders = allOrders.concat(orders);
        await yieldEventLoop(300);
        if (orders.length < perPage) break;
        p++;
        if (p > maxPages) break;
      }

      totalFetched += allOrders.length;
      const windowHits = allOrders.filter((o) => o.buyer_phone.replace(/[-\s]/g, "") === normalizedPhone).length;
      for (const o of allOrders) {
        const orderPhone = o.buyer_phone.replace(/[-\s]/g, "");
        if (orderPhone === normalizedPhone) byOrderId.set(o.global_order_id, o);
      }
      const cumulativeUnique = byOrderId.size;
      console.log(
        `[一頁商店] page_phone_window=${window.days} window_hits=${windowHits} cumulative_unique_hits=${cumulativeUnique} 累計不重複匹配 ${cumulativeUnique} page_id=${pageId}`
      );
    }

    const merged = Array.from(byOrderId.values());
    return { orders: merged, totalFetched, truncated: merged.length === 0 && totalEntries > 0 };
  }

  let page = 1;
  const maxPages = 40;
  let allOrders: OrderInfo[] = [];
  let truncated = false;

  while (true) {
    const orders = await fetchOrders(config, {
      page_id: pageId,
      per_page: String(perPage),
      page: String(page),
    });
    allOrders = allOrders.concat(orders);
    await yieldEventLoop(300);
    if (orders.length < perPage) break;
    page++;
    if (page > maxPages) {
      truncated = true;
      break;
    }
  }

  console.log(`[一頁商店] page_id=${pageId} 共取得 ${allOrders.length} 筆${truncated ? "（已截斷）" : ""}，開始比對電話 "${normalizedPhone}"`);

  const matched = allOrders.filter(o => {
    const orderPhone = o.buyer_phone.replace(/[-\s]/g, "");
    return orderPhone === normalizedPhone;
  });

  return { orders: matched, totalFetched: allOrders.length, truncated };
}

export async function lookupOrderById(
  config: SuperLandingConfig,
  orderId: string
): Promise<OrderInfo | null> {
  const normalizedId = orderId.trim().toUpperCase();
  console.log(`[API 請求] 準備查詢單號: ${normalizedId}，merchant_no: ${config.merchantNo}`);
  const orders = await fetchOrders(config, { global_order_id: normalizedId });
  console.log(`[API 回應] 查詢結果: ${orders.length} 筆`, orders.length > 0 ? `→ 找到訂單 ${orders[0].global_order_id} 狀態=${orders[0].status}` : "→ 查無資料");
  return orders.length > 0 ? orders[0] : null;
}

export async function lookupOrdersByPhone(
  config: SuperLandingConfig,
  phone: string,
  productKeyword?: string
): Promise<DateFilterResult> {
  const normalizedPhone = normalizePhoneDigits(phone);
  console.log("[一頁商店] 以手機號碼全域搜尋:", normalizedPhone, productKeyword ? `關鍵字: ${productKeyword}` : "");

  let allMatched: OrderInfo[] = [];
  let totalScanned = 0;
  let wasTruncated = false;
  const perPage = 200;
  const parallelBatch = 5;

  /** Phase 106：視窗內仍完整掃描；一旦任一視窗結束後已命中手機訂單，不再掃更大視窗（加速 live 路徑） */
  const dateWindows = [
    { days: 1, label: "今天" },
    { days: 3, label: "3天" },
    { days: 7, label: "7天" },
    { days: 30, label: "30天" },
    { days: 90, label: "90天" },
    { days: 180, label: "180天" },
  ];
  const byOrderId = new Map<string, OrderInfo>();

  for (const window of dateWindows) {
    const today = new Date();
    const start = new Date(today.getTime() - (window.days - 1) * 24 * 60 * 60 * 1000);
    const endDate = today.toISOString().split("T")[0];
    const beginDate = start.toISOString().split("T")[0];

    let totalEntries = 0;
    try {
      const probeRes = await fetch(
        `${SUPERLANDING_API_BASE}/orders.json?${new URLSearchParams({
          merchant_no: config.merchantNo,
          access_key: config.accessKey,
          begin_date: beginDate,
          end_date: endDate,
          per_page: "1",
          page: "1",
        }).toString()}`,
        { method: "GET", headers: { "Accept": "application/json" } }
      );
      const probeData = await probeRes.json();
      totalEntries = probeData.total_entries || 0;
    } catch (err: any) {
      console.error(`[一頁商店] ${window.label}窗口探測失敗:`, err.message);
      continue;
    }
    const totalPages = Math.ceil(totalEntries / perPage);
    const maxPages = Math.min(totalPages, 150);
    if (totalPages > maxPages) wasTruncated = true;

    console.log(`[一頁商店] ${window.label}窗口（${beginDate}~${endDate}）: ${totalEntries} 筆，掃描 ${maxPages} 頁${totalPages > maxPages ? "（截斷）" : ""}`);

    if (totalEntries === 0) continue;

    let windowHits = 0;
    for (let batchStart = 1; batchStart <= maxPages; batchStart += parallelBatch) {
      const pageNums = [];
      for (let p = batchStart; p < batchStart + parallelBatch && p <= maxPages; p++) {
        pageNums.push(p);
      }

      const batchResults = await Promise.all(
        pageNums.map(p =>
          fetchOrders(config, {
            begin_date: beginDate,
            end_date: endDate,
            per_page: String(perPage),
            page: String(p),
          })
        )
      );

      for (const orders of batchResults) {
        totalScanned += orders.length;
        for (const o of orders) {
          const orderPhone = normalizePhoneDigits(o.buyer_phone || "");
          if (orderPhone === normalizedPhone) {
            byOrderId.set(o.global_order_id, o);
            windowHits++;
          }
        }
      }

      await yieldEventLoop(300);
    }

    console.log(
      `[一頁商店] ${window.label}窗口掃描完成，本視窗手機命中 ${windowHits} 筆（累計不重複 ${byOrderId.size}）`
    );

    if (byOrderId.size > 0) {
      const remaining = dateWindows
        .slice(dateWindows.indexOf(window) + 1)
        .map((w) => w.label)
        .join("、");
      console.log(
        `[一頁商店] ${window.label}視窗已找到 ${byOrderId.size} 筆，提前結束（不掃 ${remaining || "（無）"}）`
      );
      break;
    }
  }

  const uniqueOrders = Array.from(byOrderId.values());

  if (productKeyword && uniqueOrders.length > 0) {
    const kw = productKeyword.toLowerCase();
    const filtered = uniqueOrders.filter(o => o.product_list.toLowerCase().includes(kw));
    if (filtered.length > 0) {
      console.log(`[一頁商店] 關鍵字「${productKeyword}」篩選後 ${filtered.length} 筆`);
      return { orders: filtered, totalFetched: totalScanned, truncated: false };
    }
    console.log(`[一頁商店] 關鍵字「${productKeyword}」無匹配，回傳全部 ${uniqueOrders.length} 筆`);
  }

  console.log(`[一頁商店] 全域搜尋完成：掃描 ${totalScanned} 筆，找到 ${uniqueOrders.length} 筆`);
  return { orders: uniqueOrders, totalFetched: totalScanned, truncated: wasTruncated };
}

/** Phase 1：依手機號碼全域查單（不限定 page_id）之別名 */
export const lookup_order_by_phone_global = lookupOrdersByPhone;

```
## server/idle-close-job.ts

```typescript
/**
 * 24 小時閒置結案：客戶最後一則訊息後 24 小時未回覆則走結案流程。
 * 排除：轉人工／高風險／已指派但客服尚未回覆等（見 isInHandoffOrPendingHumanReply）；待分配 needs_human 無指派另案排除。
 * 結案分流：一般諮詢 / 待補單號 / 退換貨待填表 / handoff 不關閉。
 *
 * Phase 106.15：滿 24h 的「到期瞬間」若落在非營業時間（含週末、國定假日），順延至下一營業日開門才結案；
 * 排程可持續執行本 job，由每筆 realCloseMoment 決定是否到點。
 */
import type { IStorage } from "./storage";
import {
  BUSINESS_HOURS,
  findNextBusinessMoment,
  getTaipeiComponents,
  isHoliday,
  isWithinBusinessHours,
} from "./services/business-hours";
import { pushLineMessage, sendFBMessage, getLineTokenForContact, getFbTokenForContact, sendRatingFlexMessage } from "./services/messaging.service";
import { broadcastSSE } from "./services/sse.service";
import { isRatingEligible, isAutomatedRatingFlexAllowedForContact } from "./rating-eligibility";

const IDLE_HOURS_DEFAULT = 24;
const MS_PER_HOUR = 60 * 60 * 1000;

function formatTaipeiWallClock(d: Date): string {
  return d.toLocaleString("sv-SE", {
    timeZone: BUSINESS_HOURS.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export type IdleCloseScenario = "general" | "waiting_order_info" | "waiting_return_form" | "handoff_no_close";

/** Phase 106.12：退換／取消表單情境的精準標籤白名單（整詞比對，不用 includes） */
const RETURN_FORM_PRECISE_TAGS = new Set([
  "退貨",
  "換貨",
  "退款",
  "退換貨",
  "退換",
  "申請退貨",
  "申請換貨",
  "申請退款",
]);

const CLOSING_MESSAGES: Record<IdleCloseScenario, string> = {
  general:
    "這邊好一陣子沒收到您的後續訊息，先幫您整理結案唷～\n若之後還想確認商品、價格或下單方式，直接再傳訊息給我，隨時都能繼續協助您！",
  waiting_order_info:
    "這邊好一陣子沒收到您的後續訊息，先幫您整理結案唷～\n若之後找到訂單編號或想到下單時的手機號碼，再傳訊息給我，我這邊就能接著幫您查～",
  waiting_return_form:
    "這邊好一陣子沒收到您的後續訊息，先幫您整理結案唷～\n若之後想繼續處理或填寫退換貨表單，再傳訊息給我，隨時都能接著協助您～",
  handoff_no_close:
    "", // 已轉人工不發結案語，僅內部告警
};

export interface IdleCloseResult {
  contactId: number;
  closed: boolean;
  scenario: IdleCloseScenario;
  messageSent: string | null;
  closeReason: string;
}

function parseContactTags(contact: any): string[] {
  return (typeof contact.tags === "string"
    ? (() => {
        try {
          return JSON.parse(contact.tags || "[]");
        } catch {
          return [];
        }
      })()
    : contact.tags) as string[];
}

function isInHandoffOrPendingHumanReply(contact: any): boolean {
  if (contact.status === "awaiting_human" || contact.status === "high_risk") {
    return true;
  }
  const aid = contact.assigned_agent_id;
  const hasAgent = aid != null && Number(aid) > 0;
  const lastUser = String(contact.last_message_sender_type || "").toLowerCase() === "user";
  if (hasAgent && lastUser && (contact.last_human_reply_at == null || String(contact.last_human_reply_at).trim() === "")) {
    return true;
  }
  return false;
}

function getScenario(contact: any, _lastUserAt: Date): IdleCloseScenario {
  const tags = parseContactTags(contact);

  let scenario: IdleCloseScenario;
  if (isInHandoffOrPendingHumanReply(contact)) {
    scenario = "handoff_no_close";
  } else if (tags.some((t: string) => t === "待訂單編號" || t === "待補單號")) {
    scenario = "waiting_order_info";
  } else {
    const isInReturnFormFlow =
      contact.waiting_for_customer === "return_form_submit" ||
      contact.waiting_for_customer === "exchange_form_submit" ||
      contact.waiting_for_customer === "cancel_form_submit" ||
      tags.some((t: string) => RETURN_FORM_PRECISE_TAGS.has(t));
    scenario = isInReturnFormFlow ? "waiting_return_form" : "general";
  }

  console.log("[idle-close] scenario_decision", {
    contactId: contact.id,
    scenario,
    hasWaitingFormState: !!contact.waiting_for_customer,
    waitingForCustomer: contact.waiting_for_customer,
    hasReturnFormPreciseTag: tags.some((t: string) => RETURN_FORM_PRECISE_TAGS.has(t)),
    legacyIssueType: contact.issue_type,
  });

  return scenario;
}

export async function runIdleCloseJob(storage: IStorage, idleHours: number = IDLE_HOURS_DEFAULT): Promise<IdleCloseResult[]> {
  const results: IdleCloseResult[] = [];

  const contacts = storage.getContacts(undefined, undefined, undefined, 5000);
  for (const c of contacts) {
    if (c.status === "closed" || c.status === "resolved") continue;
    /** 待分配（需人工但尚未指派）：不自動結案，留給主管分配或手動結案，避免品牌案件全變成已結案 */
    if (c.needs_human === 1 && !(c as any).assigned_agent_id) continue;
    const lastAt = c.last_message_at;
    if (!lastAt) continue;
    const lastSender = (c as any).last_message_sender_type;
    if (String(lastSender || "").toLowerCase() !== "user") continue;

    const lastMessageMs = new Date(String(lastAt).replace(" ", "T")).getTime();
    const idleMs = Date.now() - lastMessageMs;
    if (idleMs < idleHours * MS_PER_HOUR) continue;

    const lastUserAt = new Date(lastMessageMs);

    const expireMoment = new Date(lastMessageMs + idleHours * MS_PER_HOUR);
    const realCloseMoment = findNextBusinessMoment(expireMoment);
    const tpExpire = getTaipeiComponents(expireMoment);
    const postpone = Date.now() < realCloseMoment.getTime();
    console.log("[idle-close-debug]", {
      contactId: c.id,
      expireMoment: formatTaipeiWallClock(expireMoment),
      realCloseMoment: formatTaipeiWallClock(realCloseMoment),
      "isWithinBusinessHours(expireMoment)": isWithinBusinessHours(expireMoment),
      "isHoliday(expireMoment)": isHoliday(tpExpire.dateStr),
      dayOfWeek: tpExpire.dayOfWeek,
      decision: postpone ? "postponed" : "proceed",
    });
    if (postpone) {
      console.log("[idle-close] postponed by business hours/holidays", {
        contactId: c.id,
        expireMoment: expireMoment.toISOString(),
        realCloseMoment: realCloseMoment.toISOString(),
        waitMoreMs: realCloseMoment.getTime() - Date.now(),
      });
      continue;
    }

    const scenario = getScenario(c, lastUserAt);
    if (scenario === "handoff_no_close") {
      console.log("[idle-close] skip handoff contact", {
        contactId: c.id,
        status: c.status,
        needs_human: c.needs_human,
      });
      results.push({
        contactId: c.id,
        closed: false,
        scenario: "handoff_no_close",
        messageSent: null,
        closeReason: "handoff_no_auto_close",
      });
      continue;
    }

    console.log("[idle-close] ready to close", {
      contactId: c.id,
      lastMessageAt: c.last_message_at,
      expireMoment: expireMoment.toISOString(),
      realCloseMoment: realCloseMoment.toISOString(),
    });

    const closingText = CLOSING_MESSAGES[scenario];

    const chId = c.channel_id != null ? Number(c.channel_id) : NaN;
    const channel = Number.isFinite(chId) && chId > 0 ? storage.getChannel(chId) : undefined;
    let skipClosingPush = false;
    if (!channel) {
      console.warn("[idle-close] channel not found, skip closing message", { contactId: c.id, channelId: c.channel_id });
      skipClosingPush = true;
    } else if ((channel.is_ai_enabled ?? 0) !== 1) {
      console.log("[idle-close] channel AI disabled, skip closing message push", {
        contactId: c.id,
        channelId: channel.id,
        channelName: channel.channel_name,
        scenario,
      });
      storage.createSystemAlert({
        alert_type: "idle_close_skipped_ai_disabled",
        details: JSON.stringify({
          contactId: c.id,
          channelId: channel.id,
          channelName: channel.channel_name,
          reason: "channel_ai_disabled",
          scenario,
          wouldHaveSentMessage: closingText,
          timestamp: new Date().toISOString(),
        }),
        brand_id: c.brand_id ?? channel.brand_id,
        contact_id: c.id,
      });
      skipClosingPush = true;
    }

    storage.updateContactStatus(c.id, "closed");
    storage.updateContactClosed(c.id, 0, "idle_24h");
    storage.updateContactConversationFields(c.id, { resolution_status: "closed", close_reason: "idle_24h" });

    const updatedAfterClose = storage.getContact(c.id);
    const willPushClosingMessage = Boolean(closingText && !skipClosingPush);
    const willPushRatingFlex = Boolean(
      updatedAfterClose &&
        isRatingEligible({ contact: updatedAfterClose, state: null }) &&
        isAutomatedRatingFlexAllowedForContact(updatedAfterClose, storage) &&
        updatedAfterClose.platform === "line" &&
        getLineTokenForContact(updatedAfterClose as any),
    );
    console.log("[idle-close] decision", {
      contactId: c.id,
      scenario,
      channelAiEnabled: channel?.is_ai_enabled ?? null,
      willPushClosingMessage,
      willPushRatingFlex,
    });

    let aiMsg: { id: number } | null = null;
    if (closingText && !skipClosingPush) {
      aiMsg = storage.createMessage(c.id, c.platform, "ai", closingText) as { id: number };
    }

    try {
      if (willPushClosingMessage && c.platform === "line" && c.platform_user_id) {
        const token = getLineTokenForContact(c as any);
        if (token) {
          await pushLineMessage(c.platform_user_id, [{ type: "text", text: closingText }], token);
          console.log(`[idle-close] LINE 結案訊息已推送 contact=${c.id}`);
        }
      } else if (willPushClosingMessage && c.platform === "messenger" && c.platform_user_id) {
        const token = getFbTokenForContact(c as any);
        if (token) {
          await sendFBMessage(token, c.platform_user_id, closingText);
          console.log(`[idle-close] FB 結案訊息已推送 contact=${c.id}`);
        }
      }
    } catch (e) {
      console.error(`[idle-close] 推送結案訊息失敗 contact=${c.id}:`, e);
    }

    if (aiMsg != null && c.brand_id != null) {
      broadcastSSE("new_message", { contact_id: c.id, message: aiMsg, brand_id: c.brand_id });
      broadcastSSE("contacts_updated", { brand_id: c.brand_id });
    }

    try {
      const updatedContact = updatedAfterClose ?? storage.getContact(c.id);
      if (
        updatedContact &&
        isRatingEligible({ contact: updatedContact, state: null }) &&
        isAutomatedRatingFlexAllowedForContact(updatedContact, storage) &&
        updatedContact.platform === "line"
      ) {
        const token = getLineTokenForContact(updatedContact as any);
        if (token) {
          let ratingSent = false;
          if (updatedContact.needs_human === 1 && updatedContact.cs_rating == null) {
            await sendRatingFlexMessage(updatedContact as any, "human");
            ratingSent = true;
          } else if (!ratingSent && updatedContact.ai_rating == null) {
            await sendRatingFlexMessage(updatedContact as any, "ai");
            ratingSent = true;
          }
          if (ratingSent) {
            const now = new Date().toISOString().replace("T", " ").substring(0, 19);
            storage.updateContactConversationFields(c.id, { rating_invited_at: now });
            storage.createMessage(c.id, c.platform, "system", "(系統) 已發送滿意度評價邀請給客戶");
            console.log(`[idle-close] LINE 評價邀請已發送 contact=${c.id}`);
            broadcastSSE("contacts_updated", { contact_id: c.id, brand_id: updatedContact.brand_id ?? undefined });
          }
        }
      }
    } catch (e) {
      console.error(`[idle-close] 發送評價邀請失敗 contact=${c.id}:`, e);
    }

    results.push({
      contactId: c.id,
      closed: true,
      scenario,
      messageSent: skipClosingPush ? null : closingText || null,
      closeReason: "idle_24h",
    });
  }

  return results;
}

export function getIdleCloseHours(storage: IStorage): number {
  const raw = storage.getSetting("idle_close_hours");
  if (raw == null || raw === "") return IDLE_HOURS_DEFAULT;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1) return IDLE_HOURS_DEFAULT;
  return Math.min(168, n);
}

```
