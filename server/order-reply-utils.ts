/**
 * 訂單回覆格式與付款狀態（供 fast path / tool 共用，避免 routes 循環依賴）
 */
import type { OrderInfo } from "@shared/schema";

const CVS_SHIPPING_KEYWORDS = ["超商", "門市", "7-11", "7-ELEVEN", "全家", "OK", "萊爾富"];
const PAYMENT_FAIL_STATUS_KW = ["失敗", "未成功", "付款失敗"];
const PAYMENT_FAIL_METHOD_KW = ["失敗", "未付"];
const PAYMENT_SUCCESS_STATUS_KW = ["已確認", "待出貨", "已出貨", "已完成"];
const PAYMENT_PENDING_STATUS_KW = ["待付款", "未付款", "確認中", "新訂單"];

export type PayKind = "success" | "failed" | "pending" | "cod" | "unknown";

export function payKindForOrder(order: OrderInfo, statusLabel: string, source: string): { kind: PayKind; label: string } {
  if (/貨到付款|取貨付款|到店付款|COD|現金\s*與\s*刷卡/i.test(order.payment_method || "")) {
    return { kind: "cod", label: "貨到付款" };
  }
  let k: PayKind = "unknown";
  const payRaw = (order.payment_status_raw || "").toLowerCase();
  if (source === "shopline" && payRaw) {
    if (/paid|complete|success|captured|authorized/.test(payRaw)) k = "success";
    else if (/pending|unpaid|awaiting|processing/.test(payRaw)) k = "pending";
    else if (/fail|void|cancel|refund/.test(payRaw)) k = "failed";
  }
  if (k === "unknown") {
    if (
      PAYMENT_FAIL_STATUS_KW.some((x) => statusLabel.includes(x)) ||
      (order.prepaid === false &&
        order.paid_at == null &&
        !PAYMENT_FAIL_METHOD_KW.some((x) => (order.payment_method || "").includes(x)))
    )
      k = "failed";
    else if (order.prepaid === true || order.paid_at || PAYMENT_SUCCESS_STATUS_KW.some((x) => statusLabel.includes(x)))
      k = "success";
    else if (PAYMENT_PENDING_STATUS_KW.some((x) => statusLabel.includes(x))) k = "pending";
  }
  const labels: Record<PayKind, string> = {
    success: "付款成功",
    failed: "付款失敗",
    pending: "待付款",
    cod: "貨到付款",
    unknown: "付款狀態未明",
  };
  return { kind: k, label: labels[k] };
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
