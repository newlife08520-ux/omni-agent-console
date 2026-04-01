/**
 * Phase 2 輸出常數與 output guard，供 routes 與 phase2-verify 共用，確保文案驗收與實際送出一致。
 */

/** Phase 2 off_topic_guard：品牌外問題短句收邊界；不得推薦菜單／餐廳 */
export const OFF_TOPIC_GUARD_MESSAGE =
  "這部分比較不是我們服務範圍～若有商品或訂單相關問題，可以跟我說，我幫您處理😊";

/**
 * Handoff 強制告知句（程式層保證）：只要進入轉接真人流程，回覆第一句必須明確告知「已轉接真人專員」。
 * 語意等價：「這邊先幫您轉接真人專員處理，請稍後。」／「我先為您轉接真人專員協助處理，麻煩您稍候一下。」
 */
export const HANDOFF_MANDATORY_OPENING = "這邊先幫您轉接真人專員處理，請稍後。";

/** Handoff 時僅在「明確查單且缺關鍵資料」時可補一句（Hotfix：handoff ≠ order_lookup） */
export const HANDOFF_OPTIONAL_ORDER_HINT = "若方便，也可先提供訂單編號，專員會更快協助您確認。";

/** 轉人工時若為午休／下班／非客服時段，程式層硬規則：必須在回覆中明確告知客戶（不依賴 prompt） */
export const HANDOFF_OFF_HOURS_SUFFIX = "目前人工客服不在線，之後才會由真人客服回覆。";

/** 全員忙碌／暫停時也需告知客戶，避免誤以為有人正在看 */
export const HANDOFF_ALL_PAUSED_SUFFIX = "目前客服暫時無法即時回覆，您的需求已記錄，會盡快由專人處理。";

/** 週休二日：專屬文案，避免週末被誤判為午休或全員忙碌 */
export const HANDOFF_WEEKEND_SUFFIX = "目前為假日非服務時間，您的需求已記錄，我們將於下個工作日為您處理，請稍候。";

/**
 * 依是否為非客服時段，回傳要送給客戶的完整 handoff 文案（程式層硬規則）。
 * 週末：加「目前為假日非服務時間…下個工作日為您處理。」
 * 午休或下班時：加「目前人工客服不在線，之後才會由真人客服回覆。」
 * 全員忙碌／暫停時：加「目前客服暫時無法即時回覆…」
 */
export function getHandoffReplyForCustomer(
  baseReply: string,
  unavailableReason: "weekend" | "lunch" | "after_hours" | "all_paused" | null
): string {
  if (unavailableReason === "weekend") {
    return baseReply + "\n" + HANDOFF_WEEKEND_SUFFIX;
  }
  if (unavailableReason === "lunch" || unavailableReason === "after_hours") {
    return baseReply + "\n" + HANDOFF_OFF_HOURS_SUFFIX;
  }
  if (unavailableReason === "all_paused") {
    return baseReply + "\n" + HANDOFF_ALL_PAUSED_SUFFIX;
  }
  return baseReply;
}

/**
 * 組裝 handoff 回覆：第一句必為固定告知句。
 * 第二句（訂單提示）僅當：已明確是查單/訂單處理、且真的缺關鍵資料、且非情緒差。
 * 純「人呢」「我要轉人工」等不得補訂單提示。
 */
export function buildHandoffReply(options: {
  customerEmotion?: string;
  humanReason?: string | null;
  /** 同一句或本輪是否明確提到查單/訂單/出貨；僅此時才允許補訂單提示 */
  isOrderLookupContext?: boolean;
  /** 是否已有訂單編號或產品名稱+手機；有則不補訂單提示 */
  hasOrderInfo?: boolean;
}): string {
  const { customerEmotion, humanReason, isOrderLookupContext, hasOrderInfo } = options;
  const emotionOnly = (customerEmotion === "angry" || customerEmotion === "high_risk" || customerEmotion === "frustrated");
  if (emotionOnly) return HANDOFF_MANDATORY_OPENING;
  const mayAddHint = humanReason === "explicit_human_request" && isOrderLookupContext === true && hasOrderInfo !== true;
  if (mayAddHint) {
    return HANDOFF_MANDATORY_OPENING + "\n" + HANDOFF_OPTIONAL_ORDER_HINT;
  }
  return HANDOFF_MANDATORY_OPENING;
}

/** order_lookup 回覆上限（字） */
export const OUTPUT_GUARD_MAX_CHARS = 140;
/** 其餘 mode 回覆上限（字） */
export const OUTPUT_GUARD_MAX_CHARS_RELAXED = 200;

/**
 * Phase 2 output guard：首輪回覆長度上限；超標時截斷至最後一句完整句或字數上限＋「…」。
 */
export function enforceOutputGuard(text: string, _planMode: string): string {
  /** Minimal Safe Mode：不再截斷語氣與長度，交給單一 system prompt。 */
  return (text || "").trim();
}
