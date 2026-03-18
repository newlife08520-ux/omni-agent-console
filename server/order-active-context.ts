/**
 * ActiveOrderContext 建構（供 tool / fast path 共用）
 */
import type { ActiveOrderContext, OrderInfo } from "@shared/schema";

const PAYMENT_FAIL_STATUS_KW = ["失敗", "未成功", "付款失敗"];
const PAYMENT_FAIL_METHOD_KW = ["失敗", "未付"];
const PAYMENT_SUCCESS_STATUS_KW = ["已確認", "待出貨", "已出貨", "已完成"];
const PAYMENT_PENDING_STATUS_KW = ["待付款", "未付款", "確認中", "新訂單"];
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
  let payment_status: ActiveOrderContext["payment_status"] = "unknown";
  const payRaw = ((order as { payment_status_raw?: string }).payment_status_raw || "").toLowerCase();
  if (source === "shopline" && payRaw) {
    if (/paid|complete|success|captured|authorized/.test(payRaw)) payment_status = "success";
    else if (/pending|unpaid|awaiting|processing/.test(payRaw)) payment_status = "pending";
    else if (/fail|void|cancel|refund/.test(payRaw)) payment_status = "failed";
  }
  if (payment_status === "unknown") {
    if (
      PAYMENT_FAIL_STATUS_KW.some((k) => statusLabel.includes(k)) ||
      (order.prepaid === false &&
        order.paid_at == null &&
        !PAYMENT_FAIL_METHOD_KW.some((k) => (order.payment_method || "").includes(k)))
    )
      payment_status = "failed";
    else if (order.prepaid === true || order.paid_at || PAYMENT_SUCCESS_STATUS_KW.some((k) => statusLabel.includes(k)))
      payment_status = "success";
    else if (PAYMENT_PENDING_STATUS_KW.some((k) => statusLabel.includes(k))) payment_status = "pending";
  }
  let fulfillment_status = statusLabel;
  if (FULFILLMENT_SHIPPED_KW.some((k) => statusLabel.includes(k))) fulfillment_status = "已出貨";
  else if (FULFILLMENT_PENDING_SHIP_KW.some((k) => statusLabel.includes(k))) fulfillment_status = "待出貨";
  else if (FULFILLMENT_CANCELED_KW.some((k) => statusLabel.includes(k))) fulfillment_status = "已取消";
  else if (FULFILLMENT_PROCESSING_KW.some((k) => statusLabel.includes(k))) fulfillment_status = "處理中";
  else if (FULFILLMENT_NEW_KW.some((k) => statusLabel.includes(k))) fulfillment_status = "新訂單";
  else if (payment_status === "failed") fulfillment_status = "付款失敗";
  else if (payment_status === "pending") fulfillment_status = "待付款";
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
