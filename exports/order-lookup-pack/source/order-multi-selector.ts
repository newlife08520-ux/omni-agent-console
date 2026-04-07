/**
 * Phase 2.4：多筆訂單 deterministic 選擇（排序、日期、來源篩選）
 */
import type { ActiveOrderContext } from "@shared/schema";

export type OrderCandidate = NonNullable<ActiveOrderContext["active_order_candidates"]>[number];

export function sortCandidatesNewestFirst(cands: OrderCandidate[]): OrderCandidate[] {
  return [...cands].sort((a, b) =>
    String(b.order_time || "").localeCompare(String(a.order_time || ""))
  );
}

export function pickLatestCandidate(cands: OrderCandidate[]): OrderCandidate | undefined {
  return sortCandidatesNewestFirst(cands)[0];
}

export function pickEarliestCandidate(cands: OrderCandidate[]): OrderCandidate | undefined {
  const s = sortCandidatesNewestFirst(cands);
  return s[s.length - 1];
}

/** 從使用者句中抓日期，對應 order_time 字串 */
export function pickCandidateByOrderDate(cands: OrderCandidate[], userMsg: string): OrderCandidate | null {
  const mx = userMsg.match(/(\d{4})\D{0,2}(\d{1,2})\D{0,2}(\d{1,2})/);
  if (!mx) return null;
  const y = mx[1];
  const mo = mx[2].padStart(2, "0");
  const day = mx[3].padStart(2, "0");
  const iso = `${y}-${mo}-${day}`;
  for (const c of cands) {
    const t = (c.order_time || "").replace(/\//g, "-").slice(0, 16);
    if (t.includes(iso) || t.startsWith(`${y}-${mx[2]}-${mx[3]}`)) return c;
  }
  return null;
}

export function filterCandidatesBySource(
  cands: OrderCandidate[],
  source: "shopline" | "superlanding"
): OrderCandidate[] {
  return cands.filter((c) => c.source === source);
}
