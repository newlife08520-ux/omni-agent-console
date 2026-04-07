/**
 * ActiveOrderContext 建構（供 tool / fast path 共用）
 * 付款狀態一律走 derivePaymentStatus，不可把 COD 存成 failed。
 */
import type { ActiveOrderContext, OrderInfo } from "@shared/schema";
import { derivePaymentStatus } from "./order-payment-utils";

const FULFILLMENT_SHIPPED_KW = ["已出貨", "已送達"];
const FULFILLMENT_PENDING_SHIP_KW = ["新訂單", "待出貨", "處理中"];
const FULFILLMENT_CANCELED_KW = ["已取消"];
const FULFILLMENT_PROCESSING_KW = ["已確認", "待出貨", "出貨中"];
const FULFILLMENT_NEW_KW = ["新訂單"];

export function buildActiveOrderContextFromOrder(
  order: OrderInfo,
  source: string,
  statusLabel: string,
  onePageSummary: string,
  matchedBy: "image" | "text" | "product_phone" | "manual"
): ActiveOrderContext {
  const now = new Date().toISOString().replace("T", " ").substring(0, 19);
  const payment = derivePaymentStatus(order, statusLabel, source);
  const payment_status: ActiveOrderContext["payment_status"] = payment.kind;
  let fulfillment_status = statusLabel;
  if (FULFILLMENT_SHIPPED_KW.some((k) => statusLabel.includes(k))) fulfillment_status = "已出貨";
  else if (FULFILLMENT_PENDING_SHIP_KW.some((k) => statusLabel.includes(k))) fulfillment_status = "待出貨";
  else if (FULFILLMENT_CANCELED_KW.some((k) => statusLabel.includes(k))) fulfillment_status = "已取消";
  else if (FULFILLMENT_PROCESSING_KW.some((k) => statusLabel.includes(k))) fulfillment_status = "處理中";
  else if (FULFILLMENT_NEW_KW.some((k) => statusLabel.includes(k))) fulfillment_status = "新訂單";
  else if (payment_status === "failed") fulfillment_status = "付款失敗";
  else if (payment_status === "pending") fulfillment_status = "待付款";
  /* COD 不覆蓋為待付款/付款失敗，維持訂單真實狀態（新訂單、待出貨等） */
  const addressOrStore =
    order.delivery_target_type === "cvs"
      ? [order.cvs_brand, order.cvs_store_name, order.full_address].filter(Boolean).join(" ") || order.address
      : order.delivery_target_type === "home"
        ? order.full_address || order.address
        : order.full_address || order.address;
  return {
    order_id: order.global_order_id,
    matched_by: matchedBy,
    matched_confidence: "high",
    last_fetched_at: now,
    payment_status,
    payment_method: order.payment_method,
    fulfillment_status,
    shipping_method: order.shipping_method,
    tracking_no: order.tracking_number,
    receiver_name: order.buyer_name,
    receiver_phone: order.buyer_phone,
    address_or_store: addressOrStore || order.address,
    items: order.product_list,
    order_time: order.created_at || order.order_created_at,
    one_page_summary: onePageSummary,
    source: order.source || (source as ActiveOrderContext["source"]),
    page_id: order.page_id,
    page_title: order.page_title,
    delivery_target_type: order.delivery_target_type,
    cvs_brand: order.cvs_brand,
    cvs_store_code: order.cvs_store_code,
    cvs_store_name: order.cvs_store_name,
    full_address: order.full_address,
    address_raw: order.address_raw,
    source_channel_hint: order.source === "superlanding" ? "superlanding" : order.source === "shopline" ? "shopline" : undefined,
  };
}

/**
 * R1：local_only 單筆僅「候選」— 不寫入完整收件／地址／追蹤，避免後續追問讀起來像已鎖定真相。
 * 付款狀態仍走 derivePaymentStatus，供 COD／失敗等話術一致。
 */
export function buildProvisionalLocalOnlyActiveContextFromOrder(
  order: OrderInfo,
  source: string,
  statusLabel: string,
  candidateSummaryForAi: string,
  matchedBy: ActiveOrderContext["matched_by"]
): ActiveOrderContext {
  const now = new Date().toISOString().replace("T", " ").substring(0, 19);
  const payment = derivePaymentStatus(order, statusLabel, source);
  return {
    order_id: order.global_order_id,
    matched_by: matchedBy,
    matched_confidence: "low",
    last_fetched_at: now,
    payment_status: payment.kind,
    payment_method: order.payment_method,
    fulfillment_status: undefined,
    shipping_method: undefined,
    tracking_no: undefined,
    receiver_name: undefined,
    receiver_phone: undefined,
    address_or_store: undefined,
    items: undefined,
    order_time: order.created_at || order.order_created_at,
    one_page_summary: candidateSummaryForAi,
    source: order.source || (source as ActiveOrderContext["source"]),
    page_id: order.page_id,
    page_title: order.page_title,
    delivery_target_type: undefined,
    cvs_brand: undefined,
    cvs_store_code: undefined,
    cvs_store_name: undefined,
    full_address: undefined,
    address_raw: undefined,
    source_channel_hint: order.source === "superlanding" ? "superlanding" : order.source === "shopline" ? "shopline" : undefined,
    lookup_provisional: true,
  };
}
