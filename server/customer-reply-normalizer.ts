/**
 * Rescue：Normalizer 已停用（passthrough），對客語氣交還 LLM；不再用 Regex 剝除問候／emoji／安撫詞。
 */
export type NormalizerMode = "order_lookup" | "order_followup" | "general";

export interface NormalizeCustomerFacingOptions {
  mode: NormalizerMode;
  replySource: string;
  renderer?: string;
  platform?: string;
  softHumanize?: boolean;
}

export interface NormalizeCustomerFacingResult {
  text: string;
  changed: boolean;
  rulesHit: string[];
}

export function normalizeCustomerFacingOrderReply(
  raw: string,
  _opts: NormalizeCustomerFacingOptions
): NormalizeCustomerFacingResult {
  return { text: raw, changed: false, rulesHit: [] };
}
