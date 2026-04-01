/**
 * Phase 3.0 / 90：出貨 SOP 事後合規（Post-Generation），非整段 Deterministic 回覆。
 * Phase 90：前綴改為真人語感敘述，降低「補丁感」，仍保證道歉＋工作天＋不加壓確切日＋催促加急。
 */
import { shouldInjectShippingSopForToolContext } from "./tool-llm-sanitize";

/** Phase 96：更口語、降低「模板拼接」感；仍含道歉＋雙時程＋不保證到貨日＋可催物流 */
export const SHIPPING_SOP_COMPLIANCE_PREFIX =
  "真的不好意思讓您久等了～這邊跟您說明一下：若是現貨，我們大約五個工作天內會幫您安排寄出；若是預購，一般會落在七到二十個工作天左右（依檔期與商品而異）。確切到貨日沒辦法替物流保證，但我會幫您留意，需要的話也會請這邊向物流端催一下。\n\n關於您剛剛提到的：";

const APOLOGY_HINT = /抱歉|不好意思|久候|久等|讓您等/;
/** 已用口語交代出貨時程或物流承諾時，視為自然合規，降低 Guard 出手率（Phase 96） */
const NATURAL_SHIPPING_SUBSTANCE_HINT =
  /工作天|天內|安排|7[-～－]\s*20|七\s*到\s*二十|五\s*個|預購|現貨|寄出|出貨|物流|配送|倉儲|加急|催促|盯|進度|催/;

/** Phase 97：致歉＋盡快處理／安排／寄出（仍鼓勵模型補齊工作天數，由主 prompt 與 SOP 小抄拉齊） */
function hasApologyPlusExpeditedHandling(text: string): boolean {
  if (!APOLOGY_HINT.test(text)) return false;
  if (!/盡快/.test(text)) return false;
  return /處理|安排|寄出|出貨|配送/.test(text);
}

/** Phase 97：願意幫客人向物流端催促（即使未先致歉，仍視為有物流行動承諾；極短無義句除外） */
function hasLogisticsFollowThrough(text: string): boolean {
  if (!/物流|配送|出貨|寄件/.test(text)) return false;
  if (!/催|催促|盯|進度|幫您|幫你|我會/.test(text)) return false;
  return text.length >= 8;
}

/**
 * @param intent 保留擴充用；目前以 planMode + user/recent 語意為主。
 */
export function ensureShippingSopCompliance(
  reply: string,
  planMode: string,
  _intent: string,
  userMessage?: string,
  recentUserMessages?: string[]
): string {
  if (planMode !== "order_followup") return reply;
  if (!shouldInjectShippingSopForToolContext(userMessage, recentUserMessages)) return reply;
  const text = (reply || "").trim();
  if (!text) return reply;
  if (text.startsWith(SHIPPING_SOP_COMPLIANCE_PREFIX)) return reply;
  if (APOLOGY_HINT.test(text) && NATURAL_SHIPPING_SUBSTANCE_HINT.test(text)) return reply;
  if (hasApologyPlusExpeditedHandling(text)) return reply;
  if (hasLogisticsFollowThrough(text)) return reply;
  console.warn("[SOP_GUARD_TRIGGERED] LLM 漏講出貨 SOP，Guard 介入兜底。");
  return SHIPPING_SOP_COMPLIANCE_PREFIX + reply;
}
