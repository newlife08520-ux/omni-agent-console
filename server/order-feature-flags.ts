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
  orderFastPath: envBool("ENABLE_ORDER_FAST_PATH", true),
  orderFinalNormalizer: envBool("ENABLE_ORDER_FINAL_NORMALIZER", true),
  genericDeterministicOrder: envBool("ENABLE_GENERIC_DETERMINISTIC_ORDER", true),
  orderUltraLitePrompt: envBool("ENABLE_ORDER_ULTRA_LITE_PROMPT", true),
  orderLatencyV2: envBool("ENABLE_ORDER_LATENCY_V2", true),
} as const;
