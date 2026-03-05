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

export async function unifiedLookupById(
  slConfig: SuperLandingConfig,
  orderId: string,
  brandId?: number
): Promise<UnifiedOrderResult> {
  if (slConfig.merchantNo && slConfig.accessKey) {
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
  }

  const shoplineConfig = getShoplineConfig(brandId);
  if (shoplineConfig) {
    try {
      const order = await lookupShoplineOrderById(shoplineConfig, orderId);
      if (order) {
        order.source = "shopline";
        return { orders: [order], source: "shopline", found: true };
      }
    } catch (_e) {
      console.log("[UnifiedOrder] SHOPLINE 查詢失敗:", (_e as Error).message);
    }
  }

  return { orders: [], source: "unknown", found: false };
}

export async function unifiedLookupByProductAndPhone(
  slConfig: SuperLandingConfig,
  matchedPages: { pageId: string; productName: string }[],
  phone: string,
  brandId?: number
): Promise<UnifiedOrderResult> {
  if (slConfig.merchantNo && slConfig.accessKey && matchedPages.length > 0) {
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
  }

  const shoplineConfig = getShoplineConfig(brandId);
  if (shoplineConfig) {
    try {
      const orders = await lookupShoplineOrdersByPhone(shoplineConfig, phone);
      if (orders.length > 0) {
        orders.forEach(o => { o.source = "shopline"; });
        return { orders, source: "shopline", found: true };
      }
    } catch (_e) {
      console.log("[UnifiedOrder] SHOPLINE 手機查詢失敗:", (_e as Error).message);
    }
  }

  return { orders: [], source: "unknown", found: false };
}

export async function unifiedLookupByDateAndContact(
  slConfig: SuperLandingConfig,
  contact: string,
  beginDate: string,
  endDate: string,
  pageId?: string,
  brandId?: number
): Promise<UnifiedOrderResult> {
  if (slConfig.merchantNo && slConfig.accessKey) {
    try {
      const result = await lookupOrdersByDateAndFilter(slConfig, contact, beginDate, endDate, pageId);
      if (result.orders.length > 0) {
        result.orders.forEach(o => { o.source = "superlanding"; });
        return { orders: result.orders, source: "superlanding", found: true };
      }
    } catch (_e) {
      console.log("[UnifiedOrder] SuperLanding 日期查詢失敗:", (_e as Error).message);
    }
  }

  const shoplineConfig = getShoplineConfig(brandId);
  if (shoplineConfig) {
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
  }

  return { orders: [], source: "unknown", found: false };
}

export function getUnifiedStatusLabel(status: string, source?: string): string {
  if (source === "shopline") {
    return getShoplineStatusLabel(status);
  }
  return getStatusLabel(status);
}
