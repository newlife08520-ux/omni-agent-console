import path from "path";
import fs from "fs";
import OpenAI from "openai";
import type { Contact, IssueType } from "@shared/schema";
import type { IStorage } from "../storage";
import * as metaCommentsStorage from "../meta-comments-storage";
import {
  resolveConversationState,
  isHumanRequestMessage,
  isAlreadyProvidedMessage,
  isLinkRequestMessage,
  isLinkRequestCorrectionMessage,
  ORDER_LOOKUP_PATTERNS,
  ORDER_FOLLOWUP_PATTERNS,
  isAiHandlableIntent,
  HANDOFF_QUEUE_RESET_BLOCK_REPLY,
  isConversationResetRequest,
  isReturnFormFollowupMessage,
  isEligibleReturnFormFollowupResumeContact,
  isAiServiceRequest,
  shouldUnlockHandoffForCancelFlowFollowup,
  isFormSubmittedNotification,
} from "../conversation-state-resolver";
import { buildReplyPlan, shouldNotLeadWithOrderLookup, type ReplyPlanMode } from "../reply-plan-builder";
import {
  brandMessage,
  enforceOutputGuard,
  HANDOFF_MANDATORY_OPENING,
  buildHandoffReply,
  getHandoffReplyForCustomer,
} from "../phase2-output";
import { isModeNoPromo } from "../content-guard";
import { searchOrderInfoThreeLayers, searchOrderInfoInRecentMessages, extractOrderInfoFromImage } from "../already-provided-search";
import { shouldHandoffDueToAwkwardOrRepeat } from "../awkward-repeat-handoff";
import { getSuperLandingConfig } from "../superlanding";
import {
  unifiedLookupById,
  unifiedLookupByPhoneGlobal,
  getUnifiedStatusLabel,
  shouldPreferShoplineLookup,
} from "../order-service";
import { packDeterministicMultiOrderToolResult } from "../order-multi-renderer";
import { tryOrderFastPath, extractOrderIdFromMixedSentence } from "../order-fast-path";
import { formatOrderOnePage, payKindForOrder } from "../order-reply-utils";
import { normalizeCustomerFacingOrderReply } from "../customer-reply-normalizer";
import { isValidOrderDeterministicPayload } from "../deterministic-order-contract";
import { orderFeatureFlags } from "../order-feature-flags";
import { buildActiveOrderContextFromOrder } from "../order-active-context";
import {
  sortCandidatesNewestFirst,
  pickLatestCandidate,
  pickEarliestCandidate,
  pickCandidateByOrderDate,
  filterCandidatesBySource,
} from "../order-multi-selector";
import * as assignment from "../assignment";
import { detectIntentLevel, classifyOrderNumber, computeCasePriority, suggestTagsFromContent } from "../intent-and-order";
import { applyHandoff, normalizeHandoffReason } from "./handoff";
import { assembleEnrichedSystemPrompt } from "./prompt-builder";
import {
  appendAlreadyProvidedCluesBlock,
  appendGoalLockedBlock,
  appendHandoffModeBlock,
  appendImageAnalysisTaskBlock,
  appendMustNotIncludeBlock,
  appendNoOrderLookupLeadBlock,
  appendNoPromoExtensionBlock,
  appendOffTopicGuardBlock,
} from "./runtime-system-prompt-appendix";
import { ensureShippingSopCompliance } from "../sop-compliance-guard";
import { deriveOrderLookupIntent } from "../order-lookup-policy";
import { TRANSFER_TOOL_CUSTOMER_ACK, type ToolCallContext } from "./tool-executor.service";
import { resolveModelWithBrandOverride, resolveOpenAIModel } from "../openai-model";
import { createChatCompletionsOpenAIClient } from "../openai-routing-client";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { callAiModel, type AiCallResult, type AiMessage } from "./ai-client.service";
import { getDataDir } from "../data-dir";
import {
  classifyMessageForSafeAfterSale,
  FALLBACK_AFTER_SALE_LINE_LABEL,
  SHORT_IMAGE_FALLBACK,
} from "../safe-after-sale-classifier";
import { orderLookupTools, humanHandoffTools, imageTools, productRecommendTools } from "../openai-tools";
import { parsePhase1BrandFlags, isPhase1Active } from "./phase1-brand-config";
import { runHybridIntentRouter, mapPlanToPhase1Scenario, computePhase15HardRoute, type HybridRouterInput } from "./intent-router.service";
import type { HybridRouteResult, Phase1BrandFlags } from "./phase1-types";
import { filterToolsForScenario, applyScenarioToolOverrides } from "./tool-scenario-filter";
import { buildPhase1AiLogExtras } from "./phase1-trace-extras";
import { pickRandomAck, sendQuickAckIfNeeded, shouldSendQuickAck } from "./quick-ack.service";
import { runPostGenerationPipeline } from "./guard-pipeline";

/** Phase 1 法律/公關風險關鍵字，命中則走 legal_risk → high_risk_short_circuit */
const LEGAL_RISK_KEYWORDS = [
  "提告", "投訴", "檢舉", "消保官", "消基會", "律師", "法院", "法務", "詐騙",
  "備案", "報警", "再不處理", "公開", "發文", "媒體", "爆料", "消保",
];

const FRUSTRATED_ONLY_KEYWORDS = [
  "很爛", "生氣", "失望", "不爽", "火大", "扯", "爛透了", "誇張",
];

const RETURN_REFUND_KEYWORDS = ["退貨", "退款", "退費", "換貨", "取消訂單", "不要了", "想退"];

const ISSUE_TYPE_KEYWORDS: Record<IssueType, string[]> = {
  order_inquiry: ["訂單", "查詢", "出貨", "物流", "到貨", "單號", "編號", "進度", "哪裡", "何時"],
  product_consult: ["商品", "規格", "尺寸", "顏色", "怎麼用", "使用", "保固", "庫存", "有貨", "預購"],
  return_refund: ["退貨", "退款", "退費", "換貨", "取消訂單", "不要了", "想退", "鑑賞期"],
  complaint: ["投訴", "抱怨", "不滿", "客訴", "申訴", "爛", "誇張"],
  order_modify: ["改單", "修改訂單", "改地址", "改時間", "改收件"],
  general: ["請問", "想問", "謝謝", "再見", "你好"],
  other: [],
};

export function detectHighRisk(text: string): { level: "legal_risk" | "frustrated_only" | "none"; reasons: string[] } {
  const reasons: string[] = [];
  for (const kw of LEGAL_RISK_KEYWORDS) {
    if (text.includes(kw)) {
      reasons.push(`legal_risk: ${kw}`);
    }
  }
  if (reasons.length > 0) return { level: "legal_risk", reasons };
  for (const kw of FRUSTRATED_ONLY_KEYWORDS) {
    if (text.includes(kw)) {
      reasons.push(`frustrated_only: ${kw}`);
    }
  }
  if (reasons.length > 0) return { level: "frustrated_only", reasons };
  return { level: "none", reasons: [] };
}

function detectIssueType(messages: string[]): IssueType | null {
  const combined = messages.join(" ");
  let bestType: IssueType | null = null;
  let bestScore = 0;
  for (const [type, keywords] of Object.entries(ISSUE_TYPE_KEYWORDS)) {
    let score = 0;
    for (const kw of keywords) {
      if (combined.includes(kw)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestType = type as IssueType;
    }
  }
  return bestType;
}

function detectReturnRefund(text: string): boolean {
  return RETURN_REFUND_KEYWORDS.some((kw) => text.includes(kw));
}

export async function getEnrichedSystemPrompt(
  brandId?: number,
  context?: { planMode?: ReplyPlanMode }
): Promise<string> {
  const result = await assembleEnrichedSystemPrompt(brandId, {
    planMode: context?.planMode,
  });
  return result.full_prompt;
}

const ASK_ORDER_PHONE_FOR_BYPASS_KW = ["請提供訂單編號", "訂單編號", "請提供", "手機號碼", "商品名稱", "下訂手機", "收件人", "請提供賃訊"];

function isOrderLookupFamily(mode: string): boolean {
  return mode === "order_lookup" || mode === "order_followup";
}

/** 供主對話 system prompt：從 contact.display_name 整理出可稱呼字串（不加先生／小姐） */
function sanitizeContactDisplayName(raw: string): string {
  const s = (raw || "").trim();
  if (!s) return "";
  // 過濾 LINE user ID
  if (/^U[a-f0-9]{30,}$/i.test(s)) return "";
  // 過濾 Unknown
  if (/^unknown$/i.test(s)) return "";
  // 過濾純數字
  if (/^\d+$/.test(s)) return "";
  // 去掉前後符號和 emoji
  const cleaned = s
    .replace(/^[.*★☆♥♡~～❤️💕🌟✨💖🌸🌺💫⭐️\s]+|[.*★☆♥♡~～❤️💕🌟✨💖🌸🌺💫⭐️\s]+$/g, "")
    .trim();
  if (!cleaned) return "";
  // 「XX先生/小姐」這類稱呼，去掉先生小姐再處理
  const titleRemoved = cleaned.replace(/(先生|小姐|女士|太太|哥|姊|姐)$/, "");

  if (/^[\u4e00-\u9fff]{3,}$/.test(titleRemoved)) {
    return titleRemoved.slice(-2);
  }
  if (/^[\u4e00-\u9fff]{1,2}$/.test(titleRemoved)) {
    return titleRemoved;
  }
  if (/^[a-zA-Z]/.test(cleaned)) {
    const firstName = cleaned.split(/[\s._]+/)[0];
    return firstName || "";
  }
  return cleaned.length > 10 ? cleaned.slice(0, 10) : cleaned;
}

function openaiChatMessagesToClaudeSeed(
  msgs: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
): AiMessage[] | null {
  const out: AiMessage[] = [];
  for (const m of msgs) {
    if (m.role === "system") {
      if (typeof m.content !== "string") return null;
      out.push({ role: "system", content: m.content });
    } else if (m.role === "user") {
      if (typeof m.content === "string") {
        out.push({ role: "user", content: m.content });
      } else if (Array.isArray(m.content)) {
        return null;
      }
    } else if (m.role === "assistant") {
      if (typeof m.content === "string") {
        out.push({ role: "assistant", content: m.content ?? "" });
      } else {
        return null;
      }
    } else {
      return null;
    }
  }
  return out;
}

function aiCallResultToOpenAiAssistantMessage(r: AiCallResult): OpenAI.Chat.Completions.ChatCompletionMessage {
  const tool_calls = r.tool_calls?.map((tc) => ({
    id: tc.id,
    type: "function" as const,
    function: { name: tc.name, arguments: tc.arguments || "{}" },
  }));
  return {
    role: "assistant",
    content: r.content || null,
    tool_calls: tool_calls && tool_calls.length > 0 ? tool_calls : undefined,
    refusal: null,
  } as OpenAI.Chat.Completions.ChatCompletionMessage;
}

function openAiAssistantToClaudeContentBlocks(
  msg: OpenAI.Chat.Completions.ChatCompletionMessage
): ContentBlockParam[] {
  const blocks: ContentBlockParam[] = [];
  const c = msg.content;
  if (typeof c === "string" && c.trim()) {
    blocks.push({ type: "text", text: c });
  }
  const tcs = msg.tool_calls;
  if (tcs) {
    for (const tc of tcs) {
      if (tc.type !== "function") continue;
      const fn = (tc as OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall).function;
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(fn.arguments || "{}") as Record<string, unknown>;
      } catch {
        input = {};
      }
      blocks.push({
        type: "tool_use",
        id: tc.id,
        name: fn.name,
        input,
      });
    }
  }
  return blocks;
}

/** Minimal Safe Mode：永遠不走 active-order 確定性短路，強制經 LLM。 */
function planAllowsActiveOrderDeterministic(_mode: string): boolean {
  return false;
}

function looksLikeOrderIdInput(s: string): boolean {
  const t = (s || "").trim();
  return t.length <= 10 && t.length >= 1 && /^[0-9A-Za-z\-]+$/.test(t);
}

/** @deprecated 請改用 resolveOpenAIModel from ../openai-model */
export function getOpenAIModel(): string {
  return resolveOpenAIModel();
}

export interface AiReplyDeps {
  storage: IStorage;
  broadcastSSE: (eventType: string, data: unknown) => void;
  pushLineMessage: (userId: string, messages: object[], token?: string | null) => Promise<void>;
  sendFBMessage: (pageAccessToken: string, recipientId: string, text: string) => Promise<void>;
  toolExecutor: { executeToolCall: (toolName: string, args: Record<string, string>, context?: ToolCallContext) => Promise<string> };
  getTransferUnavailableSystemMessage: (reason: "weekend" | "lunch" | "after_hours" | "all_paused" | null) => string;
  getLineTokenForContact: (contact: { channel_id?: number | null; brand_id?: number | null }) => string | null;
}


export function createAiReplyService(deps: AiReplyDeps) {
  const {
    storage,
    broadcastSSE,
    pushLineMessage,
    sendFBMessage,
    toolExecutor,
    getTransferUnavailableSystemMessage,
    getLineTokenForContact,
  } = deps;

  const FORM_URLS = {
    cancel: "jsj.top/f/x253ie",
    return: "jsj.top/f/rwcIDN",
    exchange: "jsj.top/f/PwcbA7",
  } as const;

  function detectOutboundFormTypeFromReply(replyText: string): "cancel" | "return" | "exchange" | null {
    const t = replyText || "";
    if (t.includes(FORM_URLS.cancel)) return "cancel";
    if (t.includes(FORM_URLS.return)) return "return";
    if (t.includes(FORM_URLS.exchange)) return "exchange";
    return null;
  }

  function formTypeToZh(formType: "cancel" | "return" | "exchange"): string {
    return formType === "cancel" ? "取消" : formType === "return" ? "退貨" : "換貨";
  }

  async function handleCustomerReportedFormSubmitted(
    contact: Contact,
    userMessage: string,
    channelToken: string | null | undefined,
    platform: string | undefined,
    startTime: number,
    effectiveBrandIdForLog: number | undefined
  ): Promise<void> {
    const c = storage.getContact(contact.id);
    const w = c?.waiting_for_customer;
    if (!w?.endsWith("_form_submit") || !isFormSubmittedNotification(userMessage)) return;
    const raw = w.replace(/_form_submit$/, "");
    if (raw !== "cancel" && raw !== "return" && raw !== "exchange") return;
    const formType = raw as "cancel" | "return" | "exchange";
    const formTypeZh = formTypeToZh(formType);

    storage.updateContactHumanFlag(contact.id, 1);
    storage.updateContactStatus(contact.id, "awaiting_human");
    storage.updateContactConversationFields(contact.id, { waiting_for_customer: null });

    storage.createCaseNotification(contact.id, "in_app", {
      type: "form_submitted",
      form_type: formType,
      priority: "high",
      message: `客戶回報已填寫 ${formTypeZh} 表單，請盡快處理`,
    });

    const contactPlatform = platform || contact.platform || "line";
    const sysBody = `[表單提交] 客戶回報已填寫${formTypeZh}表單`;
    const sysMsg = storage.createMessage(contact.id, contactPlatform, "system", sysBody);
    broadcastSSE("new_message", { contact_id: contact.id, message: sysMsg, brand_id: contact.brand_id });
    broadcastSSE("contacts_updated", { brand_id: contact.brand_id });

    const ackText =
      "好的～收到囉，已經幫您加急處理 🙏 專員會盡快主動聯繫您確認後續，有任何問題隨時跟我說！";

    if (contactPlatform === "messenger" && channelToken) {
      await sendFBMessage(channelToken, contact.platform_user_id, ackText);
    } else {
      const token = channelToken || getLineTokenForContact(contact);
      if (token) {
        await pushLineMessage(contact.platform_user_id, [{ type: "text", text: ackText }], token);
      }
    }

    const aiMsg = storage.createMessage(contact.id, contactPlatform, "ai", ackText);
    broadcastSSE("new_message", { contact_id: contact.id, message: aiMsg, brand_id: contact.brand_id });
    broadcastSSE("contacts_updated", { brand_id: contact.brand_id });

    storage.createAiLog({
      contact_id: contact.id,
      message_id: aiMsg.id,
      brand_id: effectiveBrandIdForLog,
      prompt_summary: userMessage.slice(0, 200),
      knowledge_hits: [],
      tools_called: ["form_submitted_ack"],
      transfer_triggered: true,
      transfer_reason: `form_submitted:${formType}`,
      result_summary: "客戶回報表單已填，標記待人工＋確認回覆",
      token_usage: 0,
      model: "form-tracking",
      response_time_ms: Date.now() - startTime,
      reply_source: "form_submitted_ack",
      used_llm: 0,
      plan_mode: null,
      reason_if_bypassed: null,
    });
  }

  function mergeStreamDelta(
      prev: OpenAI.Chat.Completions.ChatCompletionMessage,
      delta: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta
    ): OpenAI.Chat.Completions.ChatCompletionMessage {
      const out: OpenAI.Chat.Completions.ChatCompletionMessage = {
        ...prev,
        role: prev.role || (delta.role as any) || "assistant",
      };
      if (delta.content != null && delta.content !== "") {
        out.content = (out.content || "") + delta.content;
      }
      if (delta.tool_calls != null && delta.tool_calls.length > 0) {
        const arr = (out.tool_calls || []) as OpenAI.Chat.Completions.ChatCompletionMessageToolCall[];
        for (const d of delta.tool_calls) {
          const i = d.index ?? arr.length;
          while (arr.length <= i) arr.push({ id: "", type: "function", function: { name: "", arguments: "" } });
          const t = arr[i];
          if (d.id != null) (t as any).id = d.id;
          if (d.function != null) {
            const fn = (t as { function?: { name?: string; arguments?: string } }).function;
            if (fn && d.function.name != null) fn.name = (fn.name || "") + d.function.name;
            if (fn && d.function.arguments != null) fn.arguments = (fn.arguments || "") + d.function.arguments;
          }
        }
        out.tool_calls = arr;
      }
      return out;
    }

    async function runOpenAIStream(
      openai: OpenAI,
      params: Omit<OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming, "stream">,
      contactId: number,
      brandId: number | undefined,
      signal?: AbortSignal
    ): Promise<OpenAI.Chat.Completions.ChatCompletionMessage> {
      const stream = await openai.chat.completions.create(
        { ...params, stream: true },
        { signal: signal as any }
      );
      let message: OpenAI.Chat.Completions.ChatCompletionMessage = { role: "assistant", content: "", refusal: null };
      for await (const chunk of stream) {
        const choice = chunk.choices?.[0];
        if (!choice?.delta) continue;
        message = mergeStreamDelta(message, choice.delta);
        if (choice.delta.content) {
          broadcastSSE("message_chunk", { contact_id: contactId, brand_id: brandId, chunk: choice.delta.content });
        }
      }
      return message;
    }

﻿  async function imageFileToDataUri(imageFilePath: string): Promise<string | null> {
    try {
      const absPath = path.join(getDataDir(), imageFilePath.startsWith("/") ? imageFilePath.slice(1) : imageFilePath);
      if (!fs.existsSync(absPath)) return null;
      const imageBuffer = await fs.promises.readFile(absPath);
      const ext = path.extname(absPath).toLowerCase();
      const mimeType = ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : ext === ".webp" ? "image/webp" : "image/jpeg";
      return `data:${mimeType};base64,${imageBuffer.toString("base64")}`;
    } catch (_e) {
      return null;
    }
  }

  /** 視覺優先流程：紀錄 vision-first 相關 log */
  const IMAGE_INTENT_ORDER = "order_screenshot";
  const IMAGE_INTENT_PRODUCT_ISSUE = "product_issue_defect";
  const IMAGE_INTENT_PRODUCT_PAGE = "product_page_size";
  const IMAGE_INTENT_OFF_BRAND = "off_brand";
  const IMAGE_INTENT_UNREADABLE = "unreadable";

  /**
   * Vision-first：圖片意圖分類與初步對客回覆；低信心或 unreadable 時走 SHORT_IMAGE_FALLBACK。
   */
  async function handleImageVisionFirst(
    imageFilePath: string,
    contactId: number
  ): Promise<{ reply: string; usedFallback: boolean; intent?: string; confidence?: string }> {
    const apiKey = storage.getSetting("openai_api_key");
    if (!apiKey?.trim()) {
      return { reply: SHORT_IMAGE_FALLBACK, usedFallback: true };
    }
    const dataUri = await imageFileToDataUri(imageFilePath);
    if (!dataUri) {
      return { reply: SHORT_IMAGE_FALLBACK, usedFallback: true };
    }
    const contact = storage.getContact(contactId);
    const brandId = contact?.brand_id;
    /** 若無 order_id 則以 vision 辨識結果或既有 active_order_context 補齊（含 ECPay 等） */
    try {
      const openaiForImage = new OpenAI({ apiKey: apiKey.trim() });
      const extracted = await extractOrderInfoFromImage(openaiForImage, dataUri);
      const orderIdRaw = (extracted.orderId || "").trim();
      if (orderIdRaw.length >= 5 && /^[A-Za-z0-9\-]+$/.test(orderIdRaw)) {
        const config = getSuperLandingConfig(brandId ?? undefined);
        const hasCreds = (config.merchantNo && config.accessKey) || (brandId ? !!storage.getBrand(brandId)?.shopline_api_token?.trim() : false);
        if (hasCreds) {
          const result = await unifiedLookupById(config, orderIdRaw.toUpperCase(), brandId ?? undefined, undefined, false);
          if (result.found && result.orders.length > 0) {
            const order = result.orders[0];
            const statusLabel = getUnifiedStatusLabel(order.status, result.source);
            const pk = payKindForOrder(order, statusLabel, order.source || result.source);
            const one_page_summary = formatOrderOnePage({
              order_id: order.global_order_id,
              buyer_name: order.buyer_name,
              buyer_phone: order.buyer_phone,
              created_at: order.created_at,
              payment_method: order.payment_method,
              payment_status_label: pk.label,
              amount: order.final_total_order_amount,
              shipping_method: order.shipping_method,
              tracking_number: order.tracking_number,
              delivery_target_type: order.delivery_target_type,
              cvs_brand: order.cvs_brand,
              cvs_store_name: order.cvs_store_name,
              full_address: order.full_address,
              address: order.address,
              product_list: order.product_list,
              status: statusLabel,
              shipped_at: order.shipped_at,
            });
            storage.linkOrderForContact(contactId, order.global_order_id, "ai_lookup");
            storage.setActiveOrderContext(
              contactId,
              buildActiveOrderContextFromOrder(order, result.source, statusLabel, one_page_summary, "image")
            );
            return { reply: "已查到訂單，摘要如下：\n\n" + one_page_summary, usedFallback: false, intent: IMAGE_INTENT_ORDER };
          }
        }
      }
    } catch (_e) { /* 略過 vision 前查單錯誤 */ }
    const recentMessages = storage.getMessages(contactId).slice(-10);
    const tags = (contact?.tags && typeof contact.tags === "string") ? (() => { try { return JSON.parse(contact.tags) as string[]; } catch { return []; } })() : [];
    const contextParts: string[] = [];
    for (const m of recentMessages) {
      if (m.sender_type === "user" && m.content && m.content !== "[圖片訊息]" && !m.content.startsWith("[圖片")) {
        contextParts.push(`[客戶]: ${m.content.slice(0, 80)}`);
      } else if (m.sender_type === "ai" && m.content) {
        contextParts.push(`[客服]: ${m.content.slice(0, 80)}`);
      }
    }
    if (tags.length) contextParts.push(`標籤：${tags.join("、")}`);
    const contextStr = contextParts.length ? contextParts.join("\n") : "無歷史對話";

    const systemPrompt = await getEnrichedSystemPrompt(brandId ?? undefined);
    const visionInstruction = `
任務 - Vision First 圖片意圖分類與初步回覆
請判斷客戶傳來的圖片屬於哪種情境：
- order_screenshot（訂單/結帳/物流截圖）
- product_issue_defect（商品瑕疵或問題）
- product_page_size（商品尺寸或款式詢問）
- off_brand（非本品牌商品或無關圖片）
- unreadable（圖片模糊或無法辨識）

對話上下文：
${contextStr}

請嚴格輸出 JSON 格式：{"intent":"分類名稱","confidence":"high 或 low","reply_to_customer":"你要回覆給客人的草稿"}
規則：
- 若 confidence 為 low 或 intent 為 unreadable，reply_to_customer 留空字串。
- 若為 order_screenshot，請嘗試讀取圖中的單號。
- reply_to_customer 長度限制 50-120 字，語氣親切。`;

    const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
      { type: "text", text: "請根據圖片與上下文輸出對應的 JSON：" },
      { type: "image_url", image_url: { url: dataUri } },
    ];

    try {
      const openai = new OpenAI({ apiKey: apiKey.trim() });
      const completion = await openai.chat.completions.create({
        model: getOpenAIModel(),
        messages: [
          { role: "system", content: systemPrompt + "\n\n" + visionInstruction },
          { role: "user", content: userContent },
        ],
        response_format: { type: "json_object" },
        max_completion_tokens: 400,
        temperature: 0.3,
      });
      const raw = completion.choices[0]?.message?.content?.trim();
      if (!raw) return { reply: SHORT_IMAGE_FALLBACK, usedFallback: true };
      let parsed: { intent?: string; confidence?: string; reply_to_customer?: string };
      try {
        parsed = JSON.parse(raw);
      } catch {
        return { reply: SHORT_IMAGE_FALLBACK, usedFallback: true };
      }
      const intent = parsed.intent ?? "";
      const confidence = (parsed.confidence ?? "low").toLowerCase();
      const replyText = (parsed.reply_to_customer ?? "").trim();
      const useFallback =
        confidence === "low" ||
        intent === IMAGE_INTENT_UNREADABLE ||
        replyText.length === 0;
      if (useFallback) {
        return { reply: SHORT_IMAGE_FALLBACK, usedFallback: true, intent, confidence };
      }
      const guarded = enforceOutputGuard(replyText, "answer_directly");
      return { reply: guarded, usedFallback: false, intent, confidence };
    } catch (err: any) {
      console.error("[handleImageVisionFirst] Vision error:", err?.message);
      return { reply: SHORT_IMAGE_FALLBACK, usedFallback: true };
    }
  }

  async function analyzeImageWithAI(imageFilePath: string, contactId: number, lineToken?: string | null, platform?: string) {
    const apiKey = storage.getSetting("openai_api_key");
    if (!apiKey || apiKey.trim() === "") return;
    const contactPlatform = platform || "line";
    try {
      const currentImageDataUri = await imageFileToDataUri(imageFilePath);
      if (!currentImageDataUri) {
        console.error("Cannot read image file for AI analysis:", imageFilePath);
        return;
      }

      const contact = storage.getContact(contactId);
      let systemPrompt = await getEnrichedSystemPrompt(contact?.brand_id || undefined);
      systemPrompt += appendImageAnalysisTaskBlock();

      const recentMessages = storage.getMessages(contactId).slice(-15);
      const chatMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        { role: "system", content: systemPrompt },
      ];
      let currentImageIncluded = false;
      for (const msg of recentMessages) {
        if (msg.sender_type === "user") {
          if (msg.message_type === "image" && msg.image_url) {
            const msgDataUri = await imageFileToDataUri(msg.image_url);
            if (msgDataUri) {
              if (msg.image_url === imageFilePath || msg.image_url.endsWith(imageFilePath.split("/").pop() || "")) {
                currentImageIncluded = true;
              }
              chatMessages.push({ role: "user", content: [
                { type: "text", text: msg.content || "請參考這張圖片：" },
                { type: "image_url", image_url: { url: msgDataUri } },
              ]});
            } else {
              chatMessages.push({ role: "user", content: msg.content });
            }
          } else {
            chatMessages.push({ role: "user", content: msg.content });
          }
        } else if (msg.sender_type === "ai") {
          chatMessages.push({ role: "assistant", content: msg.content });
        }
      }
      if (!currentImageIncluded) {
        chatMessages.push({ role: "user", content: [
          { type: "text", text: "請參考這張圖片：" },
          { type: "image_url", image_url: { url: currentImageDataUri } },
        ]});
      }

      const effectiveBrandId = contact?.brand_id;
      const hasImageAssets = storage.getImageAssets(effectiveBrandId || undefined).length > 0;
      const allTools = [...orderLookupTools, ...humanHandoffTools, ...productRecommendTools, ...(hasImageAssets ? imageTools : [])];

      const openai = new OpenAI({ apiKey });
      let completion = await openai.chat.completions.create({
        model: getOpenAIModel(),
        messages: chatMessages,
        tools: allTools,
        max_completion_tokens: 1000,
        temperature: 0.7,
      });

      let responseMessage = completion.choices[0]?.message;
      let loopCount = 0;
      while (responseMessage?.tool_calls && responseMessage.tool_calls.length > 0 && loopCount < 3) {
        loopCount++;
        chatMessages.push(responseMessage as OpenAI.Chat.Completions.ChatCompletionMessageParam);
        for (const toolCall of responseMessage.tool_calls) {
          const fn = (toolCall as { function?: { name?: string; arguments?: string } }).function;
          const fnName = fn?.name ?? "";
          let fnArgs: Record<string, string> = {};
          try { fnArgs = JSON.parse(fn?.arguments ?? "{}"); } catch (_e) {}
          const toolResult = await toolExecutor.executeToolCall(fnName, fnArgs, {
            contactId: contactId,
            brandId: effectiveBrandId || undefined,
            channelToken: lineToken || undefined,
            platform: contactPlatform,
            platformUserId: contact?.platform_user_id || "",
            orderLookupSummaryOnly: false,
            startTime: Date.now(),
            queueWaitMs: 0,
          });
          chatMessages.push({ role: "tool", tool_call_id: toolCall.id, content: toolResult });
        }
        const freshContact = storage.getContact(contactId);
        if (freshContact?.needs_human) break;
        completion = await openai.chat.completions.create({
          model: getOpenAIModel(),
          messages: chatMessages,
          tools: allTools,
          max_completion_tokens: 1000,
          temperature: 0.7,
        });
        responseMessage = completion.choices[0]?.message;
      }

      const finalContact = storage.getContact(contactId);
      if (finalContact?.needs_human) return;

      const reply = responseMessage?.content || "不好意思，系統暫時無法回覆，請稍後再試或轉接人工客服。";
      const aiMsg = storage.createMessage(contactId, contactPlatform, "ai", reply);
      broadcastSSE("new_message", { contact_id: contactId, message: aiMsg, brand_id: contact?.brand_id });
      broadcastSSE("contacts_updated", { brand_id: contact?.brand_id });

      if (contactPlatform === "messenger") {
        const fbToken = contact?.channel_id ? storage.getChannel(contact.channel_id)?.access_token : null;
        if (fbToken) await sendFBMessage(fbToken, contact!.platform_user_id, reply);
      } else {
        const token = lineToken || getLineTokenForContact(contact || {});
        if (token && contact) {
          await pushLineMessage(contact.platform_user_id, [{ type: "text", text: reply }], token);
        }
      }
    } catch (err) {
      console.error("OpenAI Vision analysis error:", err);
      storage.createMessage(contactId, contactPlatform, "ai", "不好意思，系統遇到問題，我幫您轉接人工客服處理。");
    }
  }

﻿  async function autoReplyWithAI(
    contact: Contact,
    userMessage: string,
    channelToken?: string | null,
    brandId?: number,
    platform?: string,
    aiOpts?: { enqueueTimestampMs?: number }
  ) {
    const apiKey = storage.getSetting("openai_api_key");
    if (!apiKey || apiKey.trim() === "") return;

    const startTime = Date.now();
    const queueWaitMs =
      aiOpts?.enqueueTimestampMs != null ? Math.max(0, startTime - aiOpts.enqueueTimestampMs) : 0;
    if (orderFeatureFlags.orderLatencyV2 && queueWaitMs > 0) {
      console.log(`[phase26_latency] queue_wait_ms=${queueWaitMs} contact=${contact.id}`);
    }
    const effectiveBrandIdForLog = contact.brand_id || brandId;

    const latestForForm = storage.getContact(contact.id);
    if (
      latestForForm?.waiting_for_customer?.endsWith("_form_submit") &&
      isFormSubmittedNotification(userMessage)
    ) {
      await handleCustomerReportedFormSubmitted(
        contact,
        userMessage,
        channelToken ?? null,
        platform,
        startTime,
        effectiveBrandIdForLog ?? undefined
      );
      return;
    }

    const freshCheck = storage.getContact(contact.id);
    const recentBodiesForHandoffUnlock = storage
      .getMessages(contact.id)
      .slice(-6)
      .map((m) => String(m.content || ""));

    async function replyHandoffQueueResetBlocked(): Promise<void> {
      const blockMsg = HANDOFF_QUEUE_RESET_BLOCK_REPLY;
      const contactPlatform = platform || contact.platform || "line";
      const aiMsg = storage.createMessage(contact.id, contactPlatform, "ai", blockMsg);
      broadcastSSE("new_message", { contact_id: contact.id, message: aiMsg, brand_id: contact.brand_id });
      broadcastSSE("contacts_updated", { brand_id: contact.brand_id });
      if (contactPlatform === "messenger" && channelToken) {
        await sendFBMessage(channelToken, contact.platform_user_id, blockMsg);
      } else if (channelToken) {
        await pushLineMessage(contact.platform_user_id, [{ type: "text", text: blockMsg }], channelToken);
      }
      storage.createAiLog({
        contact_id: contact.id,
        brand_id: effectiveBrandIdForLog || undefined,
        prompt_summary: userMessage.slice(0, 200),
        knowledge_hits: [],
        tools_called: [],
        transfer_triggered: false,
        result_summary: "gate_handoff_queue_reset_blocked",
        token_usage: 0,
        model: "gate",
        response_time_ms: Date.now() - startTime,
        reply_source: "gate_skip",
        used_llm: 0,
        plan_mode: null,
        reason_if_bypassed: "handoff_queue_reset_blocked",
      });
    }

    if (freshCheck && (freshCheck.status === "awaiting_human" || freshCheck.status === "high_risk")) {
      if (isConversationResetRequest(userMessage)) {
        await replyHandoffQueueResetBlocked();
        return;
      }
      const isLinkAsk = isLinkRequestMessage(userMessage) || isLinkRequestCorrectionMessage(userMessage);
      const canResumeReturnForm =
        isReturnFormFollowupMessage(userMessage) && isEligibleReturnFormFollowupResumeContact(freshCheck);
      const wantsAiService = isAiServiceRequest(userMessage);
      const cancelFlowUnlock = shouldUnlockHandoffForCancelFlowFollowup(userMessage, recentBodiesForHandoffUnlock);
      if (isLinkAsk || canResumeReturnForm || wantsAiService || cancelFlowUnlock) {
        storage.updateContactHumanFlag(contact.id, 0);
        storage.updateContactStatus(contact.id, "ai_handling");
        broadcastSSE("contacts_updated", { brand_id: contact.brand_id });
      } else {
        console.log(`[AI Mute] Contact ${contact.id} status=${freshCheck.status}, AI ??? - ??`);
        storage.createAiLog({
          contact_id: contact.id,
          brand_id: effectiveBrandIdForLog || undefined,
          prompt_summary: userMessage.slice(0, 200),
          knowledge_hits: [],
          tools_called: [],
          transfer_triggered: false,
          result_summary: "gate_skip:status",
          token_usage: 0,
          model: "gate",
          response_time_ms: Date.now() - startTime,
          reply_source: "gate_skip",
          used_llm: 0,
          plan_mode: null,
          reason_if_bypassed: `status=${freshCheck.status}`,
        });
        return;
      }
    }
    if (freshCheck && freshCheck.needs_human) {
      if (isConversationResetRequest(userMessage)) {
        await replyHandoffQueueResetBlocked();
        return;
      }
      const isLinkAsk = isLinkRequestMessage(userMessage) || isLinkRequestCorrectionMessage(userMessage);
      const canResumeReturnForm =
        isReturnFormFollowupMessage(userMessage) && isEligibleReturnFormFollowupResumeContact(freshCheck);
      const wantsAiService = isAiServiceRequest(userMessage);
      const cancelFlowUnlock = shouldUnlockHandoffForCancelFlowFollowup(userMessage, recentBodiesForHandoffUnlock);
      if (isLinkAsk || canResumeReturnForm || wantsAiService || cancelFlowUnlock) {
        storage.updateContactHumanFlag(contact.id, 0);
        storage.updateContactStatus(contact.id, "ai_handling");
        broadcastSSE("contacts_updated", { brand_id: contact.brand_id });
      } else {
        /** 避免 Handoff Loop：needs_human=1 時不再給 link 讓 AI 回；由 LLM 決定是否結束或轉人工 */
        console.log(`[AI Mute] Contact ${contact.id} needs_human=1, AI ??? - ????????`);
        storage.createAiLog({
          contact_id: contact.id,
          brand_id: effectiveBrandIdForLog || undefined,
          prompt_summary: userMessage.slice(0, 200),
          knowledge_hits: [],
          tools_called: [],
          transfer_triggered: false,
          result_summary: "gate_skip:needs_human",
          token_usage: 0,
          model: "gate",
          response_time_ms: Date.now() - startTime,
          reply_source: "gate_skip",
          used_llm: 0,
          plan_mode: null,
          reason_if_bypassed: "needs_human",
        });
        return;
      }
    }
    if (storage.isAiMuted(contact.id)) {
      console.log(`[AI Mute] Contact ${contact.id} ??????? - ??`);
      storage.createAiLog({
        contact_id: contact.id,
        brand_id: effectiveBrandIdForLog || undefined,
        prompt_summary: userMessage.slice(0, 200),
        knowledge_hits: [],
        tools_called: [],
        transfer_triggered: false,
        result_summary: "gate_skip:ai_muted",
        token_usage: 0,
        model: "gate",
        response_time_ms: Date.now() - startTime,
        reply_source: "gate_skip",
        used_llm: 0,
        plan_mode: null,
        reason_if_bypassed: "ai_muted",
      });
      return;
    }

    const toolsCalled: string[] = [];
    let transferTriggered = false;
    let transferReason: string | undefined;
    let totalTokens = 0;
    let orderLookupFailed = 0;
    let phase1Flags = parsePhase1BrandFlags(undefined);
    let phase1Route: HybridRouteResult | null = null;
    let toolsAvailableNames: string[] = [];
    let phase1ModelOverride: string | undefined;

    try {
      const effectiveBrandId = contact.brand_id || brandId;
      phase1Flags = parsePhase1BrandFlags(effectiveBrandId ? storage.getBrand(effectiveBrandId) : undefined);
      phase1ModelOverride = isPhase1Active(phase1Flags) ? phase1Flags.ai_model_override : undefined;

      storage.updateContactStatus(contact.id, "ai_handling");
      broadcastSSE("contacts_updated", { brand_id: contact.brand_id });

      const riskCheck = detectHighRisk(userMessage);
      if (riskCheck.level === "legal_risk") {
        console.log("[Webhook AI] needs_human=1 source=high_risk_short_circuit reasons=" + riskCheck.reasons.join(","));
        console.log(`[AI Risk] ??/??????: ${riskCheck.reasons.join(", ")}`);
        applyHandoff({ contactId: contact.id, reason: "high_risk_short_circuit", source: "webhook_high_risk", brandId: effectiveBrandId || undefined, statusOverride: "high_risk" });
        storage.createMessage(contact.id, contact.platform, "system",
          `(????) ?????????????????????????${riskCheck.reasons.join("?")}`);
        broadcastSSE("contacts_updated", { brand_id: contact.brand_id });
        const handoffReplyLegal = buildHandoffReply({ customerEmotion: "high_risk", brandId: effectiveBrandId || undefined });
        const handoffTextLegal = getHandoffReplyForCustomer(handoffReplyLegal, assignment.getUnavailableReason());
        const aiMsgRisk = storage.createMessage(contact.id, contact.platform, "ai", handoffTextLegal);
        broadcastSSE("new_message", { contact_id: contact.id, message: aiMsgRisk, brand_id: contact.brand_id });
        broadcastSSE("contacts_updated", { brand_id: contact.brand_id });
        if (contact.platform === "messenger" && channelToken) {
          await sendFBMessage(channelToken, contact.platform_user_id, handoffTextLegal);
        } else if (channelToken) {
          await pushLineMessage(contact.platform_user_id, [{ type: "text", text: handoffTextLegal }], channelToken);
        }

        storage.createAiLog({
          contact_id: contact.id,
          brand_id: effectiveBrandId || undefined,
          prompt_summary: `?????: ${userMessage.slice(0, 100)}`,
          knowledge_hits: [],
          tools_called: [],
          transfer_triggered: true,
          transfer_reason: `legal_risk: ${riskCheck.reasons.join(", ")}`,
          result_summary: "??/?????????",
          token_usage: 0,
          model: "risk-detection",
          response_time_ms: Date.now() - startTime,
          reply_source: "high_risk_short_circuit",
          used_llm: 0,
          plan_mode: null,
          reason_if_bypassed: "high_risk",
        });
        return;
      }

      // [已確認無需改動] safe_confirm 模板已傳 contact.brand_id 至 getMetaCommentTemplateByCategory／getMetaPageSettingsList
      const safeConfirmDm = classifyMessageForSafeAfterSale(userMessage);
      if (safeConfirmDm.matched && !isLinkRequestMessage(userMessage)) {
        const categoryByType: Record<string, string> = {
          fraud_impersonation: "fraud_impersonation",
          external_platform: "external_platform_order",
          safe_confirm_order: "safe_confirm_order",
        };
        const tplCategory = categoryByType[safeConfirmDm.type];
        const tpl = metaCommentsStorage.getMetaCommentTemplateByCategory(contact.brand_id ?? undefined, tplCategory);
        const pageList = metaCommentsStorage.getMetaPageSettingsList(contact.brand_id ?? undefined);
        const rawLine = (pageList[0]?.line_after_sale ?? "").trim();
        const lineUrl = rawLine || FALLBACK_AFTER_SALE_LINE_LABEL;
        if (!rawLine) {
          console.warn("[SafeAfterSale] ?? LINE ?????????", { contact_id: contact.id, brand_id: contact.brand_id });
        }
        const replyTextRaw = (tpl as any)?.reply_private || tpl?.reply_first || "";
        const replyText = replyTextRaw.replace(/\{after_sale_line_url\}/g, lineUrl).trim();
        if (replyText) {
          const contactPlatform = platform || contact.platform || "line";
          const aiMsg = storage.createMessage(contact.id, contactPlatform, "ai", replyText);
          broadcastSSE("new_message", { contact_id: contact.id, message: aiMsg, brand_id: contact.brand_id });
          broadcastSSE("contacts_updated", { brand_id: contact.brand_id });
          if (contactPlatform === "messenger" && channelToken) {
            await sendFBMessage(channelToken, contact.platform_user_id, replyText);
          } else if (channelToken) {
            await pushLineMessage(contact.platform_user_id, [{ type: "text", text: replyText }], channelToken);
          }
          if (safeConfirmDm.suggest_human) {
            applyHandoff({ contactId: contact.id, reason: "policy_exception", source: "webhook_safe_confirm_template", brandId: effectiveBrandId || undefined });
            broadcastSSE("contacts_updated", { brand_id: contact.brand_id });
          }
          const recentForCaption = storage.getMessages(contact.id).slice(-6);
          const hadRecentImage = recentForCaption.some(
            (m: { sender_type: string; message_type?: string; content?: string }) =>
              m.sender_type === "user" && (m.message_type === "image" || m.content === "[圖片訊息]" || (m.content && m.content.startsWith("[圖片")))
          );
          const resultSummary = hadRecentImage
            ? `safe_confirm_template: ${tplCategory} | image_clear_caption`
            : `safe_confirm_template: ${tplCategory}`;
          storage.createAiLog({
            contact_id: contact.id,
            message_id: aiMsg.id,
            brand_id: effectiveBrandId || undefined,
            prompt_summary: userMessage.slice(0, 150),
            knowledge_hits: [],
            tools_called: ["safe_confirm_template"],
            transfer_triggered: safeConfirmDm.suggest_human,
            transfer_reason: safeConfirmDm.suggest_human ? `??????(${safeConfirmDm.type})` : undefined,
            result_summary: resultSummary,
            token_usage: 0,
            model: "safe-after-sale-classifier",
            response_time_ms: Date.now() - startTime,
            reply_source: "safe_confirm_template",
            used_llm: 0,
            plan_mode: null,
            reason_if_bypassed: "safe_confirm",
            channel_id: contact.channel_id ?? undefined,
            matched_intent: safeConfirmDm.type || "safe_confirm",
            route_source: "classifier",
            selected_scenario: "AFTER_SALES",
            route_confidence: null,
            tools_available_json: JSON.stringify(["safe_confirm_template"]),
            response_source_trace: "safe_confirm_template",
            phase1_config_ref: isPhase1Active(phase1Flags) ? JSON.stringify({ v: "1.5_safe_confirm" }) : undefined,
          });
        }
        return;
      }

      // ???????????? ? ???????????????????????? webhook ????????
      // ?????????????????????????????????????
      if (detectReturnRefund(userMessage)) {
        if (!contact.issue_type || contact.issue_type !== "return_refund") {
          storage.updateContactIssueType(contact.id, "return_refund");
        }
      }

      const recentUserMsgs = storage.getMessages(contact.id)
        .filter(m => m.sender_type === "user")
        .map(m => m.content);
      const detectedIssue = detectIssueType(recentUserMsgs);
      if (detectedIssue && !contact.issue_type) {
        storage.updateContactIssueType(contact.id, detectedIssue);
      }

      const intentLevel = detectIntentLevel(userMessage, recentUserMsgs);
      storage.updateContactIntentLevel(contact.id, intentLevel);
      const trimmed = userMessage.trim();
      if (/^[\w\-]{5,}$/.test(trimmed) || (/\d{5,}/.test(trimmed) && trimmed.length <= 25)) {
        const orderType = classifyOrderNumber(trimmed);
        storage.updateContactOrderNumberType(contact.id, orderType);
      }
      const currentTags: string[] = JSON.parse(contact.tags || "[]");
      const suggested = suggestTagsFromContent(userMessage, currentTags);
      if (suggested.length > 0) {
        const merged = [...new Set([...currentTags, ...suggested])];
        storage.updateContactTags(contact.id, merged);
      }
      const priority = computeCasePriority(intentLevel, [...currentTags, ...suggested]);
      storage.updateContactCasePriority(contact.id, priority);

      const recentMessages = storage.getMessages(contact.id).slice(-30);
      const recentAiMessages = recentMessages.filter((m) => m.sender_type === "ai").map((m) => m.content || "");
      const lastUserMsg = recentMessages.filter((m) => m.sender_type === "user").pop();
      const lastAiMsg = recentMessages.filter((m) => m.sender_type === "ai").pop();
      const lastMessageAtBySender = lastUserMsg && lastAiMsg
        ? { user: lastUserMsg.created_at, ai: lastAiMsg.created_at }
        : undefined;
      const freshContact = storage.getContact(contact.id) || contact;
      const state = resolveConversationState({
        contact: freshContact,
        userMessage,
        recentUserMessages: recentUserMsgs,
        recentAiMessages,
        lastMessageAtBySender,
      });
      let returnFormUrl = "";
      if (effectiveBrandId) {
        const brandData = storage.getBrand(effectiveBrandId);
        if (brandData?.return_form_url) returnFormUrl = brandData.return_form_url;
      }
      const isReturnFirstRound = (freshContact as any).return_stage == null || (freshContact as any).return_stage === 0;
      const ctxBeforePlan = storage.getActiveOrderContext(contact.id);
      const msgPlan = (userMessage || "").trim();
      const isRefundReturnIntentForPlan = ["refund_or_return", "exchange_request", "cancellation_request"].includes(
        state.primary_intent
      );
      const orderFollowupTurn =
        state.primary_intent === "order_lookup" &&
        !isRefundReturnIntentForPlan &&
        !!(ctxBeforePlan?.order_id && ctxBeforePlan.selected_order_id == null) &&
        !extractOrderIdFromMixedSentence(msgPlan) &&
        ORDER_FOLLOWUP_PATTERNS.test(msgPlan);
      const preHardForPlan =
        isPhase1Active(phase1Flags) && phase1Flags.hybrid_router ? computePhase15HardRoute(userMessage) : null;
      const phase1PreSnapshot =
        preHardForPlan != null
          ? {
              selected_scenario: preHardForPlan.selected_scenario,
              confidence: preHardForPlan.confidence,
              matched_intent: preHardForPlan.matched_intent,
              route_source: preHardForPlan.route_source,
            }
          : null;
      const plan = buildReplyPlan({
        state,
        returnFormUrl,
        isReturnFirstRound,
        orderFollowupTurn,
        latestUserMessage: userMessage,
        phase1PreRoute: isPhase1Active(phase1Flags) && phase1Flags.hybrid_router ? phase1PreSnapshot : null,
      });
      if (!isOrderLookupFamily(plan.mode)) {
        storage.clearActiveOrderContext(contact.id);
      }
      console.log("[AI Latency] contact", contact.id, "after_plan_ms", Date.now() - startTime, "mode=" + plan.mode);

      phase1Route = null;
      if (
        isPhase1Active(phase1Flags) &&
        (phase1Flags.hybrid_router || phase1Flags.scenario_isolation || phase1Flags.tool_whitelist)
      ) {
        const routerInput: HybridRouterInput = {
          userMessage,
          recentUserTexts: recentUserMsgs.slice(-5),
          planMode: plan.mode,
          primaryIntent: state.primary_intent,
          issueType: contact.issue_type,
          apiKey: apiKey?.trim() ?? null,
          preComputedHard:
            phase1Flags.hybrid_router && preHardForPlan != null ? preHardForPlan : undefined,
        };
        phase1Route = phase1Flags.hybrid_router
          ? await runHybridIntentRouter(routerInput)
          : mapPlanToPhase1Scenario(routerInput);
      }

      const computePhase1TraceLogExtras = (responseSourceTrace: string): Record<string, unknown> => {
        if (!isPhase1Active(phase1Flags) || !phase1Flags.trace_v2 || phase1Route == null) {
          return {};
        }
        const hasImageAssets = storage.getImageAssets(effectiveBrandId || undefined).length > 0;
        let names: string[];
        if (phase1Flags.tool_whitelist) {
          let atools = filterToolsForScenario(phase1Route.selected_scenario, {
            hasImageAssets,
            allowAfterSalesOrderVerify: phase1Flags.allow_after_sales_order_verify === true,
          });
          atools = applyScenarioToolOverrides(
            atools,
            phase1Route.selected_scenario,
            phase1Flags.scenario_overrides?.[phase1Route.selected_scenario],
          );
          names = atools.map((t) => (t.type === "function" ? t.function?.name : "") || "").filter(Boolean);
        } else {
          const allT = [...orderLookupTools, ...humanHandoffTools, ...(hasImageAssets ? imageTools : [])];
          names = allT.map((t) => (t.type === "function" ? t.function?.name : "") || "").filter(Boolean);
        }
        return buildPhase1AiLogExtras({
          phase1Flags,
          phase1Route,
          channelId: contact.channel_id,
          toolsAvailableNames: names,
          replySource: responseSourceTrace,
        });
      };

      const phase1OrderDetourOk =
        !isPhase1Active(phase1Flags) || !phase1Route || phase1Route.selected_scenario === "ORDER_LOOKUP";

      if (
        phase1OrderDetourOk &&
        plan.mode !== "handoff" &&
        plan.mode !== "return_form_first" &&
        orderFeatureFlags.orderFastPath
      ) {
        const fpEarly = await tryOrderFastPath({
          userMessage,
          brandId: effectiveBrandId || undefined,
          contactId: contact.id,
          slConfig: getSuperLandingConfig(effectiveBrandId || undefined),
          storage,
          planMode: plan.mode,
          recentUserMessages: recentUserMsgs,
        });
        if (fpEarly) {
          let fpReply = fpEarly.reply;
          if (orderFeatureFlags.orderFinalNormalizer) {
            const ftp = fpEarly.fastPathType;
            const fpMode =
              ftp === "order_followup"
                ? "order_followup"
                : ftp === "ask_for_identifier"
                  ? "general"
                  : "order_lookup";
            const nr = normalizeCustomerFacingOrderReply(fpReply, {
              mode: fpMode,
              replySource: "order_fast_path",
              renderer: ftp ?? undefined,
              platform: contact.platform ?? undefined,
              softHumanize: fpMode === "order_lookup" || fpMode === "order_followup",
            });
            fpReply = nr.text;
            if (orderFeatureFlags.orderLatencyV2) {
              console.log(
                `final_normalizer_changed=${nr.changed} normalizer_rules=${nr.rulesHit.length ? nr.rulesHit.join("|") : "none"}`
              );
            }
          }
          console.log(
            `[order_fast_path_hit=true] fast_path_type=${fpEarly.fastPathType} used_llm=0 contact=${contact.id}`
          );
          const contactPlatformFp = platform || contact.platform || "line";
          const aiMsgFp = storage.createMessage(contact.id, contactPlatformFp, "ai", fpReply);
          broadcastSSE("new_message", { contact_id: contact.id, message: aiMsgFp, brand_id: contact.brand_id });
          broadcastSSE("contacts_updated", { brand_id: contact.brand_id });
          if (contactPlatformFp === "messenger" && channelToken) {
            await sendFBMessage(channelToken, contact.platform_user_id, fpReply);
          } else if (channelToken) {
            await pushLineMessage(contact.platform_user_id, [{ type: "text", text: fpReply }], channelToken);
          }
          storage.createAiLog({
            contact_id: contact.id,
            message_id: aiMsgFp.id,
            brand_id: effectiveBrandId || undefined,
            prompt_summary: `order_fast_path:${fpEarly.fastPathType}:${(userMessage || "").slice(0, 60)}`,
            knowledge_hits: [],
            tools_called: ["order_fast_path"],
            transfer_triggered: false,
            result_summary: `fast_path_${fpEarly.fastPathType}`,
            token_usage: 0,
            model: "order_fast_path",
            response_time_ms: Date.now() - startTime,
            reply_source: "order_fast_path",
            used_llm: 0,
            plan_mode: plan.mode,
            reason_if_bypassed: `order_fast_path:${fpEarly.fastPathType}`,
            used_first_llm: 0,
            used_second_llm: 0,
            reply_renderer: "order_fast_path",
            prompt_profile: String(plan.mode || ""),
            first_customer_visible_reply_ms: Date.now() - startTime,
            lookup_ack_sent_ms: null,
            queue_wait_ms: queueWaitMs,
            ...computePhase1TraceLogExtras("order_fast_path"),
          });
          return;
        }
      }

      function isUserProvidingOrderDetails(lastAiMessage: string | null | undefined, currentUserMessage: string): boolean {
        if (!lastAiMessage || !ASK_ORDER_PHONE_FOR_BYPASS_KW.some((k) => lastAiMessage.includes(k))) return false;
        const trimmed = (currentUserMessage || "").trim();
        if (trimmed.length >= 30) return false;
        if (isHumanRequestMessage(trimmed)) return false;
        return true;
      }

      const userTextClean = (userMessage || "").replace(/[^A-Za-z0-9]/g, "");
      const isLikelyOrderNumber =
        /^\d{15,22}$/.test(userTextClean) || /^[A-Za-z0-9\-]{5,15}$/.test(userTextClean);

      const awkwardCheck = isLikelyOrderNumber
        ? { shouldHandoff: false as const }
        : shouldHandoffDueToAwkwardOrRepeat({
            userMessage,
            recentMessages: recentMessages.map((m: any) => ({ sender_type: m.sender_type, content: m.content })),
            primaryIntentOrderLookup: state.primary_intent === "order_lookup",
          });
      const activeCtxForBypass = isOrderLookupFamily(plan.mode) ? storage.getActiveOrderContext(contact.id) : null;
      const isOrderFollowUpForBypass = activeCtxForBypass && (
        ORDER_FOLLOWUP_PATTERNS.test((userMessage || "").trim()) ||
        looksLikeOrderIdInput((userMessage || "").trim())
      );
      const skipAwkwardHandoffDueToActiveOrder = !!(isOrderFollowUpForBypass && activeCtxForBypass?.one_page_summary);
      if (awkwardCheck.shouldHandoff && !skipAwkwardHandoffDueToActiveOrder && !isUserProvidingOrderDetails(lastAiMsg?.content ?? null, userMessage || "")) {
        console.log("[Webhook AI] needs_human=1 source=awkward_repeat reason=" + (awkwardCheck.reason ?? "unknown") + " msg=" + (userMessage || "").slice(0, 60));
        storage.updateContactConversationFields(contact.id, { product_scope_locked: null, customer_goal_locked: null });
        applyHandoff({ contactId: contact.id, reason: "awkward_repeat", source: "webhook_awkward_repeat", brandId: effectiveBrandId || undefined });
        const assignedIdAwk = assignment.assignCase(contact.id);
        if (assignedIdAwk == null && assignment.isAllAgentsUnavailable()) {
          const tags = JSON.parse(contact.tags || "[]");
          if (!tags.includes("待指派")) storage.updateContactTags(contact.id, [...tags, "待指派"]);
          storage.updateContactNeedsAssignment(contact.id, 1);
          storage.createMessage(contact.id, contact.platform, "system", getTransferUnavailableSystemMessage(assignment.getUnavailableReason()));
        }
        const handoffReplyAwk = buildHandoffReply({ customerEmotion: state.customer_emotion, brandId: effectiveBrandId || undefined });
        const handoffTextAwk = getHandoffReplyForCustomer(handoffReplyAwk, assignment.getUnavailableReason());
        const contactPlatformAwk = platform || contact.platform || "line";
        const aiMsgAwk = storage.createMessage(contact.id, contactPlatformAwk, "ai", handoffTextAwk);
        broadcastSSE("new_message", { contact_id: contact.id, message: aiMsgAwk, brand_id: effectiveBrandId || contact.brand_id });
        broadcastSSE("contacts_updated", { brand_id: contact.brand_id });
        if (contactPlatformAwk === "messenger" && channelToken) {
          await sendFBMessage(channelToken, contact.platform_user_id, handoffTextAwk);
        } else if (channelToken) {
          await pushLineMessage(contact.platform_user_id, [{ type: "text", text: handoffTextAwk }], channelToken);
        }
        storage.createAiLog({
          contact_id: contact.id,
          message_id: aiMsgAwk.id,
          brand_id: effectiveBrandId || undefined,
          prompt_summary: `awkward_repeat_handoff: ${awkwardCheck.reason ?? "unknown"} - ${userMessage.slice(0, 60)}`,
          knowledge_hits: [],
          tools_called: ["awkward_repeat_handoff"],
          transfer_triggered: true,
          transfer_reason: `??/??: ${awkwardCheck.reason ?? "unknown"}`,
          result_summary: "??????????",
          token_usage: 0,
          model: "reply-plan",
          response_time_ms: Date.now() - startTime,
          reply_source: "handoff",
          used_llm: 0,
          plan_mode: plan.mode,
          reason_if_bypassed: `awkward_repeat: ${awkwardCheck.reason ?? "unknown"}`,
          ...computePhase1TraceLogExtras("handoff"),
        });
        return;
      }

      // Hotfix?handoff ??? ? ?? plan ? handoff????????????? LLM???????????????
      if (plan.mode === "handoff") {
        console.log("[Webhook AI] needs_human=1 source=state_resolver reason=" + (state.human_reason ?? "handoff") + " msg=" + (userMessage || "").slice(0, 60));
        storage.updateContactConversationFields(contact.id, { product_scope_locked: null, customer_goal_locked: null });
        (() => { const { reason, reason_detail } = normalizeHandoffReason(state.human_reason ?? "return_stage_3_insist"); applyHandoff({ contactId: contact.id, reason, reason_detail, source: "webhook_plan_handoff", brandId: effectiveBrandId || undefined }); })();
        const assignedId = assignment.assignCase(contact.id);
        if (assignedId == null && assignment.isAllAgentsUnavailable()) {
          storage.updateContactNeedsAssignment(contact.id, 1);
          const tags = JSON.parse(contact.tags || "[]");
          if (!tags.includes("待指派")) {
            storage.updateContactTags(contact.id, [...tags, "待指派"]);
          }
          const reason = assignment.getUnavailableReason();
          storage.createMessage(contact.id, contact.platform, "system", getTransferUnavailableSystemMessage(reason));
        }
        const recentMessagesForHandoff = storage.getMessages(contact.id).slice(-12).map((m: any) => ({ sender_type: m.sender_type, content: m.content, message_type: m.message_type, image_url: m.image_url }));
        const orderInfoInRecent = searchOrderInfoInRecentMessages(recentMessagesForHandoff);
        const handoffReply = buildHandoffReply({
          customerEmotion: state.customer_emotion,
          humanReason: state.human_reason ?? undefined,
          isOrderLookupContext: ORDER_LOOKUP_PATTERNS.test(userMessage),
          hasOrderInfo: !!orderInfoInRecent.orderId,
          brandId: effectiveBrandId || undefined,
        });
        const unavailableReason = assignment.getUnavailableReason();
        const handoffTextToSend = getHandoffReplyForCustomer(handoffReply, unavailableReason);
        const contactPlatform = platform || contact.platform || "line";
        const aiMsg = storage.createMessage(contact.id, contactPlatform, "ai", handoffTextToSend);
        broadcastSSE("new_message", { contact_id: contact.id, message: aiMsg, brand_id: effectiveBrandId || contact.brand_id });
        broadcastSSE("contacts_updated", { brand_id: contact.brand_id });
        if (contactPlatform === "messenger" && channelToken) {
          await sendFBMessage(channelToken, contact.platform_user_id, handoffTextToSend);
        } else if (channelToken) {
          await pushLineMessage(contact.platform_user_id, [{ type: "text", text: handoffTextToSend }], channelToken);
        }
        storage.createAiLog({
          contact_id: contact.id,
          message_id: aiMsg.id,
          brand_id: effectiveBrandId || undefined,
          prompt_summary: `handoff_short_circuit: ${userMessage.slice(0, 80)}`,
          knowledge_hits: [],
          tools_called: ["handoff_short_circuit"],
          transfer_triggered: true,
          transfer_reason: state.human_reason || "explicit_human_request",
          result_summary: "??????????????",
          token_usage: 0,
          model: "reply-plan",
          response_time_ms: Date.now() - startTime,
          reply_source: "handoff",
          used_llm: 0,
          plan_mode: "handoff",
          reason_if_bypassed: "handoff_short_circuit",
          ...computePhase1TraceLogExtras("handoff"),
        });
        return;
      }

      // ???????off_topic_guard ???????????????????? systemPrompt ????????? LLM?

      // Phase 2 product_scope_locked?handoff/off_topic ???order_lookup/answer_directly ?????????
      if ((plan.mode as ReplyPlanMode) === "handoff") {
        storage.updateContactConversationFields(contact.id, { product_scope_locked: null, customer_goal_locked: "handoff" });
      } else if (plan.mode === "off_topic_guard") {
        storage.updateContactConversationFields(contact.id, { product_scope_locked: null, customer_goal_locked: null });
      } else if (isOrderLookupFamily(plan.mode) || plan.mode === "answer_directly") {
        if (isOrderLookupFamily(plan.mode)) {
          storage.updateContactConversationFields(contact.id, { customer_goal_locked: "order_lookup" });
        }
      }
      let goalLocked: string | null = null;
      const planMode = plan.mode as ReplyPlanMode;
      if (planMode === "return_form_first" || planMode === "return_stage_1") {
        goalLocked = "return";
        storage.updateContactConversationFields(contact.id, { customer_goal_locked: "return" });
      } else if (planMode === "handoff") {
        goalLocked = "handoff";
      } else if (isOrderLookupFamily(planMode)) {
        goalLocked = "order_lookup";
      } else if (plan.mode === "off_topic_guard") {
        goalLocked = null;
      } else {
        goalLocked = (contact as any)?.customer_goal_locked ?? null;
      }

      const effectiveScope = state.product_scope_locked || null;

      const recentUserHasImage = recentMessages
        .slice(-10)
        .some(
          (m: { sender_type?: string; message_type?: string; image_url?: string | null }) =>
            m.sender_type === "user" &&
            (m.message_type === "image" || !!(m.image_url && String(m.image_url).trim()))
        );
      const scenarioIso =
        isPhase1Active(phase1Flags) && phase1Flags.scenario_isolation && phase1Route != null;
      const enrichedPack = await assembleEnrichedSystemPrompt(contact.brand_id || brandId || undefined, {
        planMode: plan.mode,
        userMessage,
        hasActiveOrderContext: !!storage.getActiveOrderContext(contact.id)?.order_id,
        recentUserHasImage,
        selectedScenario: phase1Route != null ? phase1Route.selected_scenario : undefined,
        scenarioIsolationEnabled: scenarioIso,
        logisticsHintOverride: phase1Flags.logistics_hint_override,
        scenarioOverrides: isPhase1Active(phase1Flags) ? phase1Flags.scenario_overrides : undefined,
      });
      console.log(
        `[prompt_profile=${enrichedPack.prompt_profile}] prompt_chars=${enrichedPack.prompt_chars} catalog_included=${enrichedPack.includes.catalog} knowledge_included=${enrichedPack.includes.knowledge} image_included=${enrichedPack.includes.image} prompt_sections=${enrichedPack.sections.map((s) => s.key).join("|")} prompt_assembly_ms=${Date.now() - startTime}`
      );
      let systemPrompt = enrichedPack.full_prompt;
      const contactDisplayName = sanitizeContactDisplayName(contact?.display_name || "");
      if (contactDisplayName) {
        systemPrompt += `\n\n【這位客人的稱呼】${contactDisplayName}\n（開場時自然帶一次就好，用你自己的語氣和風格稱呼，不要制式。之後不用重複叫名字。如果稱呼看起來不太對勁就直接說「你好」。）`;
      }
      if (goalLocked) {
        systemPrompt += appendGoalLockedBlock(goalLocked);
      }
      if (planMode === "handoff") {
        systemPrompt += appendHandoffModeBlock();
      }
      if (planMode === "off_topic_guard") {
        systemPrompt += appendOffTopicGuardBlock();
      }
      if (plan.must_not_include && plan.must_not_include.length > 0) {
        systemPrompt += appendMustNotIncludeBlock(plan.must_not_include);
      }
      if (shouldNotLeadWithOrderLookup(plan, state)) {
        systemPrompt += appendNoOrderLookupLeadBlock();
      }
      if (phase1OrderDetourOk && isOrderLookupFamily(plan.mode)) {
        const activeCtx = storage.getActiveOrderContext(contact.id);
        const msgTrim = (userMessage || "").trim();
        const CLEAR_ACTIVE_ORDER_KW = [
          "不查了", "不要了", "取消", "結案", "沒有了", "完成", "設變",
          "查別筆", "我要查別筆", "換一筆", "重查", "重新查",
          "不是這筆", "不是這張單", "我不是問這筆", "我在問別張",
          "換另一筆", "查另一張", "另外一筆", "不是這張", "重查一下",
        ];
        if (activeCtx && CLEAR_ACTIVE_ORDER_KW.some((k) => msgTrim.includes(k))) {
          storage.clearActiveOrderContext(contact.id);
        }
        const isOrderFollowUp = activeCtx && (
          ORDER_FOLLOWUP_PATTERNS.test(msgTrim) ||
          looksLikeOrderIdInput(msgTrim)
        );
        if (activeCtx?.one_page_summary && isOrderFollowUp) {
          systemPrompt += "\n\n【目前已查到的訂單摘要，回覆時可引用】\n\n" + activeCtx.one_page_summary;
        }
        /** P0：查單政策改由 DB system_prompt／品牌設定承載，不再注入硬編碼 XML 污染上下文 */
      }
      if (isModeNoPromo(plan.mode)) {
        systemPrompt += appendNoPromoExtensionBlock(plan.mode);
      }
      // Hotfix????????? ? ?????1. ???? 2. ???? vision 3. linked order???????????
      if (isAlreadyProvidedMessage(userMessage)) {
        const openaiForSearch = apiKey ? new OpenAI({ apiKey }) : null;
        const found = await searchOrderInfoThreeLayers(contact.id, recentMessages, {
          imageFileToDataUri,
          openai: openaiForSearch,
        });
        if (!found || (!found.orderId && !found.phone)) {
          const contactPlatform = platform || contact.platform || "line";
          const alreadyHandoffText = getHandoffReplyForCustomer(HANDOFF_MANDATORY_OPENING, assignment.getUnavailableReason());
          const aiMsg = storage.createMessage(contact.id, contactPlatform, "ai", alreadyHandoffText);
          broadcastSSE("new_message", { contact_id: contact.id, message: aiMsg, brand_id: effectiveBrandId || contact.brand_id });
          broadcastSSE("contacts_updated", { brand_id: contact.brand_id });
          if (contactPlatform === "messenger" && channelToken) {
            await sendFBMessage(channelToken, contact.platform_user_id, alreadyHandoffText);
          } else if (channelToken) {
            await pushLineMessage(contact.platform_user_id, [{ type: "text", text: alreadyHandoffText }], channelToken);
          }
          console.log("[Webhook AI] needs_human=1 source=already_provided_not_found msg=" + (userMessage || "").slice(0, 60));
          applyHandoff({ contactId: contact.id, reason: "repeat_unresolved", source: "webhook_already_provided_not_found", brandId: effectiveBrandId || undefined });
          assignment.assignCase(contact.id);
          storage.createAiLog({
            contact_id: contact.id,
            message_id: aiMsg.id,
            brand_id: effectiveBrandId || undefined,
            prompt_summary: `already_provided_not_found: ${userMessage.slice(0, 60)}`,
            knowledge_hits: [],
            tools_called: ["already_provided_handoff"],
            transfer_triggered: true,
            transfer_reason: "查無訂單且客人已提供資訊，轉人工",
            result_summary: "查無訂單，已轉人工",
            token_usage: 0,
            model: "reply-plan",
            response_time_ms: Date.now() - startTime,
            reply_source: "handoff",
            used_llm: 0,
            plan_mode: plan.mode,
            reason_if_bypassed: "already_provided_not_found",
            ...computePhase1TraceLogExtras("handoff"),
          });
          return;
        }
        const clueParts: string[] = [];
        if (found.orderId) clueParts.push(`訂單編號：${found.orderId}`);
        if (found.phone) clueParts.push(`電話：${found.phone}`);
        systemPrompt += appendAlreadyProvidedCluesBlock(clueParts);
      }
      /** Phase 2.2 / 2.4：多筆候選（篩選、第 N 筆、最新／最早、日期、帶出明細） */
      if (phase1OrderDetourOk && isOrderLookupFamily(plan.mode)) {
        const multiFollow = storage.getActiveOrderContext(contact.id);
        const msgM = (userMessage || "").trim();
        if (multiFollow?.active_order_candidates && (multiFollow.candidate_count ?? 0) > 1) {
          let multiAns: string | null = null;
          const sortedC = sortCandidatesNewestFirst(multiFollow.active_order_candidates);
          type PickCand = (typeof sortedC)[number];
          let pickResolve: PickCand | null = null;

          if (
            /只看.*成功|哪.*成功|成功.*哪|哪一筆.*成功|付款成功/.test(msgM) &&
            !/失敗|未成立/.test(msgM)
          ) {
            const succ = sortedC.filter((c) => c.payment_status === "success");
            multiAns =
              succ.length === 0
                ? "這幾筆裡沒有顯示為付款成功的訂單；要查某筆請貼訂單編號。"
                : succ.length === 1
                  ? `付款成功的是 **${succ[0].order_id}**，下面幫您帶出明細。`
                  : `付款成功的單號：${succ.map((s) => s.order_id).join("、")}。告訴我要看哪一筆（或貼單號）。`;
            if (succ.length === 1) pickResolve = succ[0];
          } else if (
            (/還有.*訂單|另外幾筆|其他訂單|全部訂單|重新列出|再列一次/.test(msgM) || /^全部/.test(msgM)) &&
            multiFollow.one_page_summary
          ) {
            multiAns = multiFollow.one_page_summary;
          } else if (
            (/只看.*失敗|哪.*失敗|失敗的|未成立/.test(msgM) || /付款失敗/.test(msgM)) &&
            !/成功/.test(msgM)
          ) {
            const fail = sortedC.filter((c) => c.payment_status === "failed");
            multiAns =
              fail.length === 0
                ? "這幾筆沒有標示為付款失敗的訂單。"
                : fail.length === 1
                  ? `未成立的是 **${fail[0].order_id}**，下面幫您帶出明細。`
                  : `未成立／失敗單號：${fail.map((f) => f.order_id).join("、")}。`;
            if (fail.length === 1) pickResolve = fail[0];
          } else if (/只看.*貨到|貨到付款|只看.*到收/.test(msgM)) {
            const cod = sortedC.filter((c) => c.payment_status === "cod");
            multiAns =
              cod.length === 0
                ? "這幾筆沒有貨到付款的訂單。"
                : cod.length === 1
                  ? `貨到付款的是 **${cod[0].order_id}**，下面幫您帶出明細。`
                  : `貨到付款單號：${cod.map((c) => c.order_id).join("、")}。`;
            if (cod.length === 1) pickResolve = cod[0];
          } else if (/只看.*官網|官網的|SHOPLINE/.test(msgM) && !/一頁/.test(msgM)) {
            const f = filterCandidatesBySource(sortedC, "shopline");
            if (f.length === 0) multiAns = "清單內沒有官網訂單。";
            else if (f.length === 1) {
              pickResolve = f[0];
              multiAns = `官網這筆 **${f[0].order_id}**，下面幫您帶出明細。`;
            } else
              multiAns = `官網訂單：${f.map((x) => x.order_id).join("、")}。要查哪一筆請貼單號。`;
          } else if (/只看.*一頁|一頁商店|粉絲團.*訂單/.test(msgM) && !/官網/.test(msgM)) {
            const f = filterCandidatesBySource(sortedC, "superlanding");
            if (f.length === 0) multiAns = "清單內沒有一頁商店訂單。";
            else if (f.length === 1) {
              pickResolve = f[0];
              multiAns = `一頁商店這筆 **${f[0].order_id}**，下面幫您帶出明細。`;
            } else
              multiAns = `一頁商店訂單：${f.map((x) => x.order_id).join("、")}。要查哪一筆請貼單號。`;
          } else if (/只看.*待付|待付款的|哪.*待付/.test(msgM) && !/成功/.test(msgM)) {
            const pend = sortedC.filter((x) => x.payment_status === "pending");
            multiAns =
              pend.length === 0
                ? "這幾筆沒有待付款的訂單。"
                : pend.length === 1
                  ? `待付款的是 **${pend[0].order_id}**，下面幫您帶出明細。`
                  : `待付款單號：${pend.map((p) => p.order_id).join("、")}。`;
            if (pend.length === 1) pickResolve = pend[0];
          } else if (/最新那筆|最近.*筆|最後.*下單/.test(msgM) && !/最早|最舊/.test(msgM)) {
            pickResolve = pickLatestCandidate(sortedC) ?? null;
            multiAns = pickResolve ? `最新一筆是 **${pickResolve.order_id}**，下面幫您帶出明細。` : null;
          } else if (/最早那筆|最舊|第一筆下單/.test(msgM)) {
            pickResolve = pickEarliestCandidate(sortedC) ?? null;
            multiAns = pickResolve ? `最早一筆是 **${pickResolve.order_id}**，下面幫您帶出明細。` : null;
          } else if (/\d{4}\D\d{1,2}\D\d{1,2}/.test(msgM)) {
            const byDate = pickCandidateByOrderDate(sortedC, msgM);
            if (byDate) {
              pickResolve = byDate;
              multiAns = `**${byDate.order_id}** 符合您說的日期，下面幫您帶出明細。`;
            }
          } else if (
            /第\s*\d+\s*筆|第[123一二三四五]\s*筆|第一筆|第二筆|第三筆|第1筆|第2筆|第3筆/.test(msgM)
          ) {
            let rank = 0;
            const mNum = msgM.match(/第\s*(\d+)\s*筆/);
            if (mNum) rank = parseInt(mNum[1], 10);
            else if (/第一筆|第1筆/.test(msgM)) rank = 1;
            else if (/第二筆|第2筆/.test(msgM)) rank = 2;
            else if (/第三筆|第3筆/.test(msgM)) rank = 3;
            else if (/第四筆|第4筆/.test(msgM)) rank = 4;
            else if (/第五筆|第5筆/.test(msgM)) rank = 5;
            if (rank >= 1) {
              if (rank > sortedC.length) {
                multiAns = `目前清單只有 ${sortedC.length} 筆，沒有第 ${rank} 筆。`;
              } else {
                pickResolve = sortedC[rank - 1];
                multiAns = `第 ${rank} 筆是 **${pickResolve.order_id}**，下面幫您帶出明細。`;
              }
            }
          }

          const bid = effectiveBrandId;
          const slCfgEarly = getSuperLandingConfig(bid || undefined);
          if (pickResolve && bid && multiAns) {
            const res = await unifiedLookupById(
              slCfgEarly,
              pickResolve.order_id.toUpperCase(),
              bid,
              undefined,
              false
            );
            if (res.found && res.orders[0]) {
              const o = res.orders[0];
              const st = getUnifiedStatusLabel(o.status, o.source || res.source);
              const pk = payKindForOrder(o, st, o.source || res.source);
              const onePagePayload = {
                order_id: o.global_order_id,
                status: st,
                amount: o.final_total_order_amount,
                product_list: o.product_list,
                buyer_name: o.buyer_name,
                buyer_phone: o.buyer_phone,
                address: o.address,
                full_address: o.full_address,
                cvs_brand: o.cvs_brand,
                cvs_store_name: o.cvs_store_name,
                delivery_target_type: o.delivery_target_type,
                tracking_number: o.tracking_number,
                created_at: o.created_at,
                shipped_at: o.shipped_at,
                shipping_method: o.shipping_method,
                payment_method: o.payment_method,
                payment_status_label: pk.label,
              };
              const onePage = formatOrderOnePage(onePagePayload);
              multiAns = `${multiAns}\n${onePage}`;
              const baseCtx = buildActiveOrderContextFromOrder(o, res.source, st, onePage, "text");
              storage.setActiveOrderContext(contact.id, {
                ...baseCtx,
                candidate_count: multiFollow.candidate_count,
                active_order_candidates: multiFollow.active_order_candidates,
                last_lookup_source: multiFollow.last_lookup_source,
                aggregate_payment_summary: multiFollow.aggregate_payment_summary,
                one_page_summary: multiFollow.one_page_summary,
                candidate_source_summary: multiFollow.candidate_source_summary,
                successful_order_ids: multiFollow.successful_order_ids,
                failed_order_ids: multiFollow.failed_order_ids,
                pending_order_ids: multiFollow.pending_order_ids,
                cod_order_ids: multiFollow.cod_order_ids,
                selected_order_id: o.global_order_id,
                selected_order_rank: (() => {
                  const i = sortedC.findIndex((x) => x.order_id === o.global_order_id);
                  return i >= 0 ? i + 1 : null;
                })(),
              });
              storage.linkOrderForContact(contact.id, o.global_order_id, "ai_lookup");
              console.log(
                `[multi_order_resolve] order=${o.global_order_id} source_hit=lookup brand=${bid}`
              );
            }
          } else if (pickResolve && multiAns && !bid) {
            multiAns = `${multiAns.replace("下面幫您帶出明細。", "")}請再傳一次完整訂單編號查詢。`;
          }

          if (multiAns) {
            if (orderFeatureFlags.orderFinalNormalizer) {
              const normM = normalizeCustomerFacingOrderReply(multiAns, {
                mode: "order_lookup",
                replySource: "multi_order_router",
                renderer: "multi_order_router",
                platform: contact.platform ?? undefined,
                softHumanize: true,
              });
              multiAns = normM.text;
              console.log(
                `final_normalizer_changed=${normM.changed} normalizer_rules=${normM.rulesHit.length ? normM.rulesHit.join("|") : "none"}`
              );
            } else {
              console.log("final_normalizer_changed=false normalizer_rules=disabled_flag");
            }
            const contactPlatformM = platform || contact.platform || "line";
            const aiMsgM = storage.createMessage(contact.id, contactPlatformM, "ai", multiAns);
            broadcastSSE("new_message", { contact_id: contact.id, message: aiMsgM, brand_id: contact.brand_id });
            broadcastSSE("contacts_updated", { brand_id: contact.brand_id });
            if (channelToken && contactPlatformM === "messenger") {
              await sendFBMessage(channelToken, contact.platform_user_id, multiAns);
            } else if (channelToken) {
              await pushLineMessage(contact.platform_user_id, [{ type: "text", text: multiAns }], channelToken);
            }
            storage.createAiLog({
              contact_id: contact.id,
              message_id: aiMsgM.id,
              brand_id: effectiveBrandId || undefined,
              prompt_summary: `multi_order_followup: ${msgM.slice(0, 40)}`,
              knowledge_hits: [],
              tools_called: [],
              transfer_triggered: false,
              result_summary: "multi_order_deterministic",
              token_usage: 0,
              model: "multi_order_router",
              response_time_ms: Date.now() - startTime,
              reply_source: "multi_order_router",
              used_llm: 0,
              plan_mode: plan.mode,
              used_first_llm: 0,
              used_second_llm: 0,
              reply_renderer: "multi_order_router",
              prompt_profile: "na",
              first_customer_visible_reply_ms: Date.now() - startTime,
              lookup_ack_sent_ms: null,
              queue_wait_ms: queueWaitMs,
              ...computePhase1TraceLogExtras("multi_order_router"),
            });
            return;
          }
        }
      }
      /** Phase 2.9：單筆 context 下問「還有其他訂單／全部訂單」→ 依手機重查並展開多筆 */
      if (phase1OrderDetourOk && isOrderLookupFamily(plan.mode)) {
        const act29 = storage.getActiveOrderContext(contact.id);
        const msg29 = (userMessage || "").trim();
        const PHASE29_MORE_ORDERS_KW = [
          "其他訂單",
          "還有訂單",
          "還有其他",
          "全部訂單",
          "另外幾筆",
          "其他筆",
          "有多少筆",
          "幾筆訂單",
          "幾個訂單",
          "我有幾個訂單",
          "我有幾筆",
          "其他訂單嗎",
          "還有嗎",
          "還有幾筆",
        ];
        const bid29 = effectiveBrandId || contact.brand_id;
        if (
          bid29 &&
          act29?.order_id &&
          act29.receiver_phone &&
          (!act29.candidate_count || act29.candidate_count <= 1) &&
          PHASE29_MORE_ORDERS_KW.some((k) => msg29.includes(k))
        ) {
          const onlyOfficial = /只看\s*官網|只要\s*官網|官網的/.test(msg29);
          const onlySl = /只看\s*一頁|只要\s*一頁|銷售頁/.test(msg29);
          const prefer29: "shopline" | "superlanding" | undefined = onlyOfficial
            ? "shopline"
            : onlySl
              ? "superlanding"
              : undefined;
          const slCfg29 = getSuperLandingConfig(bid29);
          try {
            const result29 = await unifiedLookupByPhoneGlobal(
              slCfg29,
              act29.receiver_phone,
              bid29,
              prefer29,
              false,
              true
            );
            if (result29.orders.length > 1) {
              const src29 =
                result29.source === "shopline" || result29.source === "superlanding"
                  ? result29.source
                  : "superlanding";
              const packed29 = packDeterministicMultiOrderToolResult({
                orders: result29.orders,
                orderSource: src29,
                headerLine: "依您留的手機再查了一次",
                contactId: contact.id,
                storage,
                matchedBy: "text",
                renderer: "phase29_more_orders_expand",
              });
              let reply29 = String((packed29 as { deterministic_customer_reply?: string }).deterministic_customer_reply || "");
              if (orderFeatureFlags.orderFinalNormalizer) {
                const nr29 = normalizeCustomerFacingOrderReply(reply29, {
                  mode: "order_lookup",
                  replySource: "phase29_expand",
                  renderer: "phase29_more_orders_expand",
                  platform: contact.platform ?? undefined,
                  softHumanize: true,
                });
                reply29 = nr29.text;
              }
              const plat29 = platform || contact.platform || "line";
              const ai29 = storage.createMessage(contact.id, plat29, "ai", reply29);
              broadcastSSE("new_message", { contact_id: contact.id, message: ai29, brand_id: effectiveBrandId || contact.brand_id });
              broadcastSSE("contacts_updated", { brand_id: contact.brand_id });
              if (channelToken && plat29 === "messenger") {
                await sendFBMessage(channelToken, contact.platform_user_id, reply29);
              } else if (channelToken) {
                await pushLineMessage(contact.platform_user_id, [{ type: "text", text: reply29 }], channelToken);
              }
              storage.createAiLog({
                contact_id: contact.id,
                message_id: ai29.id,
                brand_id: effectiveBrandId || undefined,
                prompt_summary: `phase29_more_orders: ${msg29.slice(0, 50)}`,
                knowledge_hits: [],
                tools_called: ["phase29_expand_phone"],
                transfer_triggered: false,
                result_summary: `n=${result29.orders.length}`,
                token_usage: 0,
                model: "phase29_expand",
                response_time_ms: Date.now() - startTime,
                reply_source: "deterministic_tool",
                used_llm: 0,
                plan_mode: plan.mode,
                used_first_llm: 0,
                used_second_llm: 0,
                reply_renderer: "phase29_more_orders_expand",
                prompt_profile: "na",
                first_customer_visible_reply_ms: Date.now() - startTime,
                lookup_ack_sent_ms: null,
                queue_wait_ms: queueWaitMs,
                ...computePhase1TraceLogExtras("deterministic_tool"),
              });
              return;
            }
          } catch (e29) {
            console.warn("[phase29_more_orders_expand]", (e29 as Error)?.message || e29);
          }
        }
      }

      if (plan.mode === "return_form_first") {
        const returnFormRules = `

--- 本輪強制規則（return_form_first）---
你現在要處理顧客的退換貨或售後問題。請依以下順序回覆，不可省略：
1. 第一句：先道歉並表示理解（例：「不好意思，讓您有這樣的困擾」「了解您的情況」）
2. 第二句：告知會協助處理，引導填寫退換貨表單
${returnFormUrl ? `3. 附上表單連結：${returnFormUrl}` : "3. 告知會由專人進一步協助確認流程"}
4. 最後一句：可補充「填好後我們專人會盡快與您聯繫」

嚴格禁止：
- 不可答應直接退款（要說「會由專人確認後續流程」）
- 不可說「若為其他平台購買請洽該平台」
- 不可先查訂單再給表單（這輪主流程是表單）
- 不可超過 4 句話
- 語氣要自然、有溫度，像你平常說話的風格
`;
        const returnFormSystemPrompt = systemPrompt + returnFormRules;
        const returnFormFallback =
          `了解，這邊先協助您處理。請先填寫退換貨表單，我們會盡快為您處理。${returnFormUrl ? `\n表單連結：${returnFormUrl}` : ""}\n填寫完成後專人會與您聯繫。`;

        const recent10Rf = storage.getMessages(contact.id).slice(-10);
        const histRf: AiMessage[] = [];
        for (const msg of recent10Rf) {
          if (msg.sender_type === "system") continue;
          if (msg.sender_type === "user") {
            histRf.push({ role: "user", content: String(msg.content ?? "") });
          } else if (msg.sender_type === "ai" || msg.sender_type === "admin") {
            histRf.push({ role: "assistant", content: String(msg.content ?? "") });
          }
        }
        const rfMessages: AiMessage[] = [{ role: "system", content: returnFormSystemPrompt }, ...histRf];

        let returnFormReply = returnFormFallback;
        let rfTokens = 0;
        try {
          const rfResolved = resolveModelWithBrandOverride(phase1ModelOverride);
          if (rfResolved.provider === "anthropic" || rfResolved.provider === "google") {
            const rfRes = await callAiModel({
              messages: rfMessages,
              maxTokens: 300,
              temperature: 0.85,
              modelOverride: phase1ModelOverride,
            });
            rfTokens = rfRes.inputTokens + rfRes.outputTokens;
            const t = (rfRes.content || "").trim();
            if (t) returnFormReply = t;
          } else {
            const openaiRf = new OpenAI({ apiKey: apiKey.trim() });
            const comp = await openaiRf.chat.completions.create({
              model: rfResolved.model,
              messages: rfMessages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
              max_completion_tokens: 300,
              temperature: 0.85,
            });
            rfTokens = (comp.usage?.prompt_tokens ?? 0) + (comp.usage?.completion_tokens ?? 0);
            const t = (comp.choices[0]?.message?.content || "").trim();
            if (t) returnFormReply = t;
          }
        } catch (rfErr) {
          console.error("[return_form_first] LLM failed, using fallback:", rfErr);
          returnFormReply = returnFormFallback;
        }

        storage.updateContactConversationFields(contact.id, {
          return_stage: 1,
          resolution_status: "awaiting_customer",
          waiting_for_customer: "return_form_submit",
        });
        const contactPlatformRf = platform || contact.platform || "line";
        const aiMsgRf = storage.createMessage(contact.id, contactPlatformRf, "ai", returnFormReply);
        broadcastSSE("new_message", { contact_id: contact.id, message: aiMsgRf, brand_id: effectiveBrandId || contact.brand_id });
        broadcastSSE("contacts_updated", { brand_id: contact.brand_id });
        if (contactPlatformRf === "messenger" && channelToken) {
          await sendFBMessage(channelToken, contact.platform_user_id, returnFormReply);
        } else if (channelToken) {
          await pushLineMessage(contact.platform_user_id, [{ type: "text", text: returnFormReply }], channelToken);
        }
        storage.createAiLog({
          contact_id: contact.id,
          message_id: aiMsgRf.id,
          brand_id: effectiveBrandId || undefined,
          prompt_summary: `return_form_first: ${userMessage.slice(0, 80)}`,
          knowledge_hits: [],
          tools_called: ["return_form_first"],
          transfer_triggered: false,
          result_summary: returnFormReply.slice(0, 200),
          token_usage: rfTokens,
          model: resolveModelWithBrandOverride(phase1ModelOverride).model,
          response_time_ms: Date.now() - startTime,
          reply_source: "return_form_first",
          used_llm: 1,
          used_first_llm: 1,
          used_second_llm: 0,
          plan_mode: "return_form_first",
          reason_if_bypassed: "return_form_first",
          ...computePhase1TraceLogExtras("return_form_first"),
        });
        return;
      }

      const replyStyleHint = `

--- 回覆風格提醒 ---
- 直接回答，不要用「您好！我是...」等制式開場白
- 不要重複顧客剛說過的話
- 回覆保持 1-4 句，簡潔有力
- 若前面對話中顧客已提供過資訊（訂單編號、姓名等），不要再重複詢問
- 遇到同樣問題不要給一模一樣的回覆，換個說法
`;
      systemPrompt += replyStyleHint;

      let openaiClient: OpenAI | null = null;
      const getOpenAI = (): OpenAI => {
        if (!openaiClient) {
          const rm = resolveModelWithBrandOverride(phase1ModelOverride);
          const routed = createChatCompletionsOpenAIClient(rm, {
            openaiApiKey: apiKey,
            geminiApiKey: storage.getSetting("gemini_api_key"),
          });
          openaiClient = routed ?? new OpenAI({ apiKey });
        }
        return openaiClient;
      };
      let usedFirstLlmTelemetry = 0;
      let usedSecondLlmTelemetry = 0;

      const chatMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        { role: "system", content: systemPrompt },
      ];
      const knowledgeHits: string[] = [];

      for (const msg of recentMessages) {
        if (msg.sender_type === "system") continue;
        if (msg.sender_type === "user") {
          if (msg.message_type === "image" && msg.image_url) {
            const msgDataUri = await imageFileToDataUri(msg.image_url);
            if (msgDataUri) {
              chatMessages.push({ role: "user", content: [
                { type: "text", text: msg.content || "請參考這張圖片：" },
                { type: "image_url", image_url: { url: msgDataUri } },
              ]});
            } else {
              chatMessages.push({ role: "user", content: msg.content });
            }
          } else {
            chatMessages.push({ role: "user", content: msg.content });
          }
        } else if (msg.sender_type === "ai" || msg.sender_type === "admin") {
          chatMessages.push({ role: "assistant", content: msg.content });
        }
      }

      const hasImageAssets = storage.getImageAssets(effectiveBrandId || undefined).length > 0;
      let allTools = [...orderLookupTools, ...humanHandoffTools, ...productRecommendTools, ...(hasImageAssets ? imageTools : [])];
      toolsAvailableNames = allTools
        .map((t) => (t.type === "function" ? t.function?.name : "") || "")
        .filter(Boolean);
      if (
        isPhase1Active(phase1Flags) &&
        phase1Flags.tool_whitelist &&
        phase1Route != null
      ) {
        allTools = filterToolsForScenario(phase1Route.selected_scenario, {
          hasImageAssets,
          allowAfterSalesOrderVerify: phase1Flags.allow_after_sales_order_verify === true,
        });
        allTools = applyScenarioToolOverrides(
          allTools,
          phase1Route.selected_scenario,
          phase1Flags.scenario_overrides?.[phase1Route.selected_scenario]
        );
        /** AFTER_SALES 預設僅 handoff 工具 → 模型易誤轉真人；售後 plan 仍應能查單／走三輪挽留 */
        const afterSalesModesWithOrderTools: ReplyPlanMode[] = [
          "aftersales_comfort_first",
          "return_stage_1",
          "return_form_first",
          "order_lookup",
          "order_followup",
        ];
        if (
          phase1Route.selected_scenario === "AFTER_SALES" &&
          afterSalesModesWithOrderTools.includes(plan.mode as ReplyPlanMode)
        ) {
          const have = new Set(
            allTools.map((t) => (t.type === "function" ? t.function?.name : "") || "").filter(Boolean)
          );
          for (const t of orderLookupTools) {
            const n = (t.type === "function" ? t.function?.name : "") || "";
            if (n && !have.has(n)) {
              allTools.push(t);
              have.add(n);
            }
          }
        }
        toolsAvailableNames = allTools
          .map((t) => (t.type === "function" ? t.function?.name : "") || "")
          .filter(Boolean);
      }

      const AI_TIMEOUT_MS = 45000;
      const TOOL_TIMEOUT_MS = 25000;

      const streamAbortController = new AbortController();
      const streamTimeout = setTimeout(() => streamAbortController.abort(), AI_TIMEOUT_MS);

      async function callOpenAIWithTimeout(params: Parameters<OpenAI["chat"]["completions"]["create"]>[0]) {
        const oai = getOpenAI();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
        try {
          const result = await oai.chat.completions.create(params, { signal: controller.signal as any });
          return result;
        } finally {
          clearTimeout(timer);
        }
      }

      async function callToolWithTimeout(fnName: string, fnArgs: Record<string, string>, ctx: any) {
        return new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("TOOL_TIMEOUT")), TOOL_TIMEOUT_MS);
          toolExecutor.executeToolCall(fnName, fnArgs, ctx).then((result: string) => {
            clearTimeout(timer);
            resolve(result);
          }).catch((err: unknown) => {
            clearTimeout(timer);
            reject(err);
          });
        });
      }

      const mainResolvedForTools = resolveModelWithBrandOverride(phase1ModelOverride);
      /** 查單／跟進也必須走 callAiModel，否則 Gemini 會被當成 OpenAI model 打到 api.openai.com */
      const claudeSeed =
        mainResolvedForTools.provider === "anthropic" || mainResolvedForTools.provider === "google"
          ? openaiChatMessagesToClaudeSeed(chatMessages)
          : null;

      let responseMessage: OpenAI.Chat.Completions.ChatCompletionMessage | undefined;
      let usedClaudeMainPath = false;

      let loopCount = 0;
      const maxToolLoops = 3;
      const ORDER_LOOKUP_TOOL_NAMES = ["lookup_order_by_id", "lookup_order_by_product_and_phone", "lookup_order_by_date_and_contact", "lookup_more_orders", "lookup_more_orders_shopline", "lookup_order_by_phone"];
      let sentLookupAckThisTurn = false;
      let lookupAckSentMs: number | null = null;
      let firstCustomerVisibleReplyMs: number | null = null;
      let secondLlmSkipped = false;
      let deterministicToolMeta: { renderer?: string; tool_name?: string } = {};

      const planModeForAck = plan.mode as string;
      const scenarioKey = phase1Route?.selected_scenario || "GENERAL";
      const quickAckResult = await sendQuickAckIfNeeded(
        {
          createMessage: (cid, plat, st, txt) => storage.createMessage(cid, plat, st, txt),
          broadcastSSE,
          pushLineMessage,
          sendFBMessage,
        },
        {
          enabled: orderFeatureFlags.orderLookupAck,
          alreadySent: sentLookupAckThisTurn,
          planMode: planModeForAck,
          scenario: scenarioKey,
          userMessage: userMessage || "",
          brandId: effectiveBrandId || undefined,
          contactId: contact.id,
          platform: platform || contact.platform || "line",
          platformUserId: contact.platform_user_id,
          channelToken: channelToken ?? null,
          contactBrandId: contact.brand_id,
          startTime,
          queueWaitMs,
        }
      );
      if (quickAckResult.sent) {
        sentLookupAckThisTurn = true;
        lookupAckSentMs = quickAckResult.ackMs;
        firstCustomerVisibleReplyMs = quickAckResult.firstVisibleMs;
      }

      if (claudeSeed) {
        const claudeConversation: AiMessage[] = [...claudeSeed];
        try {
          const rFirst = await callAiModel({
            messages: claudeConversation,
            tools: allTools,
            maxTokens: 1500,
            temperature: isOrderLookupFamily(plan.mode) ? 0.28 : 0.85,
            modelOverride: phase1ModelOverride,
          });
          totalTokens += rFirst.inputTokens + rFirst.outputTokens;
          responseMessage = aiCallResultToOpenAiAssistantMessage(rFirst);
          usedClaudeMainPath = true;
          usedFirstLlmTelemetry = 1;
          console.log(
            "[AI Latency] contact",
            contact.id,
            "after_first_llm_ms",
            Date.now() - startTime,
            `provider=${mainResolvedForTools.provider}`
          );

          /** Gemini 3.x：每輪含 functionCall 的 model 輸出須帶回原始 parts（thought_signature） */
          let lastGeminiModelParts =
            mainResolvedForTools.provider === "google" ? rFirst.geminiModelParts : undefined;

          while (responseMessage?.tool_calls && responseMessage.tool_calls.length > 0 && loopCount < maxToolLoops) {
            loopCount++;
            console.log(
              `[Webhook AI] ${mainResolvedForTools.provider} tool round ${loopCount} n=${responseMessage.tool_calls.length}`
            );
            if (
              mainResolvedForTools.provider === "google" &&
              responseMessage.tool_calls.length > 0 &&
              !lastGeminiModelParts?.length
            ) {
              console.warn(
                "[Gemini] tool_calls 存在但未取得 geminiModelParts，下一輪可能因 thought_signature 缺失而失敗"
              );
            }
            const assistBlocks = openAiAssistantToClaudeContentBlocks(responseMessage);
            if (assistBlocks.length === 0) break;
            claudeConversation.push({
              role: "assistant",
              content: assistBlocks,
              ...(mainResolvedForTools.provider === "google" && lastGeminiModelParts?.length
                ? { geminiModelParts: lastGeminiModelParts }
                : {}),
            });

            const hasOrderLookupTool = responseMessage.tool_calls.some((tc: any) =>
              ORDER_LOOKUP_TOOL_NAMES.includes(tc?.function?.name || "")
            );
            if (
              hasOrderLookupTool &&
              shouldSendQuickAck({
                orderLookupAckEnabled: orderFeatureFlags.orderLookupAck,
                sentLookupAckThisTurn,
                planMode: planModeForAck,
                scenarioKey,
                userMessage: userMessage || "",
              })
            ) {
              sentLookupAckThisTurn = true;
              lookupAckSentMs = Date.now() - startTime;
              firstCustomerVisibleReplyMs = lookupAckSentMs;
              console.log(
                `[phase26_latency] lookup_ack_sent_ms=${lookupAckSentMs} contact=${contact.id} queue_wait_ms=0`
              );
              const lookupAckText = pickRandomAck(scenarioKey);
              const lookupAckFinal = brandMessage(
                effectiveBrandId || undefined,
                "quick_ack_" + scenarioKey.toLowerCase(),
                lookupAckText
              );
              const ackMsg = storage.createMessage(contact.id, contact.platform || "line", "ai", lookupAckFinal);
              broadcastSSE("new_message", { contact_id: contact.id, message: ackMsg, brand_id: effectiveBrandId || contact.brand_id });
              broadcastSSE("contacts_updated", { brand_id: contact.brand_id });
              if (channelToken && contact.platform === "messenger") {
                sendFBMessage(channelToken, contact.platform_user_id, lookupAckFinal).catch(() => {});
              } else if (channelToken) {
                pushLineMessage(contact.platform_user_id, [{ type: "text", text: lookupAckFinal }], channelToken).catch(() => {});
              }
            }

            const recentUserMessagesForLookup = recentMessages
              .filter((m: any) => m.sender_type === "user" && m.content && m.content !== "[圖片訊息]")
              .map((m: any) => (m.content || "").trim())
              .filter(Boolean);
            const actForLookupPolicy = storage.getActiveOrderContext(contact.id);
            const lookupIntentForTools = deriveOrderLookupIntent(
              userMessage || "",
              recentUserMessagesForLookup,
              actForLookupPolicy
                ? {
                    order_id: actForLookupPolicy.order_id,
                    candidate_count: actForLookupPolicy.candidate_count,
                    active_order_candidates: actForLookupPolicy.active_order_candidates,
                    selected_order_id: actForLookupPolicy.selected_order_id,
                  }
                : null
            );
            const toolCtx: ToolCallContext = {
              contactId: contact.id,
              brandId: effectiveBrandId || undefined,
              channelToken: channelToken || undefined,
              platform: contact.platform,
              platformUserId: contact.platform_user_id,
              preferShopline: shouldPreferShoplineLookup(userMessage, recentUserMessagesForLookup),
              userMessage: userMessage || "",
              recentUserMessages: recentUserMessagesForLookup,
              orderLookupSummaryOnly: lookupIntentForTools.summaryOnly === true,
              startTime,
              queueWaitMs,
              expectPostHandoffSkipped: isAiHandlableIntent(state.primary_intent),
            };

            const toolResults = await Promise.all(
              responseMessage.tool_calls.map(async (toolCall) => {
                const fn = (toolCall as { function?: { name?: string; arguments?: string } }).function;
                const fnName = fn?.name ?? "";
                let fnArgs: Record<string, string> = {};
                try { fnArgs = JSON.parse(fn?.arguments ?? "{}"); } catch (_e) {}
                toolsCalled.push(fnName);
                const toolStartMs = Date.now();
                console.log(`[Webhook AI] ?? Tool: ${fnName}???:`, fnArgs);
                try {
                  const toolResult = await callToolWithTimeout(fnName, fnArgs, toolCtx);
                  console.log("[AI Latency] contact", contact.id, "tool", fnName, "ms", Date.now() - toolStartMs);
                  return { toolCall, toolResult };
                } catch (toolErr: any) {
                  if (toolErr?.message === "TOOL_TIMEOUT") {
                    console.log(`[AI Timeout] ?? ${fnName} ?? (>${TOOL_TIMEOUT_MS}ms)`);
                    storage.createSystemAlert({ alert_type: "timeout_escalation", details: `?? ${fnName} ??`, brand_id: effectiveBrandId || undefined, contact_id: contact.id });
                    return { toolCall, toolResult: JSON.stringify({ error: true, message: "查單工具執行逾時，請稍後再試或轉人工。" }) };
                  }
                  throw toolErr;
                }
              })
            );

            const toolResultBlocks: ContentBlockParam[] = [];
            let orderLookupDeterministicReply: string | null = null;
            const deterministicCandidates: { fnName: string; pr: Record<string, unknown> }[] = [];
            for (const { toolCall, toolResult } of toolResults) {
              toolResultBlocks.push({
                type: "tool_result",
                tool_use_id: toolCall.id,
                content: toolResult,
              });
              const fn = (toolCall as { function?: { name?: string; arguments?: string } }).function;
              const fnName = fn?.name ?? "";
              let fnArgs: Record<string, string> = {};
              try { fnArgs = JSON.parse(fn?.arguments ?? "{}"); } catch (_e) {}

              try {
                const pr = JSON.parse(toolResult) as Record<string, unknown>;
                if (
                  (orderFeatureFlags.genericDeterministicOrder ||
                    orderFeatureFlags.phoneOrderDeterministicReply) &&
                  isValidOrderDeterministicPayload(pr)
                ) {
                  deterministicCandidates.push({ fnName, pr });
                }
              } catch (_e) {
                /* ignore */
              }

              if (fnName === "transfer_to_human") {
                transferTriggered = true;
                transferReason = fnArgs.reason || "AI 判斷需要轉人工";
                (() => { const { reason, reason_detail } = normalizeHandoffReason(transferReason); applyHandoff({ contactId: contact.id, reason, reason_detail, source: "webhook_tool_call", brandId: effectiveBrandId || undefined }); })();
                const assignedId = assignment.assignCase(contact.id);
                if (assignedId == null && assignment.isAllAgentsUnavailable()) {
                  storage.updateContactNeedsAssignment(contact.id, 1);
                  const tags = JSON.parse(contact.tags || "[]");
                  if (!tags.includes("待指派")) {
                    storage.updateContactTags(contact.id, [...tags, "待指派"]);
                  }
                  const reason = assignment.getUnavailableReason();
                  storage.createMessage(contact.id, contact.platform, "system", getTransferUnavailableSystemMessage(reason));
                }
                const freshTc = storage.getContact(contact.id);
                if (freshTc?.needs_human) {
                  console.log(`[Webhook AI] transfer_to_human ?????? AI ????`);
                }
              }

              if (fnName.includes("lookup_order")) {
                try {
                  const parsed = JSON.parse(toolResult);
                  if (parsed.found === false) {
                    orderLookupFailed++;
                    const orderSource = parsed.source || "unknown";
                    storage.createSystemAlert({ alert_type: "order_lookup_fail", details: `???? (${orderSource})`, brand_id: effectiveBrandId || undefined, contact_id: contact.id });
                  }
                  if (parsed.found === true && !contact.issue_type) {
                    storage.updateContactIssueType(contact.id, "order_inquiry");
                  }
                } catch (_e) {}
              }
            }

            if (deterministicCandidates.length > 0) {
              const byId = deterministicCandidates.find((c) => c.fnName === "lookup_order_by_id");
              const picked = byId ?? deterministicCandidates[0]!;
              orderLookupDeterministicReply = String(picked.pr.deterministic_customer_reply).trim();
              deterministicToolMeta = {
                renderer: typeof picked.pr.renderer === "string" ? picked.pr.renderer : undefined,
                tool_name: picked.fnName,
              };
            }

            claudeConversation.push({ role: "user", content: toolResultBlocks });

            const freshContact = storage.getContact(contact.id);
            if (freshContact?.needs_human) break;

            if (orderLookupDeterministicReply) {
              secondLlmSkipped = true;
              console.log(
                `deterministic_tool_reply_selected=true renderer=${deterministicToolMeta.renderer ?? ""} tool_name=${deterministicToolMeta.tool_name ?? ""} second_llm_skipped=true contact=${contact.id}`
              );
              console.log(
                "[order_lookup] skip_second_llm contact=",
                contact.id,
                "reply_len=",
                orderLookupDeterministicReply.length
              );
              responseMessage = {
                role: "assistant",
                content: orderLookupDeterministicReply,
              } as OpenAI.Chat.Completions.ChatCompletionMessage;
              break;
            }

            usedSecondLlmTelemetry = 1;
            const rNext = await callAiModel({
              messages: claudeConversation,
              tools: allTools,
              maxTokens: hasOrderLookupTool ? 1000 : 1500,
              temperature: hasOrderLookupTool ? 0.2 : 0.85,
              modelOverride: phase1ModelOverride,
            });
            totalTokens += rNext.inputTokens + rNext.outputTokens;
            lastGeminiModelParts =
              mainResolvedForTools.provider === "google" ? rNext.geminiModelParts : undefined;
            responseMessage = aiCallResultToOpenAiAssistantMessage(rNext);
          }
        } catch (claudeErr) {
          if (mainResolvedForTools.provider === "google") {
            console.error("[AI] Gemini 工具路徑失敗（已停用改走 OpenAI fallback）：", claudeErr);
            clearTimeout(streamTimeout);
            throw claudeErr;
          }
          console.error("[AI] Anthropic/Gemini 工具路徑失敗，改走 OpenAI：", claudeErr);
          usedClaudeMainPath = false;
          responseMessage = undefined;
          loopCount = 0;
          if (!orderFeatureFlags.orderLookupAck) {
            sentLookupAckThisTurn = false;
            lookupAckSentMs = null;
          }
          secondLlmSkipped = false;
          deterministicToolMeta = {};
        }
        if (usedClaudeMainPath) {
          clearTimeout(streamTimeout);
        }
      }

      if (!usedClaudeMainPath) {
        try {
          responseMessage = await runOpenAIStream(
            getOpenAI(),
            {
              model: getOpenAIModel(),
              messages: chatMessages,
              tools: allTools,
              max_completion_tokens: isOrderLookupFamily(plan.mode) ? 1000 : 1500,
              temperature: isOrderLookupFamily(plan.mode) ? 0.28 : 0.85,
            },
            contact.id,
            contact.brand_id ?? undefined,
            streamAbortController.signal
          );
        } catch (timeoutErr: any) {
          clearTimeout(streamTimeout);
          if (timeoutErr?.name === "AbortError" || timeoutErr?.message?.includes("abort")) {
            console.log("[AI Latency] contact", contact.id, "first_llm_timeout_or_error_ms", Date.now() - startTime);
            console.log(`[AI Timeout] OpenAI ???? (>${AI_TIMEOUT_MS}ms) - contact ${contact.id}`);
            const timeoutCount = storage.incrementConsecutiveTimeouts(contact.id);
            storage.createSystemAlert({ alert_type: "timeout_escalation", details: `OpenAI ???? (?${timeoutCount}?)`, brand_id: effectiveBrandId || undefined, contact_id: contact.id });
            if (timeoutCount >= 2) {
              applyHandoff({ contactId: contact.id, reason: "timeout_escalation", source: "webhook_ai_timeout", brandId: effectiveBrandId || undefined });
              const comfortMsg = getHandoffReplyForCustomer(HANDOFF_MANDATORY_OPENING, assignment.getUnavailableReason());
              storage.createMessage(contact.id, contact.platform, "ai", comfortMsg);
              if (platform === "messenger") {
                sendFBMessage(channelToken || "", contact.platform_user_id, comfortMsg).catch(() => {});
              } else if (channelToken) {
                pushLineMessage(contact.platform_user_id, [{ type: "text", text: comfortMsg }], channelToken).catch(() => {});
              }
              broadcastSSE("contacts_updated", { brand_id: contact.brand_id });
            } else {
              const comfortMsg = "不好意思讓您久等了，系統正在處理中，請稍等一下。";
              storage.createMessage(contact.id, contact.platform, "ai", comfortMsg);
              if (platform === "messenger") {
                sendFBMessage(channelToken || "", contact.platform_user_id, comfortMsg).catch(() => {});
              } else if (channelToken) {
                pushLineMessage(contact.platform_user_id, [{ type: "text", text: comfortMsg }], channelToken).catch(() => {});
              }
              broadcastSSE("new_message", { contact_id: contact.id, brand_id: contact.brand_id });
            }
            return;
          }
          throw timeoutErr;
        }
        clearTimeout(streamTimeout);
        usedFirstLlmTelemetry = 1;
        console.log("[AI Latency] contact", contact.id, "after_first_llm_ms", Date.now() - startTime);

        while (responseMessage?.tool_calls && responseMessage.tool_calls.length > 0 && loopCount < maxToolLoops) {
          loopCount++;
          console.log(`[Webhook AI] ?? ${responseMessage.tool_calls.length} ? Tool Call?? ${loopCount} ??`);
          chatMessages.push(responseMessage as OpenAI.Chat.Completions.ChatCompletionMessageParam);

          const hasOrderLookupTool = responseMessage.tool_calls.some((tc: any) => ORDER_LOOKUP_TOOL_NAMES.includes(tc?.function?.name || ""));
          if (
            hasOrderLookupTool &&
            shouldSendQuickAck({
              orderLookupAckEnabled: orderFeatureFlags.orderLookupAck,
              sentLookupAckThisTurn,
              planMode: planModeForAck,
              scenarioKey,
              userMessage: userMessage || "",
            })
          ) {
            sentLookupAckThisTurn = true;
            lookupAckSentMs = Date.now() - startTime;
            firstCustomerVisibleReplyMs = lookupAckSentMs;
            console.log(
              `[phase26_latency] lookup_ack_sent_ms=${lookupAckSentMs} contact=${contact.id} queue_wait_ms=0`
            );
            const lookupAckText = pickRandomAck(scenarioKey);
            const lookupAckFinal = brandMessage(
              effectiveBrandId || undefined,
              "quick_ack_" + scenarioKey.toLowerCase(),
              lookupAckText
            );
            const ackMsg = storage.createMessage(contact.id, contact.platform || "line", "ai", lookupAckFinal);
            broadcastSSE("new_message", { contact_id: contact.id, message: ackMsg, brand_id: effectiveBrandId || contact.brand_id });
            broadcastSSE("contacts_updated", { brand_id: contact.brand_id });
            if (channelToken && contact.platform === "messenger") {
              sendFBMessage(channelToken, contact.platform_user_id, lookupAckFinal).catch(() => {});
            } else if (channelToken) {
              pushLineMessage(contact.platform_user_id, [{ type: "text", text: lookupAckFinal }], channelToken).catch(() => {});
            }
          }

          const recentUserMessagesForLookupOai = recentMessages
            .filter((m: any) => m.sender_type === "user" && m.content && m.content !== "[圖片訊息]")
            .map((m: any) => (m.content || "").trim())
            .filter(Boolean);
          const actForLookupPolicyOai = storage.getActiveOrderContext(contact.id);
          const lookupIntentForToolsOai = deriveOrderLookupIntent(
            userMessage || "",
            recentUserMessagesForLookupOai,
            actForLookupPolicyOai
              ? {
                  order_id: actForLookupPolicyOai.order_id,
                  candidate_count: actForLookupPolicyOai.candidate_count,
                  active_order_candidates: actForLookupPolicyOai.active_order_candidates,
                  selected_order_id: actForLookupPolicyOai.selected_order_id,
                }
              : null
          );
          const toolCtxOai: ToolCallContext = {
            contactId: contact.id,
            brandId: effectiveBrandId || undefined,
            channelToken: channelToken || undefined,
            platform: contact.platform,
            platformUserId: contact.platform_user_id,
            preferShopline: shouldPreferShoplineLookup(userMessage, recentUserMessagesForLookupOai),
            userMessage: userMessage || "",
            recentUserMessages: recentUserMessagesForLookupOai,
            orderLookupSummaryOnly: lookupIntentForToolsOai.summaryOnly === true,
            startTime,
            queueWaitMs,
            expectPostHandoffSkipped: isAiHandlableIntent(state.primary_intent),
          };

          const toolResultsOai = await Promise.all(
            responseMessage.tool_calls.map(async (toolCall) => {
              const fn = (toolCall as { function?: { name?: string; arguments?: string } }).function;
              const fnName = fn?.name ?? "";
              let fnArgs: Record<string, string> = {};
              try { fnArgs = JSON.parse(fn?.arguments ?? "{}"); } catch (_e) {}
              toolsCalled.push(fnName);
              const toolStartMs = Date.now();
              console.log(`[Webhook AI] ?? Tool: ${fnName}???:`, fnArgs);
              try {
                const toolResult = await callToolWithTimeout(fnName, fnArgs, toolCtxOai);
                console.log("[AI Latency] contact", contact.id, "tool", fnName, "ms", Date.now() - toolStartMs);
                return { toolCall, toolResult };
              } catch (toolErr: any) {
                if (toolErr?.message === "TOOL_TIMEOUT") {
                  console.log(`[AI Timeout] ?? ${fnName} ?? (>${TOOL_TIMEOUT_MS}ms)`);
                  storage.createSystemAlert({ alert_type: "timeout_escalation", details: `?? ${fnName} ??`, brand_id: effectiveBrandId || undefined, contact_id: contact.id });
                  return { toolCall, toolResult: JSON.stringify({ error: true, message: "查單工具執行逾時，請稍後再試或轉人工。" }) };
                }
                throw toolErr;
              }
            })
          );

          let orderLookupDeterministicReplyOai: string | null = null;
          const deterministicCandidatesOai: { fnName: string; pr: Record<string, unknown> }[] = [];
          for (const { toolCall, toolResult } of toolResultsOai) {
            chatMessages.push({ role: "tool", tool_call_id: toolCall.id, content: toolResult });
            const fn = (toolCall as { function?: { name?: string; arguments?: string } }).function;
            const fnName = fn?.name ?? "";
            let fnArgs: Record<string, string> = {};
            try { fnArgs = JSON.parse(fn?.arguments ?? "{}"); } catch (_e) {}

            try {
              const pr = JSON.parse(toolResult) as Record<string, unknown>;
              if (
                (orderFeatureFlags.genericDeterministicOrder ||
                  orderFeatureFlags.phoneOrderDeterministicReply) &&
                isValidOrderDeterministicPayload(pr)
              ) {
                deterministicCandidatesOai.push({ fnName, pr });
              }
            } catch (_e) {
              /* ignore */
            }

            if (fnName === "transfer_to_human") {
              transferTriggered = true;
              transferReason = fnArgs.reason || "AI 判斷需要轉人工";
              (() => { const { reason, reason_detail } = normalizeHandoffReason(transferReason); applyHandoff({ contactId: contact.id, reason, reason_detail, source: "webhook_tool_call", brandId: effectiveBrandId || undefined }); })();
              const assignedId = assignment.assignCase(contact.id);
              if (assignedId == null && assignment.isAllAgentsUnavailable()) {
                storage.updateContactNeedsAssignment(contact.id, 1);
                const tags = JSON.parse(contact.tags || "[]");
                if (!tags.includes("待指派")) {
                  storage.updateContactTags(contact.id, [...tags, "待指派"]);
                }
                const reason = assignment.getUnavailableReason();
                storage.createMessage(contact.id, contact.platform, "system", getTransferUnavailableSystemMessage(reason));
              }
              const freshContactOai = storage.getContact(contact.id);
              if (freshContactOai?.needs_human) {
                console.log(`[Webhook AI] transfer_to_human ?????? AI ????`);
              }
            }

            if (fnName.includes("lookup_order")) {
              try {
                const parsed = JSON.parse(toolResult);
                if (parsed.found === false) {
                  orderLookupFailed++;
                  const orderSource = parsed.source || "unknown";
                  storage.createSystemAlert({ alert_type: "order_lookup_fail", details: `???? (${orderSource})`, brand_id: effectiveBrandId || undefined, contact_id: contact.id });
                }
                if (parsed.found === true && !contact.issue_type) {
                  storage.updateContactIssueType(contact.id, "order_inquiry");
                }
              } catch (_e) {}
            }
          }

          if (deterministicCandidatesOai.length > 0) {
            const byIdOai = deterministicCandidatesOai.find((c) => c.fnName === "lookup_order_by_id");
            const pickedOai = byIdOai ?? deterministicCandidatesOai[0]!;
            orderLookupDeterministicReplyOai = String(pickedOai.pr.deterministic_customer_reply).trim();
            deterministicToolMeta = {
              renderer: typeof pickedOai.pr.renderer === "string" ? pickedOai.pr.renderer : undefined,
              tool_name: pickedOai.fnName,
            };
          }

          const freshContactLoop = storage.getContact(contact.id);
          if (freshContactLoop?.needs_human) break;

          if (orderLookupDeterministicReplyOai) {
            secondLlmSkipped = true;
            console.log(
              `deterministic_tool_reply_selected=true renderer=${deterministicToolMeta.renderer ?? ""} tool_name=${deterministicToolMeta.tool_name ?? ""} second_llm_skipped=true contact=${contact.id}`
            );
            console.log(
              "[order_lookup] skip_second_llm contact=",
              contact.id,
              "reply_len=",
              orderLookupDeterministicReplyOai.length
            );
            responseMessage = {
              role: "assistant",
              content: orderLookupDeterministicReplyOai,
            } as OpenAI.Chat.Completions.ChatCompletionMessage;
            break;
          }

          const loopAbort = new AbortController();
          const loopTimer = setTimeout(() => loopAbort.abort(), AI_TIMEOUT_MS);
          usedSecondLlmTelemetry = 1;
          try {
            responseMessage = await runOpenAIStream(
              getOpenAI(),
              {
                model: resolveModelWithBrandOverride(phase1ModelOverride).model,
                messages: chatMessages,
                tools: allTools,
                max_completion_tokens: hasOrderLookupTool ? 1000 : 1500,
                temperature: hasOrderLookupTool ? 0.2 : 0.85,
              },
              contact.id,
              contact.brand_id ?? undefined,
              loopAbort.signal
            );
          } catch (loopTimeoutErr: any) {
            clearTimeout(loopTimer);
            if (loopTimeoutErr?.name === "AbortError" || loopTimeoutErr?.message?.includes("abort")) {
              console.log(`[AI Timeout] OpenAI ???????? - contact ${contact.id}`);
              const loopTimeoutCount = storage.incrementConsecutiveTimeouts(contact.id);
              storage.createSystemAlert({ alert_type: "timeout_escalation", details: `???????? (?${loopTimeoutCount}?)`, brand_id: effectiveBrandId || undefined, contact_id: contact.id });
              if (loopTimeoutCount >= 2) {
                applyHandoff({ contactId: contact.id, reason: "timeout_escalation", source: "webhook_ai_loop_timeout", brandId: effectiveBrandId || undefined });
                const comfortMsg = getHandoffReplyForCustomer(HANDOFF_MANDATORY_OPENING, assignment.getUnavailableReason());
                storage.createMessage(contact.id, contact.platform, "ai", comfortMsg);
                if (platform === "messenger") {
                  sendFBMessage(channelToken || "", contact.platform_user_id, comfortMsg).catch(() => {});
                } else if (channelToken) {
                  pushLineMessage(contact.platform_user_id, [{ type: "text", text: comfortMsg }], channelToken).catch(() => {});
                }
                broadcastSSE("contacts_updated", { brand_id: contact.brand_id });
              }
              break;
            }
            throw loopTimeoutErr;
          }
          clearTimeout(loopTimer);
        }
      }

      storage.resetConsecutiveTimeouts(contact.id);

      const finalContact = storage.getContact(contact.id);
      /** 若 AI 回覆內容或後處理判定 needs_human，則寫入並轉人工 */
      const shouldSkipPostHandoff = !transferTriggered && state && isAiHandlableIntent(state.primary_intent);
      if (!shouldSkipPostHandoff && (finalContact?.needs_human || storage.isAiMuted(contact.id) || finalContact?.status === "awaiting_human" || finalContact?.status === "high_risk")) {
        console.log(`[Webhook AI] ???????????? handoff ????? (needs_human=${finalContact?.needs_human}, status=${finalContact?.status})`);
        const recentForHandoff = storage.getMessages(contact.id).slice(-12).map((m: any) => ({ sender_type: m.sender_type, content: m.content, message_type: m.message_type, image_url: m.image_url }));
        const orderInfoForHandoff = searchOrderInfoInRecentMessages(recentForHandoff);
        const handoffReply = buildHandoffReply({
          customerEmotion: state.customer_emotion,
          humanReason: state.human_reason ?? undefined,
          isOrderLookupContext: ORDER_LOOKUP_PATTERNS.test(userMessage),
          hasOrderInfo: !!orderInfoForHandoff.orderId,
          brandId: effectiveBrandId || undefined,
        });
        const unavailableReasonPost = assignment.getUnavailableReason();
        const handoffTextToSendPost = getHandoffReplyForCustomer(handoffReply, unavailableReasonPost);
        const contactPlatform = platform || contact.platform || "line";
        const aiMsg = storage.createMessage(contact.id, contactPlatform, "ai", handoffTextToSendPost);
        broadcastSSE("new_message", { contact_id: contact.id, message: aiMsg, brand_id: contact.brand_id });
        broadcastSSE("contacts_updated", { brand_id: contact.brand_id });
        if (contactPlatform === "messenger" && channelToken) {
          await sendFBMessage(channelToken, contact.platform_user_id, handoffTextToSendPost);
        } else if (channelToken) {
          await pushLineMessage(contact.platform_user_id, [{ type: "text", text: handoffTextToSendPost }], channelToken);
        }
        storage.createAiLog({
          contact_id: contact.id,
          message_id: aiMsg.id,
          brand_id: effectiveBrandId || undefined,
          prompt_summary: userMessage.slice(0, 200),
          knowledge_hits: knowledgeHits,
          tools_called: toolsCalled,
          transfer_triggered: true,
          transfer_reason: transferReason ?? undefined,
          result_summary: "?????????????",
          token_usage: totalTokens,
          model: getOpenAIModel(),
          response_time_ms: Date.now() - startTime,
          reply_source: "handoff",
          used_llm: 1,
          plan_mode: plan.mode,
          reason_if_bypassed: null,
          ...buildPhase1AiLogExtras({
            phase1Flags,
            phase1Route,
            channelId: contact.channel_id,
            toolsAvailableNames,
            replySource: "handoff",
          }),
        });
        return;
      }

      let reply = runPostGenerationPipeline({
        rawReply: responseMessage?.content,
        planMode: plan.mode,
        productScope: effectiveScope,
        channelId: contact.channel_id,
        toolCallsMade: toolsCalled,
      });
      const contactAfterPipeline = storage.getContact(contact.id);
      const inHandoffAfterPipeline =
        contactAfterPipeline?.needs_human === 1 ||
        storage.isAiMuted(contact.id) ||
        contactAfterPipeline?.status === "awaiting_human" ||
        contactAfterPipeline?.status === "high_risk";
      const replyTrimEarly = typeof reply === "string" ? reply.trim() : "";
      const lastMsgRow = storage.getMessages(contact.id).slice(-1)[0];
      const lastAiAlreadyTransferAck =
        lastMsgRow?.sender_type === "ai" &&
        String(lastMsgRow.content || "").includes("轉給專人處理");
      if (!replyTrimEarly && shouldSkipPostHandoff && inHandoffAfterPipeline && !lastAiAlreadyTransferAck) {
        reply = TRANSFER_TOOL_CUSTOMER_ACK;
      }
      if (reply && reply.trim()) {
        if (firstCustomerVisibleReplyMs == null) {
          firstCustomerVisibleReplyMs = Date.now() - startTime;
        }
        const activeOrd = storage.getActiveOrderContext(contact.id);
        const followupLite =
          isOrderLookupFamily(plan.mode) &&
          !!activeOrd?.one_page_summary &&
          ORDER_FOLLOWUP_PATTERNS.test(userMessage || "");
        const normMode = followupLite ? "order_followup" : isOrderLookupFamily(plan.mode) ? "order_lookup" : "general";
        if (orderFeatureFlags.orderFinalNormalizer) {
          const normF = normalizeCustomerFacingOrderReply(reply.trim(), {
            mode: normMode,
            replySource: secondLlmSkipped ? "deterministic_tool" : "llm",
            renderer: deterministicToolMeta.renderer,
            platform: contact.platform ?? undefined,
            softHumanize: secondLlmSkipped && isOrderLookupFamily(plan.mode),
          });
          reply = normF.text;
          console.log(
            `final_normalizer_changed=${normF.changed} normalizer_rules=${normF.rulesHit.length ? normF.rulesHit.join("|") : "none"}`
          );
        } else {
          console.log("final_normalizer_changed=false normalizer_rules=disabled_flag");
        }
        const recentUserTextsForRecency = recentMessages
          .filter((m: { sender_type?: string }) => m.sender_type === "user")
          .map((m: { content?: string | null }) => String(m.content || ""))
          .slice(-5);
        reply = ensureShippingSopCompliance(
          reply,
          plan.mode,
          "",
          userMessage,
          recentUserTextsForRecency,
          effectiveBrandId || undefined
        );
        const totalMs = Date.now() - startTime;
        const finalRenderer = secondLlmSkipped ? (deterministicToolMeta.renderer || "deterministic_tool") : "llm";
        console.log("[AI Latency] contact", contact.id, "reply_sent_total_ms", totalMs, "tools=" + (toolsCalled.length ? toolsCalled.join(",") : "none"));
        console.log(
          `[phase26_latency] first_customer_visible_reply_ms=${firstCustomerVisibleReplyMs} final_reply_sent_ms=${totalMs} second_llm_skipped=${secondLlmSkipped} final_renderer=${finalRenderer} prompt_profile=${enrichedPack.prompt_profile}`
        );
        const contactPlatform = platform || contact.platform || "line";
        const aiMsg = storage.createMessage(contact.id, contactPlatform, "ai", reply);
        broadcastSSE("new_message", { contact_id: contact.id, message: aiMsg, brand_id: contact.brand_id });
        broadcastSSE("contacts_updated", { brand_id: contact.brand_id });
        if (contactPlatform === "messenger" && channelToken) {
          await sendFBMessage(channelToken, contact.platform_user_id, reply);
        } else {
          await pushLineMessage(contact.platform_user_id, [{ type: "text", text: reply }], channelToken);
        }

        const outboundForm = detectOutboundFormTypeFromReply(reply);
        if (outboundForm) {
          storage.updateContactConversationFields(contact.id, {
            waiting_for_customer: `${outboundForm}_form_submit`,
          });
          const formZh = formTypeToZh(outboundForm);
          storage.createCaseNotification(contact.id, "in_app", {
            type: "form_pending",
            form_type: outboundForm,
            message: `客戶已收到 ${formZh} 表單，等待回填`,
          });
          console.log(`[form_tracking] contact=${contact.id} form=${outboundForm} waiting`);
          broadcastSSE("contacts_updated", { brand_id: contact.brand_id });
        }

        const anyLlm = usedFirstLlmTelemetry > 0 || usedSecondLlmTelemetry > 0;
        const replySourceFinal = secondLlmSkipped ? "deterministic_tool" : "llm";
        storage.createAiLog({
          contact_id: contact.id,
          message_id: aiMsg.id,
          brand_id: effectiveBrandId || undefined,
          prompt_summary: userMessage.slice(0, 200),
          knowledge_hits: knowledgeHits,
          tools_called: toolsCalled,
          transfer_triggered: transferTriggered,
          transfer_reason: transferReason,
          result_summary: reply.slice(0, 300),
          token_usage: totalTokens,
          model: getOpenAIModel(),
          response_time_ms: Date.now() - startTime,
          reply_source: replySourceFinal,
          used_llm: anyLlm ? 1 : 0,
          plan_mode: plan.mode,
          reason_if_bypassed: secondLlmSkipped
            ? `deterministic_skip:${deterministicToolMeta.tool_name ?? "?"}:${deterministicToolMeta.renderer ?? ""}`.slice(0, 200)
            : null,
          used_first_llm: usedFirstLlmTelemetry,
          used_second_llm: secondLlmSkipped ? 0 : usedSecondLlmTelemetry,
          reply_renderer: finalRenderer,
          prompt_profile: enrichedPack.prompt_profile,
          first_customer_visible_reply_ms: firstCustomerVisibleReplyMs ?? null,
          lookup_ack_sent_ms: lookupAckSentMs,
          queue_wait_ms: queueWaitMs,
          ...buildPhase1AiLogExtras({
            phase1Flags,
            phase1Route,
            channelId: contact.channel_id,
            toolsAvailableNames,
            replySource: replySourceFinal,
          }),
        });
      }
    } catch (err) {
      console.error("[Webhook AI] ??????:", err);
      storage.createAiLog({
        contact_id: contact.id,
        brand_id: contact.brand_id || brandId || undefined,
        prompt_summary: userMessage.slice(0, 200),
        knowledge_hits: [],
        tools_called: toolsCalled,
        transfer_triggered: false,
        result_summary: `??: ${(err as Error).message}`,
        token_usage: totalTokens,
        model: resolveModelWithBrandOverride(phase1ModelOverride).model,
        response_time_ms: Date.now() - startTime,
        reply_source: "error",
        used_llm: 0,
        plan_mode: null,
        reason_if_bypassed: `error: ${(err as Error).message}`.slice(0, 200),
        ...buildPhase1AiLogExtras({
          phase1Flags,
          phase1Route,
          channelId: contact.channel_id,
          toolsAvailableNames,
          replySource: "error",
        }),
      });
    }
  }

  return { autoReplyWithAI, handleImageVisionFirst, analyzeImageWithAI, imageFileToDataUri };
}
