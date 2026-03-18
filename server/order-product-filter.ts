/**
 * Shopline／本地 商品名 + 手機：依商品關鍵字過濾訂單（避免同手機整包回傳）
 */
import type { OrderInfo } from "@shared/schema";
import db from "./db";
import { normalizeProductName } from "./order-index";

export function normalizeProductQueryForMatch(s: string): string {
  try {
    return normalizeProductName(String(s || "").normalize("NFKC"));
  } catch {
    return normalizeProductName(s || "");
  }
}

/** 從訂單取出可比對的商品文字（items_structured、product_list JSON） */
export function orderProductMatchBlob(o: OrderInfo): string {
  const chunks: string[] = [];
  for (const raw of [o.items_structured, o.product_list]) {
    if (!raw || typeof raw !== "string") continue;
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        for (const it of arr) {
          const n = String((it as { name?: string; title?: string; product_name?: string }).name ?? (it as { title?: string }).title ?? (it as { product_name?: string }).product_name ?? "");
          if (n) chunks.push(n);
        }
      }
    } catch {
      if (raw.length < 600) chunks.push(raw);
    }
  }
  return normalizeProductQueryForMatch(chunks.join(""));
}

function expandQueryWithAliases(brandId: number | undefined, query: string): Set<string> {
  const out = new Set<string>();
  const qn = normalizeProductQueryForMatch(query);
  if (qn.length >= 1) out.add(qn);
  const tokens = query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  for (const t of tokens) out.add(normalizeProductQueryForMatch(t));

  if (!brandId) return out;
  try {
    const rows = db
      .prepare(
        `SELECT canonical_name, alias, COALESCE(alias_normalized, '') as alias_normalized FROM product_aliases WHERE brand_id = ?`
      )
      .all(brandId) as { canonical_name: string; alias: string; alias_normalized: string }[];
    for (const r of rows) {
      const an = (r.alias_normalized || "").trim() || normalizeProductName(r.alias);
      const cn = normalizeProductQueryForMatch(r.canonical_name);
      if (an.length < 2 && cn.length < 2) continue;
      const hit =
        (qn.length >= 2 && (qn.includes(an) || an.includes(qn))) ||
        tokens.some((t) => {
          const tn = normalizeProductQueryForMatch(t);
          return tn.length >= 2 && (tn.includes(an) || an.includes(tn));
        });
      if (hit) {
        if (cn.length >= 2) out.add(cn);
        if (an.length >= 2) out.add(an);
      }
    }
  } catch {
    /* no db in some tests */
  }
  return out;
}

export function orderMatchesProductQuery(order: OrderInfo, query: string, brandId?: number): boolean {
  const q = (query || "").trim();
  if (q.length < 2) return true;
  const blob = orderProductMatchBlob(order);
  if (!blob) return false;
  const variants = expandQueryWithAliases(brandId, q);
  for (const v of variants) {
    if (v.length >= 2 && blob.includes(v)) return true;
  }
  return false;
}

export function filterOrdersByProductQuery(orders: OrderInfo[], query: string, brandId?: number): OrderInfo[] {
  const q = (query || "").trim();
  if (q.length < 2) return [...orders];
  return orders.filter((o) => orderMatchesProductQuery(o, q, brandId));
}
