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

export interface UnifiedOrderResult {
  orders: OrderInfo[];
  source: "superlanding" | "shopline" | "unknown";
  found: boolean;
  crossBrand?: boolean;
  crossBrandName?: string;
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
        return { orders, source: "shopline", found: true };
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
        const result: UnifiedOrderResult = { orders: mergedLocal, source: src, found: true };
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
        return { orders: result.orders, source: "shopline", found: true };
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
        return { orders: result.orders, source: "superlanding", found: true };
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
      result = { orders: merged, source: src, found: true };
    } else if (tryShoplineFirst) {
      result = { orders: [], source: "unknown", found: false };
    } else {
      result = { orders: [], source: "unknown", found: false };
    }
  }
  if (result.found && result.orders.length > 0 && phoneNorm && brandId && !result.crossBrand) {
    if (preferSource === "shopline") {
      setOrderLookupCache(cacheKeyPhone(brandId, phoneNorm, "shopline"), {
        orders: result.orders,
        source: "shopline",
        found: true,
      });
    } else if (preferSource === "superlanding") {
      setOrderLookupCache(cacheKeyPhone(brandId, phoneNorm, "superlanding"), {
        orders: result.orders,
        source: "superlanding",
        found: true,
      });
    } else {
      setOrderLookupCache(cacheKeyPhone(brandId, phoneNorm, "any"), {
        orders: result.orders,
        source: result.source,
        found: true,
      });
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

/** 訂單狀態是否表示「已可安排出貨」（已付款或為貨到付款） */
const STATUS_IMPLIES_PAID_OR_COD = /已確認|待出貨|出貨中|已出貨|已送達|已完成|處理中/i;

export interface PaymentInterpretationOptions {
  /** 一頁商店：是否已預付。若為 false 且為需先付款之方式，表示付款未成功 */
  prepaid?: boolean;
  /** 實際付款完成時間。無值且非貨到付款時可能表示付款失敗 */
  paid_at?: string | null;
}

/**
 * 依付款方式與訂單狀態，產出給 AI 的「付款與出貨」解讀說明，避免誤判（例如貨到付款卻說要先付款才能出貨）。
 * 若系統回傳 prepaid=false 或無 paid_at（且為需先付款方式），則產出「付款失敗，請重新下單」之指引。
 */
export function getPaymentInterpretationForAI(
  paymentMethod: string | undefined,
  orderStatusLabel: string,
  options?: PaymentInterpretationOptions
): string {
  const pm = (paymentMethod || "").trim().toLowerCase();
  const status = (orderStatusLabel || "").trim();
  const looksPaidOrInProgress = STATUS_IMPLIES_PAID_OR_COD.test(status);
  const prepaid = options?.prepaid;
  const paidAt = options?.paid_at;

  // 需先付款之方式（非貨到付款）：若系統明確回傳 prepaid=false，表示付款未成功
  const requiresPaymentFirst = /credit_card|credit card|linepay|line_pay|line pay/.test(pm);
  const paymentFailed = requiresPaymentFirst && prepaid === false;

  if (paymentFailed) {
    return "此筆訂單**付款未成功**（系統顯示未完成付款）。請明確告知客戶：此筆訂單付款失敗，需請您重新下單。勿說明出貨時間、備註加急或物流；勿讓客戶誤以為訂單有效。";
  }

  // 貨到付款／取件時付款／到收：不需等付款完成即可安排出貨，絕對不可對客人說「需先付款才能出貨」
  if (pm === "pending" || pm === "cod" || pm === "to_store" || pm === "cash_on_delivery" || pm === "取件時付款" || pm === "到收" || /到收|貨到付款/.test(pm)) {
    return "此筆為「貨到付款」（到收／取件時付款）。不需等付款完成即可安排出貨，請勿對客人說需先付款才能出貨。直接說明目前訂單狀態與出貨／物流即可。";
  }

  // 信用卡：若狀態已是已確認/待出貨/出貨中/已出貨 → 已付款；若為新訂單/確認中 → 可能尚未請款或已請款未更新
  if (pm === "credit_card" || pm === "credit card") {
    if (looksPaidOrInProgress) {
      return "此筆為信用卡付款且訂單已進入出貨流程，視為已付款。直接說明目前訂單狀態與出貨／物流即可。";
    }
    return "此筆為信用卡付款。若訂單狀態為新訂單/確認中，可能尚未請款或已請款未更新。回覆時說明目前狀態即可；若客人表示已刷卡，可請其稍候或協助轉專人確認入帳。勿一口咬定「款項尚未完成」才出貨，以免客人已付款卻被誤導。";
  }

  // LINE Pay：同上
  if (pm === "linepay" || pm === "line_pay" || pm === "line pay") {
    if (looksPaidOrInProgress) {
      return "此筆為 LINE Pay 付款且訂單已進入出貨流程，視為已付款。直接說明目前訂單狀態與出貨／物流即可。";
    }
    return "此筆為 LINE Pay 付款。若訂單狀態為新訂單/確認中，可能尚未完成或已完成未更新。回覆時說明目前狀態；若客人表示已付款可請其稍候或協助確認。勿一口咬定需先付款才能出貨。";
  }

  // 轉帳／超商：需等款項入帳後才會安排出貨
  if (pm === "virtual_account" || pm === "ibon" || pm === "atm" || pm === "超商" || pm === "轉帳") {
    return "此筆為轉帳或超商繳費。需等款項入帳後才會安排出貨。可向客人說明目前訂單狀態，若狀態仍為新訂單/確認中可提醒「需等款項入帳後才會安排出貨」，並可請客人確認是否已完成繳費。";
  }

  // 其他或未知
  if (!pm) {
    return "系統未回傳付款方式。回覆時以訂單狀態為主，勿自行推測「需先付款才能出貨」；若客人主動說貨到付款，請依貨到付款邏輯說明（不需等付款即可出貨）。";
  }
  return "回覆時以訂單狀態與出貨進度為主。若客人主動說明付款方式（如貨到付款、已刷卡），請依其說法調整說明，勿誤導為「需先付款才能出貨」當成唯一情況。";
}
