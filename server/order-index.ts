/**
 * Phase 2 / 2.3：本地訂單索引、source-aware 查詢、明細寫入、商品+手機本地查詢。
 */
import db from "./db";
import type { OrderInfo } from "@shared/schema";

const DEFAULT_CACHE_TTL_SECONDS = 300;

export type OrderIndexSourceHint = "superlanding" | "shopline" | "any";

/** 與 order-service.UnifiedOrderResult 結構一致 */
export interface CachedOrderResult {
  orders: OrderInfo[];
  source: "superlanding" | "shopline" | "unknown";
  found: boolean;
  crossBrand?: boolean;
  crossBrandName?: string;
}

export function normalizePhone(phone: string): string {
  return (phone || "").replace(/\D/g, "");
}

export function normalizeProductName(s: string): string {
  return (s || "").replace(/\s/g, "").toLowerCase();
}

export function cacheKeyOrderId(brandId: number, idNorm: string, scope: "superlanding" | "shopline" | "any"): string {
  return `order_id:${brandId}:${scope}:${idNorm}`;
}

export function cacheKeyPhone(brandId: number, phoneNorm: string, scope: "superlanding" | "shopline" | "any"): string {
  return `phone:${brandId}:${scope}:${phoneNorm}`;
}

function parseRow(row: { payload: string; source: string }): OrderInfo | null {
  try {
    const order = JSON.parse(row.payload) as OrderInfo;
    order.source = row.source as OrderInfo["source"];
    return order;
  } catch {
    return null;
  }
}

/** 依訂單編號從本地索引取一筆；any 時優先 shopline 再 superlanding（同號極少雙邊皆有） */
export function getOrderByOrderId(
  brandId: number,
  orderId: string,
  sourceHint: OrderIndexSourceHint = "any"
): OrderInfo | null {
  const id = (orderId || "").trim().toUpperCase();
  if (!id) return null;
  if (sourceHint === "superlanding" || sourceHint === "shopline") {
    const row = db
      .prepare(
        "SELECT payload, source FROM orders_normalized WHERE brand_id = ? AND global_order_id = ? AND source = ? LIMIT 1"
      )
      .get(brandId, id, sourceHint) as { payload: string; source: string } | undefined;
    return row?.payload ? parseRow(row) : null;
  }
  const rowSl = db
    .prepare(
      "SELECT payload, source FROM orders_normalized WHERE brand_id = ? AND global_order_id = ? AND source = 'shopline' LIMIT 1"
    )
    .get(brandId, id) as { payload: string; source: string } | undefined;
  if (rowSl?.payload) return parseRow(rowSl);
  const rowSl2 = db
    .prepare(
      "SELECT payload, source FROM orders_normalized WHERE brand_id = ? AND global_order_id = ? AND source = 'superlanding' LIMIT 1"
    )
    .get(brandId, id) as { payload: string; source: string } | undefined;
  return rowSl2?.payload ? parseRow(rowSl2) : null;
}

/** 依正規化手機從本地索引取多筆 */
export function getOrdersByPhone(
  brandId: number,
  phone: string,
  sourceHint: OrderIndexSourceHint = "any"
): OrderInfo[] {
  const norm = normalizePhone(phone);
  if (!norm) return [];
  let rows: { payload: string; source: string }[];
  if (sourceHint === "any") {
    rows = db
      .prepare(
        `SELECT payload, source FROM orders_normalized
         WHERE brand_id = ? AND buyer_phone_normalized = ?
         ORDER BY datetime(COALESCE(NULLIF(trim(order_created_at),''), created_at)) DESC, datetime(synced_at) DESC`
      )
      .all(brandId, norm) as { payload: string; source: string }[];
  } else {
    rows = db
      .prepare(
        `SELECT payload, source FROM orders_normalized
         WHERE brand_id = ? AND buyer_phone_normalized = ? AND source = ?
         ORDER BY datetime(COALESCE(NULLIF(trim(order_created_at),''), created_at)) DESC, datetime(synced_at) DESC`
      )
      .all(brandId, norm, sourceHint) as { payload: string; source: string }[];
  }
  const seen = new Set<string>();
  const out: OrderInfo[] = [];
  for (const row of rows) {
    const o = parseRow(row);
    if (!o) continue;
    const k = `${row.source}:${(o.global_order_id || "").toUpperCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(o);
  }
  return out;
}

/** 合併雙來源本地手機訂單（去重、時間排序） */
export function getOrdersByPhoneMerged(brandId: number, phone: string): OrderInfo[] {
  const sl = getOrdersByPhone(brandId, phone, "superlanding");
  const sh = getOrdersByPhone(brandId, phone, "shopline");
  const map = new Map<string, OrderInfo>();
  for (const o of [...sh, ...sl]) {
    const src = o.source || "superlanding";
    const k = `${src}:${(o.global_order_id || "").toUpperCase()}`;
    if (!map.has(k)) map.set(k, o);
  }
  const t = (o: OrderInfo) => String(o.order_created_at || o.created_at || "").trim();
  return [...map.values()].sort((a, b) => t(b).localeCompare(t(a)));
}

export interface OrderItemRow {
  product_name: string | null;
  sku: string | null;
  quantity: number;
  price_cents: number | null;
  product_name_normalized: string | null;
}

function extractItemsFromOrder(order: OrderInfo, source: "superlanding" | "shopline"): OrderItemRow[] {
  const out: OrderItemRow[] = [];
  const push = (name: string, sku: string, qty: number, price: number) => {
    const pn = name?.trim() || "";
    if (!pn && !sku) return;
    const priceCents = Number.isFinite(price) && price > 0 && price < 1e9 ? Math.round(Number(price) * 100) : null;
    out.push({
      product_name: pn || null,
      sku: sku?.trim() || null,
      quantity: Math.max(1, qty || 1),
      price_cents: priceCents,
      product_name_normalized: pn ? normalizeProductName(pn) : null,
    });
  };
  try {
    const raw = order.product_list || "";
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      for (const it of parsed) {
        const name = String(it.name ?? it.title ?? it.product_name ?? "");
        const sku = String(it.code ?? it.sku ?? it.product_id ?? "");
        const qty = Number(it.qty ?? it.quantity ?? 1) || 1;
        const price = Number(it.price ?? it.sale_price ?? 0) || 0;
        push(name, sku, qty, price);
      }
    }
  } catch {
    if (order.product_list && typeof order.product_list === "string" && order.product_list.length < 500) {
      push(order.product_list, "", 1, 0);
    }
  }
  if (out.length === 0 && source === "shopline") {
    try {
      const structured = order.items_structured ? JSON.parse(order.items_structured) : null;
      if (Array.isArray(structured)) {
        for (const it of structured) {
          push(String(it.name ?? it.title ?? ""), String(it.code ?? it.sku ?? ""), Number(it.qty ?? 1) || 1, Number(it.price ?? 0) || 0);
        }
      }
    } catch {
      /* skip */
    }
  }
  return out;
}

export function getOrderLookupCache(cacheKey: string): CachedOrderResult | null {
  const row = db
    .prepare("SELECT result_payload, fetched_at, ttl_seconds FROM order_lookup_cache WHERE cache_key = ?")
    .get(cacheKey) as { result_payload: string; fetched_at: string; ttl_seconds: number } | undefined;
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

export function setOrderLookupCache(
  cacheKey: string,
  result: CachedOrderResult,
  ttlSeconds: number = DEFAULT_CACHE_TTL_SECONDS
): void {
  db.prepare(
    `
    INSERT INTO order_lookup_cache (cache_key, result_payload, fetched_at, ttl_seconds)
    VALUES (?, ?, datetime('now'), ?)
    ON CONFLICT(cache_key) DO UPDATE SET result_payload = excluded.result_payload, fetched_at = excluded.fetched_at, ttl_seconds = excluded.ttl_seconds
  `
  ).run(cacheKey, JSON.stringify(result), ttlSeconds);
}

export function upsertOrderNormalized(
  brandId: number,
  source: "superlanding" | "shopline",
  order: OrderInfo
): void {
  const phoneNorm = normalizePhone(order.buyer_phone || "");
  const globalId = (order.global_order_id || "").trim().toUpperCase();
  const payload = JSON.stringify(order);
  const now = new Date().toISOString().replace("T", " ").substring(0, 19);
  const orderCreatedAt = String(order.order_created_at || order.created_at || "").trim() || null;
  db.prepare(
    `
    INSERT INTO orders_normalized (brand_id, source, global_order_id, buyer_phone_normalized, page_id, status, payload, synced_at, created_at, order_created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(brand_id, source, global_order_id) DO UPDATE SET
      buyer_phone_normalized = excluded.buyer_phone_normalized,
      page_id = excluded.page_id,
      status = excluded.status,
      payload = excluded.payload,
      synced_at = excluded.synced_at,
      order_created_at = CASE
        WHEN excluded.order_created_at IS NOT NULL AND trim(excluded.order_created_at) != '' THEN excluded.order_created_at
        ELSE orders_normalized.order_created_at
      END
  `
  ).run(
    brandId,
    source,
    globalId,
    phoneNorm || "unknown",
    order.page_id ?? null,
    order.status ?? null,
    payload,
    now,
    now,
    orderCreatedAt
  );
  const row = db
    .prepare("SELECT id FROM orders_normalized WHERE brand_id = ? AND source = ? AND global_order_id = ?")
    .get(brandId, source, globalId) as { id: number } | undefined;
  if (!row?.id) return;
  const oid = row.id;
  db.prepare("DELETE FROM order_items_normalized WHERE order_normalized_id = ?").run(oid);
  const items = extractItemsFromOrder(order, source);
  const ins = db.prepare(
    `INSERT INTO order_items_normalized (order_normalized_id, product_name, sku, quantity, price_cents, product_name_normalized)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const it of items) {
    ins.run(oid, it.product_name, it.sku, it.quantity, it.price_cents, it.product_name_normalized);
  }
}

/**
 * 本地：手機 + 商品關鍵字（明細 normalized LIKE + 別名表）
 */
export function lookupOrdersByProductAliasAndPhoneLocal(
  brandId: number,
  phone: string,
  productQuery: string
): OrderInfo[] {
  const norm = normalizePhone(phone);
  const q = normalizeProductName(productQuery);
  if (!norm || q.length < 1) return [];
  const like = `%${q}%`;
  const rows = db
    .prepare(
      `
    SELECT DISTINCT o.payload, o.source
    FROM orders_normalized o
    WHERE o.brand_id = ? AND o.buyer_phone_normalized = ?
      AND (
        EXISTS (
          SELECT 1 FROM order_items_normalized i
          WHERE i.order_normalized_id = o.id AND i.product_name_normalized IS NOT NULL AND i.product_name_normalized LIKE ?
        )
        OR (o.page_id IS NOT NULL AND o.page_id != '' AND o.page_id IN (
          SELECT pa.page_id FROM product_aliases pa
          WHERE pa.brand_id = o.brand_id
            AND (pa.alias_normalized LIKE ? OR replace(lower(pa.alias), ' ', '') LIKE ?)
        ))
      )
    ORDER BY datetime(COALESCE(NULLIF(trim(o.order_created_at),''), o.created_at)) DESC
  `
    )
    .all(brandId, norm, like, like, like) as { payload: string; source: string }[];
  const seen = new Set<string>();
  const out: OrderInfo[] = [];
  for (const row of rows) {
    const o = parseRow(row);
    if (!o) continue;
    const k = `${row.source}:${(o.global_order_id || "").toUpperCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(o);
  }
  return out;
}

export function getOrderIndexStats(brandId?: number): {
  orders_count: number;
  items_count: number;
  aliases_count: number;
  by_source: { superlanding: number; shopline: number };
  order_created_at_missing_count: number;
  order_created_at_min: string | null;
  order_created_at_max: string | null;
} {
  const orders_count = (
    brandId != null
      ? (db.prepare("SELECT COUNT(*) as c FROM orders_normalized WHERE brand_id = ?").get(brandId) as { c: number })
      : (db.prepare("SELECT COUNT(*) as c FROM orders_normalized").get() as { c: number })
  ).c;
  const items_count = (
    brandId != null
      ? (db
          .prepare(
            `SELECT COUNT(*) as c FROM order_items_normalized i
             INNER JOIN orders_normalized o ON o.id = i.order_normalized_id WHERE o.brand_id = ?`
          )
          .get(brandId) as { c: number })
      : (db.prepare("SELECT COUNT(*) as c FROM order_items_normalized").get() as { c: number })
  ).c;
  const aliases_count = (
    brandId != null
      ? (db.prepare("SELECT COUNT(*) as c FROM product_aliases WHERE brand_id = ?").get(brandId) as { c: number })
      : (db.prepare("SELECT COUNT(*) as c FROM product_aliases").get() as { c: number })
  ).c;
  const sl =
    brandId != null
      ? (db
          .prepare(
            "SELECT COUNT(*) as c FROM orders_normalized WHERE brand_id = ? AND source = 'superlanding'"
          )
          .get(brandId) as { c: number }).c
      : (db.prepare("SELECT COUNT(*) as c FROM orders_normalized WHERE source = 'superlanding'").get() as { c: number }).c;
  const sh =
    brandId != null
      ? (db
          .prepare("SELECT COUNT(*) as c FROM orders_normalized WHERE brand_id = ? AND source = 'shopline'")
          .get(brandId) as { c: number }).c
      : (db.prepare("SELECT COUNT(*) as c FROM orders_normalized WHERE source = 'shopline'").get() as { c: number }).c;
  let order_created_at_null = 0;
  let order_created_at_min: string | null = null;
  let order_created_at_max: string | null = null;
  try {
    order_created_at_null = (
      brandId != null
        ? (db
            .prepare(
              `SELECT COUNT(*) as c FROM orders_normalized WHERE brand_id = ? AND (order_created_at IS NULL OR trim(order_created_at) = '')`
            )
            .get(brandId) as { c: number })
        : (db
            .prepare(`SELECT COUNT(*) as c FROM orders_normalized WHERE order_created_at IS NULL OR trim(order_created_at) = ''`)
            .get() as { c: number })
    ).c;
    const mm = (
      brandId != null
        ? db
            .prepare(
              `SELECT MIN(order_created_at) as mn, MAX(order_created_at) as mx FROM orders_normalized WHERE brand_id = ? AND order_created_at IS NOT NULL AND trim(order_created_at) != ''`
            )
            .get(brandId)
        : db
            .prepare(
              `SELECT MIN(order_created_at) as mn, MAX(order_created_at) as mx FROM orders_normalized WHERE order_created_at IS NOT NULL AND trim(order_created_at) != ''`
            )
            .get()
    ) as { mn: string | null; mx: string | null };
    order_created_at_min = mm?.mn ?? null;
    order_created_at_max = mm?.mx ?? null;
  } catch {
    /* column may be missing before migration */
  }
  return {
    orders_count,
    items_count,
    aliases_count,
    by_source: { superlanding: sl, shopline: sh },
    order_created_at_missing_count: order_created_at_null,
    order_created_at_min,
    order_created_at_max,
  };
}
