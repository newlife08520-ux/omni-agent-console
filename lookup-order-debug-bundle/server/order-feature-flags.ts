/**
 * Soft launch / rollback：環境變數，預設皆開（與 Phase 2.6 行為一致）。
 * 設為 0 / false 可關閉對應路徑。
 */
function envBool(key: string, defaultTrue: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === "") return defaultTrue;
  const low = v.toLowerCase().trim();
  if (low === "0" || low === "false" || low === "no" || low === "off") return false;
  if (low === "1" || low === "true" || low === "yes" || low === "on") return true;
  return defaultTrue;
}

export const orderFeatureFlags = {
  /** P0 Minimal Safe Mode：預設關閉，還權 LLM；需舊行為時設對應 ENABLE_*=1 */
  orderFastPath: envBool("ENABLE_ORDER_FAST_PATH", false),
  orderFinalNormalizer: envBool("ENABLE_ORDER_FINAL_NORMALIZER", false),
  genericDeterministicOrder: envBool("ENABLE_GENERIC_DETERMINISTIC_ORDER", false),
  orderUltraLitePrompt: envBool("ENABLE_ORDER_ULTRA_LITE_PROMPT", false),
  orderLatencyV2: envBool("ENABLE_ORDER_LATENCY_V2", true),
  /** Phase 30：為 true 時，若資料為 local_only（僅本地索引），不單筆定案，改回帶說明讓 LLM 補問或補查 */
  conservativeSingleOrder: envBool("CONSERVATIVE_SINGLE_ORDER", true),
  /**
   * Quick Ack：LLM 回覆前先送一則確認（全情境；查單工具輪若已送過則不重複）。
   * 關閉時設 ENABLE_ORDER_LOOKUP_ACK=0。
   */
  orderLookupAck: envBool("ENABLE_ORDER_LOOKUP_ACK", true),
} as const;
