/**
 * Phase 2：本地訂單索引與查單快取。
 * - 先查 orders_normalized / order_lookup_cache，命中則直接回傳。
 * - 未命中再走既有 API，並可寫回 cache 與 sync 表。
 */
import db from "./db";
import type { OrderInfo } from "@shared/schema";

const DEFAULT_CACHE_TTL_SECONDS = 300;

/** 與 order-service.UnifiedOrderResult 結構一致，避免循環依賴 */
export interface CachedOrderResult {
  orders: OrderInfo[];
  source: "superlanding" | "shopline" | "unknown";
  found: boolean;
  crossBrand?: boolean;
  crossBrandName?: string;
}

/** 將手機號碼正規化為僅數字（供比對與存儲） */
export function normalizePhone(phone: string): string {
  return (phone || "").replace(/\D/g, "");
}

/** 依訂單編號從本地索引取一筆（僅限單一 brand） */
export function getOrderByOrderId(brandId: number, orderId: string): OrderInfo | null {
  const id = (orderId || "").trim().toUpperCase();
  if (!id) return null;
  const row = db.prepare(
    "SELECT payload, source FROM orders_normalized WHERE brand_id = ? AND global_order_id = ? LIMIT 1"
  ).get(brandId, id) as { payload: string; source: string } | undefined;
  if (!row?.payload) return null;
  try {
    const order = JSON.parse(row.payload) as OrderInfo;
    order.source = row.source as OrderInfo["source"];
    return order;
  } catch {
    return null;
  }
}

/** 依正規化手機從本地索引取多筆（僅限單一 brand） */
export function getOrdersByPhone(brandId: number, phone: string): OrderInfo[] {
  const norm = normalizePhone(phone);
  if (!norm) return [];
  const rows = db.prepare(
    "SELECT payload, source FROM orders_normalized WHERE brand_id = ? AND buyer_phone_normalized = ? ORDER BY synced_at DESC"
  ).all(brandId, norm) as { payload: string; source: string }[];
  const out: OrderInfo[] = [];
  for (const row of rows) {
    try {
      const order = JSON.parse(row.payload) as OrderInfo;
      order.source = row.source as OrderInfo["source"];
      out.push(order);
    } catch { /* skip */ }
  }
  return out;
}

/** 查單快取：取得並檢查 TTL，過期則視為未命中 */
export function getOrderLookupCache(cacheKey: string): CachedOrderResult | null {
  const row = db.prepare(
    "SELECT result_payload, fetched_at, ttl_seconds FROM order_lookup_cache WHERE cache_key = ?"
  ).get(cacheKey) as { result_payload: string; fetched_at: string; ttl_seconds: number } | undefined;
  if (!row?.result_payload) return null;
  const fetched = new Date(row.fetched_at).getTime();
  const ttl = (row.ttl_seconds || DEFAULT_CACHE_TTL_SECONDS) * 1000;
  if (Date.now() - fetched > ttl) return null;
  try {
    return JSON.parse(row.result_payload) as CachedOrderResult;
  } catch {
    return null;
  }
}

/** 寫入查單快取 */
export function setOrderLookupCache(cacheKey: string, result: CachedOrderResult, ttlSeconds: number = DEFAULT_CACHE_TTL_SECONDS): void {
  db.prepare(`
    INSERT INTO order_lookup_cache (cache_key, result_payload, fetched_at, ttl_seconds)
    VALUES (?, ?, datetime('now'), ?)
    ON CONFLICT(cache_key) DO UPDATE SET result_payload = excluded.result_payload, fetched_at = excluded.fetched_at, ttl_seconds = excluded.ttl_seconds
  `).run(cacheKey, JSON.stringify(result), ttlSeconds);
}

/** 寫入或更新一筆正規化訂單（供 sync 使用） */
export function upsertOrderNormalized(
  brandId: number,
  source: "superlanding" | "shopline",
  order: OrderInfo
): void {
  const phoneNorm = normalizePhone(order.buyer_phone || "");
  const globalId = (order.global_order_id || "").trim().toUpperCase();
  const payload = JSON.stringify(order);
  const now = new Date().toISOString().replace("T", " ").substring(0, 19);
  db.prepare(`
    INSERT INTO orders_normalized (brand_id, source, global_order_id, buyer_phone_normalized, page_id, status, payload, synced_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(brand_id, source, global_order_id) DO UPDATE SET
      buyer_phone_normalized = excluded.buyer_phone_normalized,
      page_id = excluded.page_id,
      status = excluded.status,
      payload = excluded.payload,
      synced_at = excluded.synced_at
  `).run(
    brandId,
    source,
    globalId,
    phoneNorm || "unknown",
    order.page_id ?? null,
    order.status ?? null,
    payload,
    now,
    now
  );
}
