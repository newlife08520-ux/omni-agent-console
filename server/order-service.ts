import type { OrderInfo } from "@shared/schema";
import type { SuperLandingConfig } from "./superlanding";
import type { ShoplineConfig } from "./shopline";
import { lookupOrderById, lookupOrdersByPageAndPhone, lookupOrdersByDateAndFilter, getStatusLabel } from "./superlanding";
import { lookupShoplineOrderById, lookupShoplineOrdersByPhone, lookupShoplineOrdersByEmail, lookupShoplineOrdersByName, getShoplineStatusLabel } from "./shopline";
import { storage } from "./storage";

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

export async function unifiedLookupById(
  slConfig: SuperLandingConfig,
  orderId: string,
  brandId?: number,
  preferSource?: OrderLookupPreferSource
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

export async function unifiedLookupByProductAndPhone(
  slConfig: SuperLandingConfig,
  matchedPages: { pageId: string; productName: string }[],
  phone: string,
  brandId?: number,
  preferSource?: OrderLookupPreferSource
): Promise<UnifiedOrderResult> {
  const tryShoplineFirst = preferSource === "shopline";

  async function runShopline(): Promise<UnifiedOrderResult | null> {
    const shoplineConfig = getShoplineConfig(brandId);
    if (!shoplineConfig) return null;
    try {
      const orders = await lookupShoplineOrdersByPhone(shoplineConfig, phone);
      if (orders.length > 0) {
        orders.forEach(o => { o.source = "shopline"; });
        return { orders, source: "shopline", found: true };
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
        orders = await lookupShoplineOrdersByEmail(shoplineConfig, contact);
      } else if (isPhone) {
        orders = await lookupShoplineOrdersByPhone(shoplineConfig, contact);
      } else {
        orders = await lookupShoplineOrdersByName(shoplineConfig, contact);
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
      const result = await lookupOrdersByDateAndFilter(slConfig, contact, beginDate, endDate, pageId);
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

export function getUnifiedStatusLabel(status: string, source?: string): string {
  if (source === "shopline") {
    return getShoplineStatusLabel(status);
  }
  return getStatusLabel(status);
}

/** 訂單狀態是否表示「已可安排出貨」（已付款或為貨到付款） */
const STATUS_IMPLIES_PAID_OR_COD = /已確認|待出貨|出貨中|已出貨|已送達|已完成|處理中/i;

/**
 * 依付款方式與訂單狀態，產出給 AI 的「付款與出貨」解讀說明，避免誤判（例如貨到付款卻說要先付款才能出貨）。
 * 回傳字串會附在訂單查詢工具結果中，供 AI 依此回覆客人。
 */
export function getPaymentInterpretationForAI(paymentMethod: string | undefined, orderStatusLabel: string): string {
  const pm = (paymentMethod || "").trim().toLowerCase();
  const status = (orderStatusLabel || "").trim();
  const looksPaidOrInProgress = STATUS_IMPLIES_PAID_OR_COD.test(status);

  // 貨到付款／取件時付款：不需等付款完成即可安排出貨，絕對不可對客人說「需先付款才能出貨」
  if (pm === "pending" || pm === "cod" || pm === "to_store" || pm === "cash_on_delivery" || pm === "取件時付款") {
    return "此筆為「貨到付款」（取件時付款）。不需等付款完成即可安排出貨，請勿對客人說需先付款才能出貨。直接說明目前訂單狀態與出貨／物流即可。";
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
