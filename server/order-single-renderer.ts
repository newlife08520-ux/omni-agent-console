import { orderDeterministicContractFields } from "./deterministic-order-contract";

/**
 * 單筆查單 deterministic 欄位（與 multi packer 契約一致）。
 */
export function packDeterministicSingleOrderToolResult(params: {
  renderer: string;
  one_page_summary: string;
  source?: string;
}): Record<string, unknown> {
  return {
    deterministic_skip_llm: false,
    renderer: params.renderer,
    one_page_summary: params.one_page_summary,
    ...orderDeterministicContractFields(),
    ...(params.source ? { source: params.source } : {}),
  };
}

export function buildSingleOrderCustomerReply(prefix: string, onePageSummary: string): string {
  const p = (prefix || "").trim();
  const s = (onePageSummary || "").trim();
  if (!p) return s;
  return `${p}\n${s}`.trim();
}
