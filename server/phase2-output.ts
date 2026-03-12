/**
 * Phase 2 輸出常數與 output guard，供 routes 與 phase2-verify 共用，確保文案驗收與實際送出一致。
 */

/** Phase 2 off_topic_guard：品牌外問題短句收邊界；不得推薦菜單／餐廳 */
export const OFF_TOPIC_GUARD_MESSAGE =
  "這部分比較不是我們服務範圍～若有商品或訂單相關問題，可以跟我說，我幫您處理😊";

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
