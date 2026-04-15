---
產出時間: 2026-04-14（Asia/Taipei）
Phase 版本: Phase 106 交接包（含 106.1–106.17 與 debug endpoint）
檔案用途: 【檔案 5d】核心服務：`intent-router.service.ts`、`ai-client.service.ts`
---

## server/services/intent-router.service.ts

```typescript
/**
 * Hybrid Router：硬規則優先（Phase 1.5 收斂），必要時 LLM fallback，失敗則 legacy 對照 plan/state。
 */
import type { ReplyPlanMode } from "../reply-plan-builder";
import type { HybridRouteResult, AgentScenario } from "./phase1-types";
import { resolveHybridRouterModel } from "../openai-model";
import { createChatCompletionsOpenAIClient } from "../openai-routing-client";
import { storage } from "../storage";
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
  const snippet = input.recentUserTexts.slice(-2).join("\n---\n").slice(0, 800);
  const userBlock = `最新訊息：\n${input.userMessage.slice(0, 500)}\n\n最近上下文：\n${snippet}`;
  const rm = resolveHybridRouterModel();
  const client = createChatCompletionsOpenAIClient(rm, {
    openaiApiKey: input.apiKey,
    geminiApiKey: storage.getSetting("gemini_api_key"),
  });
  if (!client) return null;
  const model = rm.model;
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

```
## server/services/ai-client.service.ts

```typescript
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import type { ContentBlockParam, MessageParam } from "@anthropic-ai/sdk/resources/messages";
import {
  GoogleGenerativeAI,
  FunctionCallingMode,
  type Content,
  type FunctionDeclaration,
  type Part,
} from "@google/generative-ai";
import { randomUUID } from "node:crypto";
import { resolveMainConversationModel } from "../openai-model";
import { storage } from "../storage";

/** system 僅字串；user/assistant 可為 Claude 多模態／tool_use／tool_result 區塊 */
export type AiMessage =
  | { role: "system"; content: string }
  | {
      role: "user" | "assistant";
      content: string | ContentBlockParam[];
      /** Google Gemini 3.x：含 functionCall 的 model 回合須保留 API 回傳的 parts（含 thoughtSignature），不可只用 tool_use 重建 */
      geminiModelParts?: Part[];
    };

export interface AiCallOptions {
  messages: AiMessage[];
  tools?: object[];
  maxTokens?: number;
  temperature?: number;
  /** 品牌級覆寫（Phase 1 enabled 時由 ai-reply 傳入）；格式 openai:…／anthropic:…／google:… 或純 OpenAI id */
  modelOverride?: string;
}

export interface AiCallResult {
  content: string;
  tool_calls?: { id: string; name: string; arguments: string }[];
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Google：上一輪 model 的原始 parts，供下一輪 tool result 前原樣帶回（thought_signature） */
  geminiModelParts?: Part[];
}

function openAiToolToClaudeSchema(t: Record<string, unknown>): Anthropic.Tool {
  const fn = (t.function as Record<string, unknown> | undefined) ?? t;
  const name = String(fn.name ?? "tool");
  const description = (fn.description as string | undefined) ?? "";
  const parameters =
    (fn.parameters as Record<string, unknown> | undefined) ?? { type: "object", properties: {} };
  return {
    name,
    description,
    input_schema: parameters as Anthropic.Tool["input_schema"],
  };
}

function openAiToolToGeminiFunctionDeclaration(t: Record<string, unknown>): FunctionDeclaration {
  const fn = (t.function as Record<string, unknown> | undefined) ?? t;
  const name = String(fn.name ?? "tool");
  const description = typeof fn.description === "string" ? fn.description : undefined;
  const parameters = fn.parameters;
  const decl: FunctionDeclaration = { name, description };
  if (parameters && typeof parameters === "object") {
    decl.parameters = parameters as FunctionDeclaration["parameters"];
  }
  return decl;
}

function parseToolResultForGeminiResponse(raw: string): object {
  try {
    const j = JSON.parse(raw) as unknown;
    if (typeof j === "object" && j !== null && !Array.isArray(j)) return j as object;
    return { result: j };
  } catch {
    return { result: raw };
  }
}

function claudeStyleMessagesToGeminiContents(messages: AiMessage[]): {
  systemInstruction: string;
  contents: Content[];
} {
  let systemInstruction = "";
  const contents: Content[] = [];

  for (const m of messages) {
    if (m.role === "system") {
      if (typeof m.content !== "string") {
        throw new Error("Gemini：system 僅支援字串");
      }
      systemInstruction = systemInstruction ? `${systemInstruction}\n\n${m.content}` : m.content;
      continue;
    }

    if (m.role === "user") {
      const c = m.content;
      if (typeof c === "string") {
        contents.push({ role: "user", parts: [{ text: c }] });
        continue;
      }
      if (!Array.isArray(c)) throw new Error("Gemini：無效的 user 訊息");

      const textBits: string[] = [];
      const toolResultStrings: string[] = [];
      for (const b of c as ContentBlockParam[]) {
        if (b.type === "text") textBits.push(b.text);
        else if (b.type === "tool_result") {
          toolResultStrings.push(typeof b.content === "string" ? b.content : String(b.content));
        }
      }

      const parts: Part[] = [];
      for (const tb of textBits) {
        if (tb.trim()) parts.push({ text: tb });
      }

      if (toolResultStrings.length > 0) {
        const prev = contents[contents.length - 1];
        if (!prev || prev.role !== "model") {
          throw new Error("Gemini：tool_result 前必須為含 functionCall 的 model 回合");
        }
        const callParts = prev.parts.filter((p) => Boolean((p as { functionCall?: unknown }).functionCall));
        if (callParts.length !== toolResultStrings.length) {
          throw new Error(
            `Gemini：tool_result 數量 (${toolResultStrings.length}) 與上一輪 functionCall (${callParts.length}) 不一致`
          );
        }
        for (let i = 0; i < toolResultStrings.length; i++) {
          const fc = (callParts[i] as { functionCall: { name: string } }).functionCall;
          parts.push({
            functionResponse: {
              name: fc.name,
              response: parseToolResultForGeminiResponse(toolResultStrings[i]),
            },
          });
        }
      }

      if (parts.length === 0) continue;
      contents.push({ role: "user", parts });
      continue;
    }

    if (m.role === "assistant") {
      const gp = (m as { geminiModelParts?: Part[] }).geminiModelParts;
      if (gp && gp.length > 0) {
        let cloned: Part[];
        try {
          cloned = structuredClone(gp) as Part[];
        } catch {
          cloned = JSON.parse(JSON.stringify(gp)) as Part[];
        }
        contents.push({ role: "model", parts: cloned });
        continue;
      }
      const c = m.content;
      if (typeof c === "string") {
        if (c.trim()) contents.push({ role: "model", parts: [{ text: c }] });
        continue;
      }
      if (!Array.isArray(c)) throw new Error("Gemini：無效的 assistant 訊息");
      const parts: Part[] = [];
      for (const b of c as ContentBlockParam[]) {
        if (b.type === "text" && b.text?.trim()) {
          parts.push({ text: b.text });
        } else if (b.type === "tool_use") {
          const inputObj =
            b.input && typeof b.input === "object" && !Array.isArray(b.input)
              ? (b.input as object)
              : {};
          parts.push({
            functionCall: {
              name: b.name,
              args: inputObj,
            },
          });
        }
      }
      if (parts.length) contents.push({ role: "model", parts });
    }
  }

  return { systemInstruction, contents };
}

export async function callAiModel(options: AiCallOptions): Promise<AiCallResult> {
  const { provider, model } = resolveMainConversationModel(options.modelOverride);
  const { messages, tools, maxTokens = 1500, temperature = 0.85 } = options;

  if (provider === "anthropic") {
    const apiKey = storage.getSetting("anthropic_api_key")?.trim();
    if (!apiKey) throw new Error("Anthropic API key 未設定，請在後台設定 anthropic_api_key");

    const client = new Anthropic({ apiKey });
    const systemRow = messages.find((m) => m.role === "system");
    const systemMsg = systemRow && typeof systemRow.content === "string" ? systemRow.content : "";
    const chatMsgs: MessageParam[] = messages
      .filter((m) => m.role !== "system")
      .map((m) => {
        const role = m.role as "user" | "assistant";
        const c = m.content;
        if (typeof c === "string") return { role, content: c };
        return { role, content: c as ContentBlockParam[] };
      });

    const claudeTools =
      tools?.length ? tools.map((t) => openAiToolToClaudeSchema(t as Record<string, unknown>)) : undefined;

    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: systemMsg || undefined,
      messages: chatMsgs,
      ...(claudeTools?.length ? { tools: claudeTools } : {}),
    });

    const textContent = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    const toolUses = response.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
      .map((b) => ({
        id: b.id,
        name: b.name,
        arguments: JSON.stringify(b.input ?? {}),
      }));

    return {
      content: textContent,
      tool_calls: toolUses.length > 0 ? toolUses : undefined,
      provider: "anthropic",
      model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  }

  if (provider === "google") {
    const apiKey = storage.getSetting("gemini_api_key")?.trim();
    if (!apiKey) throw new Error("Gemini API key 未設定，請在後台設定 gemini_api_key");

    const { systemInstruction, contents } = claudeStyleMessagesToGeminiContents(messages);
    if (contents.length === 0) {
      throw new Error("Gemini：對話內容為空");
    }

    const funcDecls = tools?.length
      ? tools.map((t) => openAiToolToGeminiFunctionDeclaration(t as Record<string, unknown>))
      : undefined;

    const genAI = new GoogleGenerativeAI(apiKey);
    const genModel = genAI.getGenerativeModel({
      model,
      systemInstruction: systemInstruction || undefined,
      tools: funcDecls?.length ? [{ functionDeclarations: funcDecls }] : undefined,
      toolConfig: funcDecls?.length
        ? { functionCallingConfig: { mode: FunctionCallingMode.AUTO } }
        : undefined,
    });

    const result = await genModel.generateContent({
      contents,
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature,
      },
    });

    const response = result.response;
    if (response.promptFeedback?.blockReason) {
      throw new Error(`Gemini 遭安全策略阻擋：${response.promptFeedback.blockReason}`);
    }

    let fcs: ReturnType<typeof response.functionCalls> | undefined;
    try {
      fcs = response.functionCalls();
    } catch {
      fcs = undefined;
    }
    let textContent = "";
    try {
      textContent = response.text();
    } catch {
      textContent = "";
    }

    const tool_calls =
      fcs && fcs.length > 0
        ? fcs.map((fc, i) => ({
            id: `gemini_${fc.name}_${i}_${randomUUID().slice(0, 8)}`,
            name: fc.name,
            arguments: JSON.stringify(
              fc.args && typeof fc.args === "object" && fc.args !== null ? fc.args : {}
            ),
          }))
        : undefined;

    const rawParts = response.candidates?.[0]?.content?.parts;
    let geminiModelParts: Part[] | undefined;
    if (Array.isArray(rawParts) && rawParts.length > 0) {
      try {
        geminiModelParts = structuredClone(rawParts) as Part[];
      } catch {
        geminiModelParts = JSON.parse(JSON.stringify(rawParts)) as Part[];
      }
    }

    const usage = response.usageMetadata;
    return {
      content: textContent,
      tool_calls,
      provider: "google",
      model,
      inputTokens: usage?.promptTokenCount ?? 0,
      outputTokens: usage?.candidatesTokenCount ?? 0,
      geminiModelParts,
    };
  }

  const apiKey = storage.getSetting("openai_api_key")?.trim();
  if (!apiKey) throw new Error("OpenAI API key 未設定");

  for (const m of messages) {
    if (typeof (m as AiMessage).content !== "string") {
      throw new Error("OpenAI 路徑僅支援字串 content");
    }
  }
  const client = new OpenAI({ apiKey });
  const completion = await client.chat.completions.create({
    model,
    messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    ...(tools?.length ? { tools: tools as OpenAI.Chat.Completions.ChatCompletionTool[] } : {}),
    max_completion_tokens: maxTokens,
    temperature,
  });

  const msg = completion.choices[0]?.message;
  const toolCalls = msg?.tool_calls
    ?.filter((tc): tc is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall => tc.type === "function")
    .map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
    }));
  return {
    content: typeof msg?.content === "string" ? msg.content : "",
    tool_calls: toolCalls?.length ? toolCalls : undefined,
    provider: "openai",
    model,
    inputTokens: completion.usage?.prompt_tokens ?? 0,
    outputTokens: completion.usage?.completion_tokens ?? 0,
  };
}

```
