/**
 * Fast Path 已停用（Rescue）：查單與對話一律交第一輪 LLM + Tool。
 * 仍匯出混合句訂單號解析，供其他模組使用。
 * 訂單追問關鍵字與 policy / ai-reply 共用 `ORDER_FOLLOWUP_PATTERNS`（見 conversation-state-resolver）。
 */
import { ORDER_FOLLOWUP_PATTERNS } from "./conversation-state-resolver";
import type { SuperLandingConfig } from "./superlanding";
import type { IStorage } from "./storage";

export { ORDER_FOLLOWUP_PATTERNS };

/** 混合句內的 15～22 位純數字（官網單號） */
export function extractLongNumericOrderIdFromMixedSentence(msg: string): string | null {
  if (!msg) return null;
  const m = msg.match(/(?<!\d)\d{15,22}(?!\d)/);
  return m ? m[0] : null;
}

/** 混合句內訂單號，例如「可以幫我查 AQX13705 嗎」 */
export function extractOrderIdFromMixedSentence(msg: string): string | null {
  const re = /[A-Za-z][A-Za-z0-9\-]{4,13}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(msg)) !== null) {
    const u = m[0].toUpperCase();
    if (/^09\d/.test(u)) continue;
    if (u.length >= 5 && u.length <= 14) return u;
  }
  return null;
}

export type OrderFastPathType =
  | "order_id"
  | "order_id_mixed"
  | "phone"
  | "shopline_phone"
  | "superlanding_phone"
  | "ask_for_identifier"
  | "order_followup"
  | null;

export async function tryOrderFastPath(params: {
  userMessage: string;
  brandId: number | undefined;
  contactId: number;
  slConfig: SuperLandingConfig;
  storage: IStorage;
  planMode: string;
  recentUserMessages: string[];
}): Promise<{ reply: string; fastPathType: OrderFastPathType } | null> {
  void params;
  return null;
}
