/**
 * 統一付款狀態判斷（單一真相）：先判 COD，再判 success / failed / pending。
 * 避免到收／取件時付款被誤判成付款失敗。
 */
import type { OrderInfo } from "@shared/schema";

const COD_METHOD_REGEX =
  /貨到付款|到收|取件時付款|取貨付款|到店付款|cash_on_delivery|cash\s*on\s*delivery|cod|現金\s*與\s*刷卡/i;

/** 一頁商店：payment_method=pending + 超商/門市/to_store + prepaid=false + paid_at=null → 視為 COD（不可單憑 pending 判失敗） */
function isSuperLandingCvsCod(order: OrderInfo): boolean {
  if ((order.source || "") !== "superlanding") return false;
  const pm = (order.payment_method || "").trim().toLowerCase();
  if (pm !== "pending") return false;
  const toStore =
    (order.shipping_method || "").toLowerCase().includes("to_store") ||
    (order.delivery_target_type || "") === "cvs" ||
    /超商|門市|取貨|to_store/i.test(order.shipping_method || "");
  if (!toStore) return false;
  if (order.prepaid === true) return false;
  if (order.paid_at != null && order.paid_at !== "") return false;
  return true;
}

/**
 * 是否為貨到付款／到收／取件時付款。
 * 涵蓋明確字串與一頁商店超商 pending 特例。
 */
export function isCodPaymentMethod(order: OrderInfo): boolean {
  if (COD_METHOD_REGEX.test(order.payment_method || "")) return true;
  if (/^到收$|^取件時付款$/i.test((order.payment_method || "").trim())) return true;
  if (isSuperLandingCvsCod(order)) return true;
  return false;
}

const PAYMENT_FAIL_STATUS_KW = ["失敗", "未成功", "付款失敗"];
const PAYMENT_FAIL_METHOD_KW = ["失敗", "未付"];
const PAYMENT_SUCCESS_STATUS_KW = ["已確認", "待出貨", "出貨中", "已出貨", "已完成", "處理中"];
const PAYMENT_PENDING_STATUS_KW = ["待付款", "未付款", "確認中", "新訂單", "待處理"];
const REQUIRES_PREPAY_METHOD = /credit_card|linepay|line_pay|line pay|apple_pay|google_pay|jkopay|街口/i;
const DEFERRED_PAY_METHOD = /virtual_account|atm|ibon|超商|轉帳|匯款|bank|繳費/i;

export type PaymentKind = "success" | "failed" | "pending" | "cod" | "unknown";

export function derivePaymentStatus(
  order: OrderInfo,
  statusLabel: string,
  source: string
): { kind: PaymentKind; label: string; reason?: string; confidence?: "high" | "medium" | "low" } {
  if (isCodPaymentMethod(order)) {
    return {
      kind: "cod",
      label: "貨到付款（到收／取件時付款）",
      reason: "cod",
      confidence: "high",
    };
  }
  const pm = (order.payment_method || "").trim();
  let kind: PaymentKind = "unknown";
  let reason = "";
  const payRaw = ((order as { payment_status_raw?: string }).payment_status_raw || "").toLowerCase();
  if (source === "shopline" && payRaw) {
    if (/paid|complete|success|captured|authorized/.test(payRaw)) {
      kind = "success";
      reason = "shopline_pay_raw_paid";
    } else if (/pending|unpaid|awaiting|processing/.test(payRaw)) {
      kind = "pending";
      reason = "shopline_pay_raw_pending";
    } else if (/fail|void|cancel|refund/.test(payRaw)) {
      kind = "failed";
      reason = "shopline_pay_raw_fail";
    }
  }
  /** Phase 33 Ticket 33-6：一頁商店 LINE Pay / 卡類，若有明確失敗 raw 或狀態字，勿當 pending */
  if (kind === "unknown" && source === "superlanding" && payRaw) {
    if (/fail|failed|reject|declin|void|cancel|error|unsuccess/.test(payRaw)) {
      kind = "failed";
      reason = "superlanding_pay_raw_fail";
    }
  }
  if (kind === "unknown") {
    if (PAYMENT_FAIL_STATUS_KW.some((k) => statusLabel.includes(k))) {
      kind = "failed";
      reason = "status_fail_kw";
    } else if (/已取消|作廢|退單|void|cancelled|canceled/i.test(statusLabel)) {
      kind = "failed";
      reason = "status_cancelled";
    } else if (order.prepaid === true || order.paid_at) {
      kind = "success";
      reason = "prepaid_or_paid_at";
    } else if (PAYMENT_SUCCESS_STATUS_KW.some((k) => statusLabel.includes(k)) && order.prepaid !== false) {
      kind = "success";
      reason = "status_implies_paid";
    } else if (
      source === "superlanding" &&
      REQUIRES_PREPAY_METHOD.test(pm) &&
      order.prepaid === false &&
      order.paid_at == null &&
      (/失敗|未成功|付款失敗|失敗單|未付款成功|紅叉/i.test(statusLabel) ||
        /failed|fail|reject|declin|void|cancel|error|unsuccess/i.test(String(order.status || "")))
    ) {
      kind = "failed";
      reason = "superlanding_linepay_card_fail_signal";
    } else if (PAYMENT_SUCCESS_STATUS_KW.some((k) => statusLabel.includes(k)) && order.prepaid === false && REQUIRES_PREPAY_METHOD.test(pm)) {
      kind = "pending";
      reason = "status_ship_flow_but_prepay_unclear";
    } else if (PAYMENT_PENDING_STATUS_KW.some((k) => statusLabel.includes(k))) {
      kind = "pending";
      reason = "status_pending_kw";
    } else if (DEFERRED_PAY_METHOD.test(pm) && !order.paid_at) {
      kind = "pending";
      reason = "deferred_payment_awaiting";
    } else if (REQUIRES_PREPAY_METHOD.test(pm) && order.prepaid === false && !order.paid_at) {
      kind = "pending";
      reason = "card_like_unpaid_not_failed";
    } else if (
      order.prepaid === false &&
      order.paid_at == null &&
      PAYMENT_FAIL_METHOD_KW.some((k) => pm.includes(k))
    ) {
      kind = "failed";
      reason = "explicit_fail_in_method";
    } else if (PAYMENT_SUCCESS_STATUS_KW.some((k) => statusLabel.includes(k))) {
      kind = "success";
      reason = "status_success_fallback";
    } else {
      kind = "unknown";
      reason = "ambiguous_no_fail_assumption";
    }
  }
  const labels: Record<PaymentKind, string> = {
    success: "付款成功",
    failed: "付款失敗",
    pending: "待付款或待確認",
    cod: "貨到付款（到收／取件時付款）",
    unknown: "付款狀態未明",
  };
  const confidence: "high" | "medium" | "low" =
    reason.includes("shopline_pay_raw") || reason === "cod" || reason === "prepaid_or_paid_at"
      ? "high"
      : kind === "unknown"
        ? "low"
        : "medium";
  return { kind, label: labels[kind], reason, confidence };
}
