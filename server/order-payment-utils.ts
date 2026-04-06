/**
 * 統一付款狀態判斷：COD → paid_at/prepaid → 訂單狀態已取消 → 失敗訊號（含中文／payment_status_raw／gateway_status）→ 其餘 pending。
 * 對客標籤關鍵字：紅叉、訂單未成立、授權失敗 等 — 見 derivePaymentStatus / hasExplicitPaymentFailureSignal。
 */
import type { OrderInfo } from "@shared/schema";

/** Shopline 常見：payment_type cash_on_delivery、中文「貨到付款／到收」、超商取貨付款、黑貓宅配代收等 */
const COD_METHOD_REGEX =
  /貨到付款|到收|取件時付款|取件時付|取貨付款|取貨時付款|取貨時付|到店付款|超商取貨付(?:款)?|便利商店取貨付(?:款)?|宅配代收|宅配.*貨到付款|黑貓.*(?:代收|貨到付款)|宅急便.*(?:代收|貨到付款)|7[\s\-／/]*11[\s、，,]*取貨付(?:款)?|全家[\s、，,]*取貨付(?:款)?|cash_on_delivery|cash\s*on\s*delivery|payment\s*on\s*delivery|\bcod\b|tw_711_b2c_pay|tw_fami_b2c_pay|tw_hilife_b2c_pay|tw_ok_b2c_pay|b2c_pay|home_delivery_cod|t_cat.*cod|現金\s*與\s*刷卡/i;

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

export function isCodPaymentMethod(order: OrderInfo): boolean {
  if (COD_METHOD_REGEX.test(order.payment_method || "")) return true;
  if (/^到收$|^取件時付款$|^取件時付$/i.test((order.payment_method || "").trim())) return true;
  if (isSuperLandingCvsCod(order)) return true;
  if (COD_METHOD_REGEX.test(String(order.shipping_method || ""))) return true;
  return false;
}

/** 中文與常見網關錯誤樣式（不比對整段 order.status，避免與「已取消」狀態列重複時序問題） */
function hasZhOrGatewayFailureFragment(payRaw: string, gatewayRaw: string): boolean {
  const orig = `${payRaw} ${gatewayRaw}`;
  if (
    /失敗|取消|拒絕|異常|授權失敗|紅叉|未成立|交易失敗|付款失敗|作廢|退刷|刷卡不成功|銀行拒絕|付款逾時|款項未到|請重新付款/i.test(
      orig
    )
  )
    return true;
  if (/\b(?:E\d{3,6}|ERR[_-]?\d+|NG\d+|DECLINE|DECLINED)\b/i.test(orig)) return true;
  return false;
}

/**
 * 亞洲／台灣常見網關與 3D／超時等隱性失敗字樣（Phase 90：QA 指定 Regex 全字面值納入）。
 * 修飾符 i 使 3d驗證失敗 可匹配「3D驗證失敗」；void／reject 依規格不加重邊界（英文欄位需留意 avoid 等誤觸）。
 */
const ASIA_GATEWAY_FAILURE_HINT =
  /授權失敗|拒絕交易|餘額不足|連線異常|未付款失效|逾期未繳|付款異常|訂單取消|expired|timeout|3d驗證失敗|3d\s*secure|do\s*not\s*honor|insufficient\s*funds|order\s*cancelled|void|reject/i;

/** 僅在 API 原生 payment / gateway 字串中比對明確失敗語意 */
function hasExplicitPaymentFailureSignal(payRaw: string, gatewayRaw: string): boolean {
  const combined = `${payRaw} ${gatewayRaw}`;
  if (ASIA_GATEWAY_FAILURE_HINT.test(combined)) return true;
  if (hasZhOrGatewayFailureFragment(payRaw, gatewayRaw)) return true;
  const hay = `${payRaw} ${gatewayRaw}`.toLowerCase();
  const needles = [
    "void",
    "cancel",
    "cancelled",
    "canceled",
    "declined",
    "decline",
    "rejected",
    "reject",
    "refunded",
    "refund",
    "chargeback",
    "failed",
    "failure",
    "error",
  ];
  for (const t of needles) {
    let from = 0;
    while (from < hay.length) {
      const i = hay.indexOf(t, from);
      if (i < 0) break;
      const before = i > 0 ? hay[i - 1] : " ";
      const after = i + t.length < hay.length ? hay[i + t.length] : " ";
      const atBoundary = !/[a-z0-9_]/.test(before) && !/[a-z0-9_]/.test(after);
      if (atBoundary) return true;
      from = i + 1;
    }
  }
  return false;
}

export type PaymentKind = "success" | "failed" | "pending" | "cod" | "unknown";

/** Phase 3.0：fallback pending 時對客顯示 */
export const PENDING_FALLBACK_CUSTOMER_LABEL = "未付款";

export function derivePaymentStatus(
  order: OrderInfo,
  _statusLabel: string,
  _source: string
): { kind: PaymentKind; label: string; reason?: string; confidence?: "high" | "medium" | "low" } {
  if (isCodPaymentMethod(order)) {
    return {
      kind: "cod",
      label: "貨到付款",
      reason: "cod",
      confidence: "high",
    };
  }

  const prepaidOk = order.prepaid === true;
  const paidAtOk = order.paid_at != null && String(order.paid_at).trim() !== "";
  if (prepaidOk || paidAtOk) {
    return {
      kind: "success",
      label: "已付款",
      reason: prepaidOk ? "prepaid" : "paid_at",
      confidence: "high",
    };
  }

  const statusLine = `${order.status || ""} ${_statusLabel || ""}`;
  if (/已取消|訂單已取消|取消訂單/.test(statusLine)) {
    return {
      kind: "failed",
      label: "付款失敗",
      reason: "order_status_cancelled_zh",
      confidence: "high",
    };
  }

  const payRaw = String(order.payment_status_raw || "");
  const gatewayRaw = String((order as { gateway_status?: string }).gateway_status || "");

  if (hasExplicitPaymentFailureSignal(payRaw, gatewayRaw)) {
    return {
      kind: "failed",
      label: "付款失敗",
      reason: "native_payment_or_gateway_signal",
      confidence: "high",
    };
  }

  const orderNo = String((order as { global_order_id?: string }).global_order_id || "").trim() || "(no_id)";
  console.warn(
    "[LIVE_PAYMENT_FALLBACK_PENDING] 缺乏明確狀態，退回 pending。訂單號: " +
      orderNo +
      " | Raw Pay: " +
      payRaw +
      " | Gateway: " +
      gatewayRaw
  );

  return {
    kind: "pending",
    label: PENDING_FALLBACK_CUSTOMER_LABEL,
    reason: "fallback_pending",
    confidence: "medium",
  };
}
