/**
 * 訂單回覆格式與付款狀態（供 fast path / tool 共用）
 * 付款狀態一律走 derivePaymentStatus，COD 顯示「貨到付款（到收／取件時付款）」。
 */
import type { OrderInfo, ActiveOrderContext } from "@shared/schema";
import { derivePaymentStatus, type PaymentKind } from "./order-payment-utils";

const CVS_SHIPPING_KEYWORDS = ["超商", "門市", "7-11", "7-ELEVEN", "全家", "OK", "萊爾富"];

export type PayKind = PaymentKind;

export function payKindForOrder(order: OrderInfo, statusLabel: string, source: string): { kind: PayKind; label: string } {
  const p = derivePaymentStatus(order, statusLabel, source);
  return { kind: p.kind, label: p.label };
}

export function formatOrderOnePage(o: {
  order_id?: string;
  buyer_name?: string;
  buyer_phone?: string;
  created_at?: string;
  payment_method?: string;
  payment_status_label?: string;
  amount?: number;
  shipping_method?: string;
  tracking_number?: string;
  address?: string;
  product_list?: string;
  status?: string;
  shipped_at?: string;
  delivery_target_type?: string;
  cvs_brand?: string;
  cvs_store_name?: string;
  full_address?: string;
  source_channel?: string;
}): string {
  const lines: string[] = [];
  if (o.order_id) lines.push(`訂單編號：${o.order_id}`);
  if (o.source_channel) lines.push(`來源：${o.source_channel}`);
  if (o.buyer_name) lines.push(`收件人：${o.buyer_name}`);
  if (o.buyer_phone) lines.push(`電話：${o.buyer_phone}`);
  if (o.created_at) lines.push(`下單時間：${o.created_at}`);
  lines.push(`付款方式：${(o.payment_method || "").trim() || "（此筆訂單系統未回傳）"}`);
  if (o.payment_status_label) lines.push(`付款狀態：${o.payment_status_label}`);
  if (o.amount != null) lines.push(`金額：$${Number(o.amount).toLocaleString()}`);
  lines.push(`配送方式：${(o.shipping_method || "").trim() || "（此筆訂單系統未回傳）"}`);
  if (o.tracking_number) lines.push(`物流單號：${o.tracking_number}`);
  const isCvs =
    o.delivery_target_type === "cvs" ||
    (o.delivery_target_type !== "home" &&
      CVS_SHIPPING_KEYWORDS.some((k) => (o.shipping_method || "").toLowerCase().includes(k.toLowerCase())));
  const addressDisplay = isCvs
    ? [o.cvs_brand, o.cvs_store_name, o.full_address].filter(Boolean).join(" ") || o.address
    : o.full_address || o.address;
  if (addressDisplay) lines.push(isCvs ? `門市／地址：${addressDisplay}` : `地址：${addressDisplay}`);
  if (o.product_list) lines.push(`商品明細：${o.product_list}`);
  if (o.status) lines.push(`狀態：${o.status}`);
  if (o.shipped_at) lines.push(`出貨時間：${o.shipped_at}`);
  return lines.join("\n");
}

export function sourceChannelLabel(src: string | undefined): string {
  if (src === "shopline") return "官網（SHOPLINE）";
  if (src === "superlanding") return "一頁商店";
  return "訂單";
}

/** Phase 2.4：deterministic 模板禁用句型（verify 掃描） */
export const PHASE24_BANNED_DETERMINISTIC_PHRASES = [
  "真的很抱歉讓您久等了",
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

/** Active order 追問：先結論、少套話；COD 不誤導付款失敗 */
export function buildDeterministicFollowUpReply(ctx: ActiveOrderContext): string | null {
  if (!ctx?.order_id) return null;
  const parts: string[] = [`訂單 ${ctx.order_id}`];
  if (ctx.payment_status && ctx.payment_status !== "unknown") {
    const paymentText =
      ctx.payment_status === "cod"
        ? "貨到付款（到收／取件時付款），不是線上付款失敗"
        : ctx.payment_status === "success"
          ? "已付款"
          : ctx.payment_status === "failed"
            ? "這筆線上付款未完成，需重新下單或洽客服"
            : "付款尚在確認或待付";
    parts.push(paymentText);
  }
  if (ctx.fulfillment_status) parts.push(`狀態：${ctx.fulfillment_status}`);
  if (ctx.delivery_target_type === "cvs") {
    const storeBits = [ctx.cvs_brand, ctx.cvs_store_name].filter(Boolean).join(" ").trim();
    const addr = (ctx.full_address || "").trim();
    if (storeBits || addr) {
      parts.push(
        storeBits
          ? `取貨：${storeBits}${addr ? `，${addr}` : ""}`
          : `取貨地址：${addr}`
      );
    }
  } else if (ctx.full_address?.trim() || ctx.address_or_store?.trim()) {
    parts.push(`寄送：${(ctx.full_address || ctx.address_or_store || "").trim()}`);
  }
  if (ctx.tracking_no?.trim()) {
    parts.push(`物流單號 ${ctx.tracking_no.trim()}，可到物流公司網站查進度`);
  } else if (ctx.shipping_method?.trim() && ctx.delivery_target_type !== "cvs") {
    parts.push(`配送：${ctx.shipping_method.trim()}`);
  }
  return parts.length > 1 ? parts.join("；") + "。" : null;
}
