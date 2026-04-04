/**
 * Hybrid Router：硬規則優先（Phase 1.5 收斂），必要時 LLM fallback，失敗則 legacy 對照 plan/state。
 */
import OpenAI from "openai";
import type { ReplyPlanMode } from "../reply-plan-builder";
import type { HybridRouteResult, AgentScenario } from "./phase1-types";
import { resolveOpenAIRouterModel } from "../openai-model";
import { classifyOrderNumber } from "../intent-and-order";
import { extractOrderIdFromMixedSentence, extractLongNumericOrderIdFromMixedSentence } from "../order-fast-path";

export interface HybridRouterInput {
  userMessage: string;
  recentUserTexts: string[];
  planMode: ReplyPlanMode | string;
  primaryIntent: string;
  issueType: string | null | undefined;
  apiKey: string | null;
  /** 若已由呼叫端計算硬規則，避免重複；未傳則內部重算 */
  preComputedHard?: HybridRouteResult | null;
  /**
   * 測試／本機取證：若設定（含空字串試解析）則不呼叫真實 OpenAI，改解析此 JSON 字串。
   * production 勿傳。
   */
  mockLlmRawResponse?: string | null;
}

const TAIWAN_MOBILE = /09\d{8}/;
const LOGISTICS_KW =
  /物流|出貨|配送|貨態|黑貓|宅配|711|7-11|全家|店到店|還沒收到|未到貨|追蹤|寄出|包裹/;
const AFTERSALES_KW = /退款|退貨|換貨|瑕疵|客訴|壞掉|破損|申請退|不要了/;
const PRODUCT_KW = /規格|尺寸|顏色|優惠|特價|成分|怎麼用|有貨|庫存|預購|保固|材質/;
const ORDER_CTX = /訂單|查單|查詢訂單|我的訂單|單號|編號|物流|出貨|貨態|配送|進度|何時到/;

/**
 * Phase 1.5：收斂硬規則（沿用 classifyOrderNumber / 混合句擷取），避免寬鬆英數誤判 SKU／coupon。
 * 優先序：售後 → 優惠碼語境 → 商品諮詢（無查單語境）→ 物流 → 單號／手機。
 */
export function computePhase15HardRoute(userMessage: string): HybridRouteResult | null {
  const t = (userMessage || "").trim();
  if (!t) return null;

  if (AFTERSALES_KW.test(t)) {
    return {
      selected_scenario: "AFTER_SALES",
      matched_intent: "return_refund_complaint",
      route_source: "rule",
      confidence: 0.86,
      used_llm_router: false,
    };
  }

  const couponish = /優惠碼|折扣碼|兌換碼|coupon|promo\s*code/i.test(t);
  if (couponish && !ORDER_CTX.test(t)) {
    return {
      selected_scenario: "PRODUCT_CONSULT",
      matched_intent: "coupon_or_promo",
      route_source: "rule",
      confidence: 0.76,
      used_llm_router: false,
    };
  }

  if (PRODUCT_KW.test(t) && !ORDER_CTX.test(t) && !extractOrderIdFromMixedSentence(t)) {
    return {
      selected_scenario: "PRODUCT_CONSULT",
      matched_intent: "product_faq",
      route_source: "rule",
      confidence: 0.78,
      used_llm_router: false,
    };
  }

  if (LOGISTICS_KW.test(t)) {
    return {
      selected_scenario: "ORDER_LOOKUP",
      matched_intent: "logistics_shipping",
      route_source: "rule",
      confidence: 0.84,
      used_llm_router: false,
    };
  }

  const compact = t.replace(/\s/g, "");
  const ot = classifyOrderNumber(t);
  if (!/\s/.test(t) && t.length <= 32) {
    if (ot === "order_id" || ot === "logistics_id" || ot === "payment_id") {
      return {
        selected_scenario: "ORDER_LOOKUP",
        matched_intent: "explicit_order_id",
        route_source: "rule",
        confidence: 0.91,
        used_llm_router: false,
      };
    }
    if (ot === "pending_review" && /^[A-Z]{2,4}\d{5,}$/i.test(compact)) {
      return {
        selected_scenario: "ORDER_LOOKUP",
        matched_intent: "probable_order_id",
        route_source: "rule",
        confidence: 0.82,
        used_llm_router: false,
      };
    }
  }

  const mixedId = extractOrderIdFromMixedSentence(t);
  if (mixedId && ORDER_CTX.test(t)) {
    return {
      selected_scenario: "ORDER_LOOKUP",
      matched_intent: "order_id_in_sentence",
      route_source: "rule",
      confidence: 0.88,
      used_llm_router: false,
    };
  }

  const longNumId = extractLongNumericOrderIdFromMixedSentence(t);
  if (longNumId && (ORDER_CTX.test(t) || /訂單|單號|官網|幫查|查單|查詢/.test(t))) {
    return {
      selected_scenario: "ORDER_LOOKUP",
      matched_intent: "shopline_numeric_order_in_sentence",
      route_source: "rule",
      confidence: 0.9,
      used_llm_router: false,
    };
  }

  if (TAIWAN_MOBILE.test(t) && (ORDER_CTX.test(t) || LOGISTICS_KW.test(t) || t.length <= 14)) {
    return {
      selected_scenario: "ORDER_LOOKUP",
      matched_intent: "phone_or_identifier",
      route_source: "rule",
      confidence: 0.85,
      used_llm_router: false,
    };
  }

  if (/\d{15,22}/.test(t) && ORDER_CTX.test(t)) {
    return {
      selected_scenario: "ORDER_LOOKUP",
      matched_intent: "long_numeric_order_hint",
      route_source: "rule",
      confidence: 0.79,
      used_llm_router: false,
    };
  }

  return null;
}

/** hybrid_router 關閉時，僅依 plan／state 對照情境（不呼叫 LLM）。 */
export function mapPlanToPhase1Scenario(input: HybridRouterInput): HybridRouteResult {
  return legacyPlanMap(input);
}

function legacyPlanMap(input: HybridRouterInput): HybridRouteResult {
  const m = input.planMode;
  if (m === "order_lookup" || m === "order_followup") {
    return {
      selected_scenario: "ORDER_LOOKUP",
      matched_intent: String(input.primaryIntent || "order_lookup"),
      route_source: "legacy_plan_map",
      confidence: 0.55,
      used_llm_router: false,
    };
  }
  if (
    m === "return_form_first" ||
    m === "return_stage_1" ||
    m === "return_stage_2" ||
    m === "return_stage_3" ||
    input.issueType === "return_refund" ||
    input.issueType === "complaint"
  ) {
    return {
      selected_scenario: "AFTER_SALES",
      matched_intent: String(input.primaryIntent || "after_sales"),
      route_source: "legacy_plan_map",
      confidence: 0.55,
      used_llm_router: false,
    };
  }
  if (input.issueType === "product_consult") {
    return {
      selected_scenario: "PRODUCT_CONSULT",
      matched_intent: String(input.primaryIntent || "product_consult"),
      route_source: "legacy_plan_map",
      confidence: 0.55,
      used_llm_router: false,
    };
  }
  return {
    selected_scenario: "GENERAL",
    matched_intent: String(input.primaryIntent || "general"),
    route_source: "legacy_plan_map",
    confidence: 0.5,
    used_llm_router: false,
  };
}

const LLM_INTENTS = new Set(["ORDER_LOOKUP", "AFTER_SALES", "PRODUCT_CONSULT", "GENERAL"]);

export function parseLlmIntentForTests(raw: string): { intent: AgentScenario; confidence: number } | null {
  return parseLlmIntent(raw);
}

function parseLlmIntent(raw: string): { intent: AgentScenario; confidence: number } | null {
  try {
    let s = raw.trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) s = fence[1].trim();
    const j = JSON.parse(s) as { intent?: string; confidence?: number };
    const intent = String(j.intent || "").toUpperCase() as AgentScenario;
    if (!LLM_INTENTS.has(intent)) return null;
    const c = typeof j.confidence === "number" && !Number.isNaN(j.confidence) ? Math.min(1, Math.max(0, j.confidence)) : 0.6;
    return { intent, confidence: c };
  } catch {
    return null;
  }
}

async function tryLlmRouter(input: HybridRouterInput): Promise<HybridRouteResult | null> {
  if (input.mockLlmRawResponse != null) {
    const parsed = parseLlmIntent(input.mockLlmRawResponse);
    if (!parsed) return null;
    return {
      selected_scenario: parsed.intent,
      matched_intent: "llm_classified",
      route_source: "llm",
      confidence: parsed.confidence,
      used_llm_router: true,
    };
  }
  if (!input.apiKey?.trim()) return null;
  const snippet = input.recentUserTexts.slice(-2).join("\n---\n").slice(0, 800);
  const userBlock = `最新訊息：\n${input.userMessage.slice(0, 500)}\n\n最近上下文：\n${snippet}`;
  const client = new OpenAI({ apiKey: input.apiKey });
  const model = resolveOpenAIRouterModel();
  try {
    const res = await client.chat.completions.create({
      model,
      temperature: 0.1,
      max_tokens: 120,
      messages: [
        {
          role: "system",
          content: `你是意圖分類器。只輸出單一 JSON 物件，鍵：intent（ORDER_LOOKUP|AFTER_SALES|PRODUCT_CONSULT|GENERAL）、confidence（0~1）、source 固定為字串 "llm"。
ORDER_LOOKUP：查單、物流、出貨、單號、手機查單。
AFTER_SALES：退換貨、退款、瑕疵、客訴。
PRODUCT_CONSULT：商品規格、優惠、FAQ、怎麼用。
GENERAL：其他問候或無法歸類。`,
        },
        { role: "user", content: userBlock },
      ],
    });
    const raw = res.choices[0]?.message?.content?.trim() || "";
    const parsed = parseLlmIntent(raw);
    if (!parsed) return null;
    return {
      selected_scenario: parsed.intent,
      matched_intent: "llm_classified",
      route_source: "llm",
      confidence: parsed.confidence,
      used_llm_router: true,
    };
  } catch {
    return null;
  }
}

/**
 * 執行完整 hybrid 流程；LLM 失敗或關閉時以 legacyPlanMap 兜底（不拋錯中斷主流程）。
 */
export async function runHybridIntentRouter(input: HybridRouterInput): Promise<HybridRouteResult> {
  const hard = input.preComputedHard ?? computePhase15HardRoute(input.userMessage);
  if (hard && hard.confidence >= 0.8) return hard;

  const llm = await tryLlmRouter(input);
  if (llm && llm.confidence >= 0.35) return llm;

  if (hard) {
    return { ...hard, route_source: "rule", confidence: Math.min(hard.confidence, 0.75) };
  }

  return { ...legacyPlanMap(input), route_source: "legacy_fallback" };
}
