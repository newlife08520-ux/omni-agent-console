/**
 * Phase 2.5：多筆訂單 deterministic 回傳與 active context（phone / product+phone API / date / more_orders 共用）
 */
import type { OrderInfo, ActiveOrderContext } from "@shared/schema";
import type { IStorage } from "./storage";
import { getUnifiedStatusLabel } from "./order-service";
import { payKindForOrder } from "./order-reply-utils";
import { buildActiveOrderContextFromOrder } from "./order-active-context";
import { orderDeterministicContractFields } from "./deterministic-order-contract";

export function packDeterministicMultiOrderToolResult(params: {
  orders: OrderInfo[];
  orderSource: string;
  headerLine: string;
  contactId: number | undefined;
  storage: IStorage;
  matchedBy: ActiveOrderContext["matched_by"];
  renderer: string;
}): Record<string, unknown> {
  const { orders, orderSource, headerLine, contactId, storage, matchedBy, renderer } = params;
  const sorted = [...orders].sort((a, b) =>
    String(b.order_created_at || b.created_at || "").localeCompare(String(a.order_created_at || a.created_at || ""))
  );
  const n = sorted.length;
  const ch =
    orderSource === "shopline" ? "官網" : orderSource === "superlanding" ? "一頁商店" : "多來源";
  const orderSummaries = sorted.map((o) => {
    const src = o.source || orderSource;
    const st = getUnifiedStatusLabel(o.status, src);
    const { kind, label } = payKindForOrder(o, st, src);
    return {
      order_id: o.global_order_id,
      status: st,
      amount: o.final_total_order_amount,
      product_list: o.product_list,
      buyer_name: o.buyer_name,
      buyer_phone: o.buyer_phone,
      source: src,
      payment_status: kind,
      payment_status_label: label,
      created_at: o.created_at,
    };
  });
  const succ = orderSummaries.filter((x) => x.payment_status === "success").length;
  const fail = orderSummaries.filter((x) => x.payment_status === "failed").length;
  const pend = orderSummaries.filter((x) => x.payment_status === "pending").length;
  const codn = orderSummaries.filter((x) => x.payment_status === "cod").length;
  const partsAgg: string[] = [];
  if (succ) partsAgg.push(`${succ} 筆付款成功`);
  if (fail) partsAgg.push(`${fail} 筆未成立／失敗`);
  if (pend) partsAgg.push(`${pend} 筆待付款／待確認`);
  if (codn) partsAgg.push(`${codn} 筆貨到付款`);
  const aggStr = partsAgg.length ? partsAgg.join("、") : "詳見下列";
  const top3 = sorted.slice(0, 3);
  const lines = top3.map((o, i) => {
    const src = o.source || orderSource;
    const st = getUnifiedStatusLabel(o.status, src);
    const { label } = payKindForOrder(o, st, src);
    const tag = src === "shopline" ? "[官網]" : src === "superlanding" ? "[一頁]" : "";
    return `${i + 1}. ${tag}${o.global_order_id}｜${o.created_at || o.order_created_at || ""}｜${label}｜${st}`;
  });
  const deterministicReply =
    `${headerLine}（${ch}）共 ${n} 筆。${aggStr}。\n` +
    lines.join("\n") +
    (n > 3 ? `\n（另有 ${n - 3} 筆，說「全部訂單」可列出）` : "") +
    `\n要看哪一筆請回覆訂單編號，或說「最新那筆」「只看成功的」等。`;
  const o0 = sorted[0];
  const status0 = getUnifiedStatusLabel(o0.status, o0.source || orderSource);
  const candidates = sorted.map((o) => {
    const src = o.source || orderSource;
    const st = getUnifiedStatusLabel(o.status, src);
    const { kind, label } = payKindForOrder(o, st, src);
    return {
      order_id: o.global_order_id,
      payment_status: kind as "success" | "failed" | "pending" | "cod" | "unknown",
      payment_status_label: label,
      fulfillment_status: st,
      order_time: o.created_at || o.order_created_at,
      source: (src === "shopline" || src === "superlanding" ? src : undefined) as
        | "shopline"
        | "superlanding"
        | undefined,
    };
  });
  const successful_order_ids = candidates.filter((c) => c.payment_status === "success").map((c) => c.order_id);
  const failed_order_ids = candidates.filter((c) => c.payment_status === "failed").map((c) => c.order_id);
  const pending_order_ids = candidates.filter((c) => c.payment_status === "pending").map((c) => c.order_id);
  const cod_order_ids = candidates.filter((c) => c.payment_status === "cod").map((c) => c.order_id);

  if (contactId) {
    storage.setActiveOrderContext(contactId, {
      ...buildActiveOrderContextFromOrder(o0, o0.source || orderSource, status0, deterministicReply, matchedBy),
      candidate_count: n,
      active_order_candidates: candidates,
      selected_order_id: null,
      last_lookup_source: orderSource,
      aggregate_payment_summary: aggStr,
      one_page_summary: deterministicReply,
      candidate_source_summary: ch,
      successful_order_ids,
      failed_order_ids,
      pending_order_ids,
      cod_order_ids,
      selected_order_rank: null,
    });
  }

  return {
    success: true,
    found: true,
    total: n,
    source: orderSource,
    orders: orderSummaries,
    deterministic_skip_llm: false,
    ...orderDeterministicContractFields(),
    renderer,
    note: `查單結果 n=${n}；請依 orders 與人格產生對客回覆（勿直接複製系統內部標籤）。`,
    formatted_list: orderSummaries.map((o) => `- **${o.order_id}** | ${o.payment_status_label}`).join("\n"),
  };
}
