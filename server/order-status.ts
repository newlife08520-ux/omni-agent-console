// Phase 106.9：訂單狀態三層分類（lookup_order_by_id 是否打 live）
// 老闆確認：英式 cancelled 屬「未知」→ 須打 live；美式 canceled 為終態

/** 🟢 終態：信任 local index，不打 live */
export const TERMINAL_ORDER_STATUSES = new Set([
  "shipped",
  "shipping",
  "canceled",
  "returned",
  "refunded",
]);

/** 🟡 準終態：信任 local index */
export const PRE_TERMINAL_ORDER_STATUSES = new Set([
  "awaiting_for_shipment",
  "confirmed",
  "replacement",
  "delay_handling",
]);

/** 🔴 早期態：必須打 live 確認最新 */
export const EARLY_ORDER_STATUSES = new Set([
  "new_order",
  "pending",
  "confirming",
  "refunding",
]);

export type OrderStatusClass = "terminal" | "pre_terminal" | "early" | "unknown";

export function classifyOrderStatus(status: string | null | undefined): OrderStatusClass {
  if (!status) return "unknown";
  const normalized = status.toLowerCase().trim();
  if (TERMINAL_ORDER_STATUSES.has(normalized)) return "terminal";
  if (PRE_TERMINAL_ORDER_STATUSES.has(normalized)) return "pre_terminal";
  if (EARLY_ORDER_STATUSES.has(normalized)) return "early";
  return "unknown";
}

/** unknown／早期態 → 打 live */
export function shouldRefreshFromLive(status: string | null | undefined): boolean {
  const cls = classifyOrderStatus(status);
  return cls === "early" || cls === "unknown";
}
