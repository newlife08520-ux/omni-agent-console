import type { OrderInfo } from "@shared/schema";
import type { SuperLandingConfig } from "./superlanding";
import type { ShoplineConfig } from "./shopline";
import { lookupOrderById, lookupOrdersByPageAndPhone, lookupOrdersByDateAndFilter, lookupOrdersByPhone, getStatusLabel } from "./superlanding";
import { lookupShoplineOrderById, lookupShoplineOrdersByPhone, lookupShoplineOrdersByEmail, lookupShoplineOrdersByName, getShoplineStatusLabel } from "./shopline";
import { storage } from "./storage";
import {
  getOrderByOrderId,
  getOrdersByPhone,
  getOrdersByPhoneMerged,
  getOrderLookupCache,
  setOrderLookupCache,
  normalizePhone,
  upsertOrderNormalized,
  cacheKeyOrderId,
  cacheKeyPhone,
} from "./order-index";
import { filterOrdersByProductQuery } from "./order-product-filter";
import { derivePaymentStatus } from "./order-payment-utils";

/** Phase 30：local_only 表示僅來自本地索引，可能不完整，不可單筆定案 */
export type DataCoverage = "local_only" | "api_only" | "merged_local_api";

export interface UnifiedOrderResult {
  orders: OrderInfo[];
  source: "superlanding" | "shopline" | "unknown";
  found: boolean;
  crossBrand?: boolean;
  crossBrandName?: string;
  /** 若為 local_only，表示未打 API，資料可能不全，不應單筆直接定案 */
  data_coverage?: DataCoverage;
}

function getShoplineConfig(brandId?: number): ShoplineConfig | null {
  if (brandId) {
    const brand = storage.getBrand(brandId);
    if (brand?.shopline_api_token?.trim()) {
      return {
        storeDomain: brand.shopline_store_domain?.trim() || "",
        apiToken: brand.shopline_api_token.trim(),
      };
    }
  }
  return null;
}

/** 是否應優先以 SHOPLINE 查單（官網購買／推斷為 SHOPLINE 時） */
const PREFER_SHOPLINE_HINTS = /官網|官方網站|官網購買|官網下單|官網買|在官網|從官網|SHOPLINE|shopline/i;

export function shouldPreferShoplineLookup(userMessage: string, recentUserMessages?: string[]): boolean {
  const current = (userMessage || "").trim();
  if (PREFER_SHOPLINE_HINTS.test(current)) return true;
  const recent = recentUserMessages ?? [];
  const combined = [current, ...recent].join(" ");
  return PREFER_SHOPLINE_HINTS.test(combined);
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

export async function unifiedLookupById(
  slConfig: SuperLandingConfig,
  orderId: string,
  brandId?: number,
  preferSource?: OrderLookupPreferSource,
  /** Phase 1：前台查單時傳 false，不搜其他品牌 */
  allowCrossBrand = true
): Promise<UnifiedOrderResult> {
  const idNorm = (orderId || "").trim().toUpperCase();

  if (idNorm && brandId) {
    const scope = preferSource === "shopline" ? "shopline" : preferSource === "superlanding" ? "superlanding" : "any";
    if (scope !== "any") {
      const ck = cacheKeyOrderId(brandId, idNorm, scope);
      const cached = getOrderLookupCache(ck);
      if (cached?.found && cached.orders[0]?.source === scope) {
        return cached as UnifiedOrderResult;
      }
      const loc = getOrderByOrderId(brandId, idNorm, scope);
      if (loc) {
        const result: UnifiedOrderResult = { orders: [loc], source: loc.source || scope, found: true };
        setOrderLookupCache(ck, result);
        setOrderLookupCache(cacheKeyOrderId(brandId, idNorm, "any"), result);
        return result;
      }
    } else {
      const ckAny = cacheKeyOrderId(brandId, idNorm, "any");
      const cachedAny = getOrderLookupCache(ckAny);
      if (cachedAny?.found) return cachedAny as UnifiedOrderResult;
      const locSl = getOrderByOrderId(brandId, idNorm, "superlanding");
      const locSh = getOrderByOrderId(brandId, idNorm, "shopline");
      if (locSl) {
        const result: UnifiedOrderResult = { orders: [locSl], source: "superlanding", found: true };
        setOrderLookupCache(cacheKeyOrderId(brandId, idNorm, "superlanding"), result);
        setOrderLookupCache(ckAny, result);
        return result;
      }
      if (locSh) {
        const result: UnifiedOrderResult = { orders: [locSh], source: "shopline", found: true };
        setOrderLookupCache(cacheKeyOrderId(brandId, idNorm, "shopline"), result);
        setOrderLookupCache(ckAny, result);
        return result;
      }
    }
  }

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
      const sl = await runSuperlanding();
      result = sl ?? { orders: [], source: "unknown", found: false };
    }
  } else {
    const sl = await runSuperlanding();
    if (sl?.found) result = sl;
    else {
      const shop = await runShopline();
      result = shop ?? { orders: [], source: "unknown", found: false };
    }
  }
  if (result.found && result.orders.length > 0 && idNorm && brandId && !result.crossBrand) {
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
      if (o?.global_order_id && o.source)
        upsertOrderNormalized(brandId, o.source as "superlanding" | "shopline", o);
    }
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
    const sl = await runSuperlanding();
    if (sl?.found) return sl;
  } else {
    const sl = await runSuperlanding();
    if (sl?.found) return sl;
    const shop = await runShopline();
    if (shop?.found) return shop;
  }

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
    const sl = await runSuperlanding();
    if (sl?.found) return sl;
  } else {
    const sl = await runSuperlanding();
    if (sl?.found) return sl;
    const shop = await runShopline();
    if (shop?.found) return shop;
  }

  return { orders: [], source: "unknown", found: false };
}

/** 依手機號碼跨管道查單（一頁商店不限定 page，SHOPLINE 依 phone），合併回傳 */
export async function unifiedLookupByPhoneGlobal(
  slConfig: SuperLandingConfig,
  phone: string,
  brandId?: number,
  preferSource?: OrderLookupPreferSource,
  /** Phase 2.1：前台查單時傳 false，不搜其他品牌、不污染當前品牌 cache/index */
  allowCrossBrand = true
): Promise<UnifiedOrderResult> {
  const phoneNorm = normalizePhone(phone);
  if (phoneNorm && brandId) {
    if (preferSource === "shopline") {
      const ck = cacheKeyPhone(brandId, phoneNorm, "shopline");
      const cached = getOrderLookupCache(ck);
      if (cached?.found) return cached as UnifiedOrderResult;
      const localSh = getOrdersByPhone(brandId, phone, "shopline");
      if (localSh.length > 0) {
        const result: UnifiedOrderResult = {
          orders: localSh,
          source: "shopline",
          found: true,
          data_coverage: "local_only",
        };
        setOrderLookupCache(ck, result);
        return result;
      }
    } else if (preferSource === "superlanding") {
      const ck = cacheKeyPhone(brandId, phoneNorm, "superlanding");
      const cached = getOrderLookupCache(ck);
      if (cached?.found) return cached as UnifiedOrderResult;
      const localSl = getOrdersByPhone(brandId, phone, "superlanding");
      if (localSl.length > 0) {
        const result: UnifiedOrderResult = {
          orders: localSl,
          source: "superlanding",
          found: true,
          data_coverage: "local_only",
        };
        setOrderLookupCache(ck, result);
        return result;
      }
    } else {
      const ckAny = cacheKeyPhone(brandId, phoneNorm, "any");
      const cached = getOrderLookupCache(ckAny);
      if (cached?.found) return cached as UnifiedOrderResult;
      const mergedLocal = getOrdersByPhoneMerged(brandId, phone);
      if (mergedLocal.length > 0) {
        const src =
          mergedLocal.every((o) => o.source === "shopline")
            ? "shopline"
            : mergedLocal.every((o) => o.source === "superlanding")
              ? "superlanding"
              : "unknown";
        const result: UnifiedOrderResult = {
          orders: mergedLocal,
          source: src,
          found: true,
          data_coverage: "local_only",
        };
        setOrderLookupCache(ckAny, result);
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
        return { orders: result.orders, source: "shopline", found: true, data_coverage: "api_only" };
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
        return { orders: result.orders, source: "superlanding", found: true, data_coverage: "api_only" };
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
    result = shop ?? { orders: [], source: "unknown", found: false };
  } else if (superlandingOnly) {
    const sl = await runSuperlanding();
    result = sl ?? { orders: [], source: "unknown", found: false };
  } else {
    const [sl, shop] = await Promise.all([runSuperlanding(), runShopline()]);
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
      result = { orders: merged, source: src, found: true, data_coverage: "merged_local_api" };
    } else if (tryShoplineFirst) {
      result = { orders: [], source: "unknown", found: false };
    } else {
      result = { orders: [], source: "unknown", found: false };
    }
  }
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
