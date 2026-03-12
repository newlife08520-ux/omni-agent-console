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

/** Handoff 時最多補一句（僅在非情緒差時）：可選提供訂單編號以利專人更快處理 */
export const HANDOFF_OPTIONAL_ORDER_HINT = "若方便可先提供訂單編號，專員會更快協助您確認。";

/**
 * 組裝 handoff 回覆：第一句必為固定告知句；情緒差時只保留第一句，否則最多補一句訂單提示。
 * @param customerEmotion - 來自 ConversationState.customer_emotion
 * @param humanReason - 來自 ConversationState.human_reason；explicit_human_request 時可補訂單提示
 */
export function buildHandoffReply(options: {
  customerEmotion?: string;
  humanReason?: string | null;
}): string {
  const { customerEmotion, humanReason } = options;
  const emotionOnly = (customerEmotion === "angry" || customerEmotion === "high_risk" || customerEmotion === "frustrated");
  if (emotionOnly) return HANDOFF_MANDATORY_OPENING;
  if (humanReason === "explicit_human_request") {
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
export function enforceOutputGuard(text: string, planMode: string): string {
  const trimmed = (text || "").trim();
  if (!trimmed) return trimmed;
  const maxLen = planMode === "order_lookup" ? OUTPUT_GUARD_MAX_CHARS : OUTPUT_GUARD_MAX_CHARS_RELAXED;
  if (trimmed.length <= maxLen) return trimmed;
  const cut = trimmed.slice(0, maxLen);
  const lastPeriod = Math.max(
    cut.lastIndexOf("。"),
    cut.lastIndexOf("！"),
    cut.lastIndexOf("？"),
    cut.lastIndexOf("\n")
  );
  if (lastPeriod > maxLen * 0.5) return cut.slice(0, lastPeriod + 1).trim();
  return cut.trim() + "…";
}
