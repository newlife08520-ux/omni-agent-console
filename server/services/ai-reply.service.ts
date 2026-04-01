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
} from "../conversation-state-resolver";
import { buildReplyPlan, shouldNotLeadWithOrderLookup, isAftersalesComfortFirst, type ReplyPlanMode } from "../reply-plan-builder";
import { enforceOutputGuard, HANDOFF_MANDATORY_OPENING, buildHandoffReply, getHandoffReplyForCustomer } from "../phase2-output";
import { runPostGenerationGuard, isModeNoPromo, runOfficialChannelGuard, runGlobalPlatformGuard } from "../content-guard";
import { recordGuardHit } from "../content-guard-stats";
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
import { formatOrderOnePage, payKindForOrder, sourceChannelLabel } from "../order-reply-utils";
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
import { ensureShippingSopCompliance } from "../sop-compliance-guard";
import { deriveOrderLookupIntent } from "../order-lookup-policy";
import type { ToolCallContext } from "./tool-executor.service";
import { resolveOpenAIModel } from "../openai-model";
import { getDataDir } from "../data-dir";
import {
  classifyMessageForSafeAfterSale,
  FALLBACK_AFTER_SALE_LINE_LABEL,
  SHORT_IMAGE_FALLBACK,
} from "../safe-after-sale-classifier";
import { orderLookupTools, humanHandoffTools, imageTools } from "../openai-tools";

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
  context?: { productScope?: string | null; planMode?: ReplyPlanMode }
): Promise<string> {
  const result = await assembleEnrichedSystemPrompt(brandId, {
    productScope: context?.productScope,
    planMode: context?.planMode,
  });
  return result.full_prompt;
}

const ASK_ORDER_PHONE_FOR_BYPASS_KW = ["請提供訂單編號", "訂單編號", "請提供", "手機號碼", "商品名稱", "下訂手機", "收件人", "請提供賃訊"];

function isOrderLookupFamily(mode: string): boolean {
  return mode === "order_lookup" || mode === "order_followup";
}

/** Minimal Safe Mode：永遠不走 active-order 確定性短路，強制經 LLM。 */
function planAllowsActiveOrderDeterministic(_mode: string): boolean {
  return false;
}

function looksLikeOrderIdInput(s: string): boolean {
  const t = (s || "").trim();
  return t.length <= 10 && t.length >= 1 && /^[0-9A-Za-z\-]+$/.test(t);
}

const BAG_KEYWORDS = ["包", "包包", "托特包", "手提包", "肩背包", "後背包", "側背包"];
const SWEET_KEYWORDS = ["甜", "甜點", "糖", "糖果", "巧克力", "蛋糕", "養乾"];

function getProductScopeFromMessage(text: string): "bag" | "sweet" | null {
  const t = (text || "").trim();
  if (BAG_KEYWORDS.some((k) => t.includes(k))) return "bag";
  if (SWEET_KEYWORDS.some((k) => t.includes(k))) return "sweet";
  return null;
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
   * Vision-first ???????? + ???????????????????? fallback?
   * ?????? unreadable ??? SHORT_IMAGE_FALLBACK??? 1 ???????
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
              source_channel: sourceChannelLabel(order.source || result.source),
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
    } catch (_e) { /* ???????????? vision ?? */ }
    const recentMessages = storage.getMessages(contactId).slice(-10);
    const tags = (contact?.tags && typeof contact.tags === "string") ? (() => { try { return JSON.parse(contact.tags) as string[]; } catch { return []; } })() : [];
    const productScope = (contact as any)?.product_scope_locked ?? null;
    const contextParts: string[] = [];
    for (const m of recentMessages) {
      if (m.sender_type === "user" && m.content && m.content !== "[????]" && !m.content.startsWith("[??")) {
        contextParts.push(`???${m.content.slice(0, 80)}`);
      } else if (m.sender_type === "ai" && m.content) {
        contextParts.push(`???${m.content.slice(0, 80)}`);
      }
    }
    if (tags.length) contextParts.push(`?????${tags.join("?")}`);
    if (productScope) contextParts.push(`????????${productScope === "bag" ? "??/??" : "???"}`);
    const contextStr = contextParts.length ? contextParts.join("\n") : "?????????";

    const systemPrompt = await getEnrichedSystemPrompt(brandId ?? undefined);
    const visionInstruction = `
????? - Vision First???????????????????????????
??????????
- order_screenshot???/??/???????????
- product_issue_defect?????????????
- product_page_size????????????
- off_brand????????????????????
- unreadable??????????????

???
${contextStr}

????? JSON ??????{"intent":"?????","confidence":"high ? low","reply_to_customer":"??????????????"}
???
- ? confidence ? low ? intent ? unreadable??? reply_to_customer ????? ""???????? fallback ???????
- ? confidence ? high?order_screenshot ???????????????????????????????product_issue_defect ?????????product_page_size ??????????off_brand ????????????
- reply_to_customer ?????? 50?120 ????????????????`;

    const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
      { type: "text", text: "??????????????? JSON?" },
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
      systemPrompt += "\n\n????????????????????????????????????????????????????????????????(?? transfer_to_human ??)????????????????????????????????????????????????????????";

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
                { type: "text", text: msg.content || "???????" },
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
          { type: "text", text: "???????" },
          { type: "image_url", image_url: { url: currentImageDataUri } },
        ]});
      }

      const effectiveBrandId = contact?.brand_id;
      const hasImageAssets = storage.getImageAssets(effectiveBrandId || undefined).length > 0;
      const allTools = [...orderLookupTools, ...humanHandoffTools, ...(hasImageAssets ? imageTools : [])];

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

      const reply = responseMessage?.content || "?????????????????";
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
      storage.createMessage(contactId, contactPlatform, "ai", "??????????????????");
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

    const freshCheck = storage.getContact(contact.id);
    if (freshCheck && (freshCheck.status === "awaiting_human" || freshCheck.status === "high_risk")) {
      const isLinkAsk = isLinkRequestMessage(userMessage) || isLinkRequestCorrectionMessage(userMessage);
      if (isLinkAsk) {
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
      const isLinkAsk = isLinkRequestMessage(userMessage) || isLinkRequestCorrectionMessage(userMessage);
      if (isLinkAsk) {
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

    try {
      const effectiveBrandId = contact.brand_id || brandId;

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
        const handoffReplyLegal = buildHandoffReply({ customerEmotion: "high_risk" });
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

      // ????????????????????????? ? ????????????????
      // ???????????????????????????????????????????????????
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
              m.sender_type === "user" && (m.message_type === "image" || m.content === "[????]" || (m.content && m.content.startsWith("[??")))
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

      const recentMessages = storage.getMessages(contact.id).slice(-20);
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
      let returnFormUrl = "https://www.lovethelife.shop/returns";
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
      const plan = buildReplyPlan({ state, returnFormUrl, isReturnFirstRound, orderFollowupTurn });
      if (!isOrderLookupFamily(plan.mode)) {
        storage.clearActiveOrderContext(contact.id);
      }
      console.log("[AI Latency] contact", contact.id, "after_plan_ms", Date.now() - startTime, "mode=" + plan.mode);

      if (plan.mode !== "handoff" && plan.mode !== "return_form_first" && orderFeatureFlags.orderFastPath) {
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
          });
          return;
        }
      }

      function isUserProvidingOrderDetails(lastAiMessage: string | null | undefined, currentUserMessage: string): boolean {
        if (!lastAiMessage || !ASK_ORDER_PHONE_FOR_BYPASS_KW.some((k) => lastAiMessage.includes(k))) return false;
        const trimmed = (currentUserMessage || "").trim();
        if (trimmed.length >= 15) return false;
        if (isHumanRequestMessage(trimmed)) return false;
        return true;
      }

      // ????????????????????????????????? AI ??????? ? ?????
      const awkwardCheck = shouldHandoffDueToAwkwardOrRepeat({
        userMessage,
        recentMessages: recentMessages.map((m: any) => ({ sender_type: m.sender_type, content: m.content })),
        primaryIntentOrderLookup: state.primary_intent === "order_lookup",
      });
      // ?????????????????????????????/??????
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
          if (!tags.includes("?????")) storage.updateContactTags(contact.id, [...tags, "?????"]);
          storage.updateContactNeedsAssignment(contact.id, 1);
          storage.createMessage(contact.id, contact.platform, "system", getTransferUnavailableSystemMessage(assignment.getUnavailableReason()));
        }
        const handoffReplyAwk = buildHandoffReply({ customerEmotion: state.customer_emotion });
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
          if (!tags.includes("?????")) {
            storage.updateContactTags(contact.id, [...tags, "?????"]);
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
        });
        return;
      }

      // ??3???????????return_form_first
      if (plan.mode === "return_form_first") {
        const returnFormFirstText = `???????????? ???????????????????????????????????????????${returnFormUrl ? `\n?????${returnFormUrl}` : ""}\n??????????????????????????????????????????`;
        const contactPlatform = platform || contact.platform || "line";
        const aiMsg = storage.createMessage(contact.id, contactPlatform, "ai", returnFormFirstText);
        storage.updateContactConversationFields(contact.id, { return_stage: 1, resolution_status: "awaiting_customer", waiting_for_customer: "return_form_submit" });
        broadcastSSE("new_message", { contact_id: contact.id, message: aiMsg, brand_id: effectiveBrandId || contact.brand_id });
        broadcastSSE("contacts_updated", { brand_id: contact.brand_id });
        if (contactPlatform === "messenger" && channelToken) {
          await sendFBMessage(channelToken, contact.platform_user_id, returnFormFirstText);
        } else if (channelToken) {
          await pushLineMessage(contact.platform_user_id, [{ type: "text", text: returnFormFirstText }], channelToken);
        }
        storage.createAiLog({
          contact_id: contact.id,
          message_id: aiMsg.id,
          brand_id: effectiveBrandId || undefined,
          prompt_summary: `return_form_first: ${userMessage.slice(0, 80)}`,
          knowledge_hits: [],
          tools_called: ["return_form_first"],
          transfer_triggered: false,
          result_summary: "?????????F2 ???",
          token_usage: 0,
          model: "reply-plan",
          response_time_ms: Date.now() - startTime,
          reply_source: "return_form_first",
          used_llm: 0,
          plan_mode: "return_form_first",
          reason_if_bypassed: "return_form_first",
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
        const inferredScope = getProductScopeFromMessage(userMessage);
        if (inferredScope) {
          storage.updateContactConversationFields(contact.id, { product_scope_locked: inferredScope });
        }
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

      const effectiveScope =
        state.product_scope_locked ||
        ((isOrderLookupFamily(planMode) || planMode === "answer_directly") ? getProductScopeFromMessage(userMessage) : null);

      const recentUserHasImage = recentMessages
        .slice(-10)
        .some(
          (m: { sender_type?: string; message_type?: string; image_url?: string | null }) =>
            m.sender_type === "user" &&
            (m.message_type === "image" || !!(m.image_url && String(m.image_url).trim()))
        );
      const enrichedPack = await assembleEnrichedSystemPrompt(contact.brand_id || brandId || undefined, {
        productScope: effectiveScope,
        planMode: plan.mode,
        hasActiveOrderContext: !!storage.getActiveOrderContext(contact.id)?.order_id,
        recentUserHasImage,
      });
      console.log(
        `[prompt_profile=${enrichedPack.prompt_profile}] prompt_chars=${enrichedPack.prompt_chars} catalog_included=${enrichedPack.includes.catalog} knowledge_included=${enrichedPack.includes.knowledge} image_included=${enrichedPack.includes.image} prompt_sections=${enrichedPack.sections.map((s) => s.key).join("|")} prompt_assembly_ms=${Date.now() - startTime}`
      );
      let systemPrompt = enrichedPack.full_prompt;
      if (goalLocked) {
        systemPrompt += `\n\n??????????????${goalLocked}???????????????????`;
      }
      if (planMode === "handoff") {
        systemPrompt += "\n\n??????????????? transfer_to_human???????????????????????????????????????????????????????????????????????????????????????+??????????????/??/????????????????????";
      }
      if (planMode === "off_topic_guard") {
        systemPrompt += "\n\n??? ????????????????????????????????????????????????????????????????????????????????????????????????/??/???? 30?50 ??";
      }
      // ??2?F2 ?? ? ????????????????
      if (plan.must_not_include && plan.must_not_include.length > 0) {
        systemPrompt += "\n\n?????? F2?????????" + plan.must_not_include.map((p) => `?${p}?`).join("?") + "????????????????????????????????";
      }
      if (shouldNotLeadWithOrderLookup(plan, state)) {
        systemPrompt += "\n\n???????????????????????????????????????????????????????????";
      }
      if (isAftersalesComfortFirst(plan)) {
        systemPrompt += "\n\n??? ?????????????????????????????????????? ???????? ? ????/???? 7?20 ??? ? ??????????????????????????????????????????????????????**???????????**??????????????????**????**????????????????????????????";
      }
      if (isOrderLookupFamily(plan.mode)) {
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
      /** 依品牌/渠道設定與對話狀態決定是否允許 AI 回覆或強制轉人工 */
      systemPrompt += "\n\n????????**????**??????????????????????????????????/??/??????????????**????**???????????**??**?????????????????????????????????????????????????????";
      // Mode-specific forbidden content???/??/handoff/order_lookup ?????????????????????
      if (isModeNoPromo(plan.mode)) {
        systemPrompt += "\n\n????????????????????????????????????????????????????????????????";
      }
      if (effectiveScope === "bag") {
        systemPrompt += "\n\n??? ???????????/?????????????????????????";
      }
      if (effectiveScope === "sweet") {
        systemPrompt += "\n\n??? ???????????????????????????????";
      }
      // Hotfix??????????????????
      if (contact.channel_id) {
        systemPrompt += "\n\n??? ??????????????? LINE/??????????????????????????????????????????????????????????????????????";
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
            transfer_reason: "?????????????????",
            result_summary: "????????????",
            token_usage: 0,
            model: "reply-plan",
            response_time_ms: Date.now() - startTime,
            reply_source: "handoff",
            used_llm: 0,
            plan_mode: plan.mode,
            reason_if_bypassed: "already_provided_not_found",
          });
          return;
        }
        const parts = [];
        if (found.orderId) parts.push(`???? ${found.orderId}`);
        if (found.phone) parts.push(`?? ${found.phone}`);
        systemPrompt += "\n\n??? ????????????????????????????????????" + parts.join("?") + "?????????";
      }
      /** Phase 2.2 / 2.4：多筆候選（篩選、第 N 筆、最新／最早、日期、帶出明細） */
      if (isOrderLookupFamily(plan.mode)) {
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
                source_channel: sourceChannelLabel(o.source),
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
            });
            return;
          }
        }
      }
      /** Phase 2.9：單筆 context 下問「還有其他訂單／全部訂單」→ 依手機重查並展開多筆 */
      if (isOrderLookupFamily(plan.mode)) {
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
              });
              return;
            }
          } catch (e29) {
            console.warn("[phase29_more_orders_expand]", (e29 as Error)?.message || e29);
          }
        }
      }
      const openai = new OpenAI({ apiKey });
      let usedFirstLlmTelemetry = 0;
      let usedSecondLlmTelemetry = 0;

      const chatMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        { role: "system", content: systemPrompt },
      ];
      const knowledgeHits: string[] = [];

      for (const msg of recentMessages) {
        if (msg.sender_type === "user") {
          if (msg.message_type === "image" && msg.image_url) {
            const msgDataUri = await imageFileToDataUri(msg.image_url);
            if (msgDataUri) {
              chatMessages.push({ role: "user", content: [
                { type: "text", text: msg.content || "???????" },
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

      const hasImageAssets = storage.getImageAssets(effectiveBrandId || undefined).length > 0;
      const allTools = [...orderLookupTools, ...humanHandoffTools, ...(hasImageAssets ? imageTools : [])];

      const AI_TIMEOUT_MS = 45000;
      const TOOL_TIMEOUT_MS = 25000;

      const streamAbortController = new AbortController();
      const streamTimeout = setTimeout(() => streamAbortController.abort(), AI_TIMEOUT_MS);

      async function callOpenAIWithTimeout(params: Parameters<typeof openai.chat.completions.create>[0]) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
        try {
          const result = await openai.chat.completions.create(params, { signal: controller.signal as any });
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

      let responseMessage: OpenAI.Chat.Completions.ChatCompletionMessage | undefined;
      try {
        responseMessage = await runOpenAIStream(
          openai,
          {
            model: getOpenAIModel(),
            messages: chatMessages,
            tools: allTools,
            max_completion_tokens: 1000,
            temperature: isOrderLookupFamily(plan.mode) ? 0.28 : 0.7,
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
            const comfortMsg = "?????????????????????????????????????????????????";
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
      let loopCount = 0;
      const maxToolLoops = 3;
      const ORDER_LOOKUP_TOOL_NAMES = ["lookup_order_by_id", "lookup_order_by_product_and_phone", "lookup_order_by_date_and_contact", "lookup_more_orders", "lookup_more_orders_shopline", "lookup_order_by_phone"];
      let sentLookupAckThisTurn = false;
      let lookupAckSentMs: number | null = null;
      let firstCustomerVisibleReplyMs: number | null = null;
      let secondLlmSkipped = false;
      let deterministicToolMeta: { renderer?: string; tool_name?: string } = {};

      while (responseMessage?.tool_calls && responseMessage.tool_calls.length > 0 && loopCount < maxToolLoops) {
        loopCount++;
        console.log(`[Webhook AI] ?? ${responseMessage.tool_calls.length} ? Tool Call?? ${loopCount} ??`);
        chatMessages.push(responseMessage as OpenAI.Chat.Completions.ChatCompletionMessageParam);

        const hasOrderLookupTool = responseMessage.tool_calls.some((tc: any) => ORDER_LOOKUP_TOOL_NAMES.includes(tc?.function?.name || ""));
        if (orderFeatureFlags.orderLookupAck && hasOrderLookupTool && !sentLookupAckThisTurn) {
          sentLookupAckThisTurn = true;
          lookupAckSentMs = Date.now() - startTime;
          firstCustomerVisibleReplyMs = lookupAckSentMs;
          console.log(
            `[phase26_latency] lookup_ack_sent_ms=${lookupAckSentMs} contact=${contact.id} queue_wait_ms=0`
          );
          const lookupAckText = "我幫您查詢中～";
          const ackMsg = storage.createMessage(contact.id, contact.platform || "line", "ai", lookupAckText);
          broadcastSSE("new_message", { contact_id: contact.id, message: ackMsg, brand_id: effectiveBrandId || contact.brand_id });
          broadcastSSE("contacts_updated", { brand_id: contact.brand_id });
          if (channelToken && contact.platform === "messenger") {
            sendFBMessage(channelToken, contact.platform_user_id, lookupAckText).catch(() => {});
          } else if (channelToken) {
            pushLineMessage(contact.platform_user_id, [{ type: "text", text: lookupAckText }], channelToken).catch(() => {});
          }
        }

        const recentUserMessagesForLookup = recentMessages
          .filter((m: any) => m.sender_type === "user" && m.content && m.content !== "[????]")
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
        const toolCtx = {
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
                return { toolCall, toolResult: JSON.stringify({ error: true, message: "????????????" }) };
              }
              throw toolErr;
            }
          })
        );

        let orderLookupDeterministicReply: string | null = null;
        /** 同輪多個 tool 皆帶 deterministic 時，以最後一筆為準（與 tool_calls 順序一致） */
        for (const { toolCall, toolResult } of toolResults) {
          chatMessages.push({ role: "tool", tool_call_id: toolCall.id, content: toolResult });
          const fn = (toolCall as { function?: { name?: string; arguments?: string } }).function;
          const fnName = fn?.name ?? "";
          let fnArgs: Record<string, string> = {};
          try { fnArgs = JSON.parse(fn?.arguments ?? "{}"); } catch (_e) {}

          try {
            const pr = JSON.parse(toolResult) as Record<string, unknown>;
            if (
              orderFeatureFlags.genericDeterministicOrder &&
              isValidOrderDeterministicPayload(pr)
            ) {
              orderLookupDeterministicReply = String(pr.deterministic_customer_reply).trim();
              deterministicToolMeta = {
                renderer: typeof pr.renderer === "string" ? pr.renderer : undefined,
                tool_name: fnName,
              };
            }
          } catch (_e) {
            /* ignore */
          }

          if (fnName === "transfer_to_human") {
            transferTriggered = true;
            transferReason = fnArgs.reason || "AI ????????";
            (() => { const { reason, reason_detail } = normalizeHandoffReason(transferReason); applyHandoff({ contactId: contact.id, reason, reason_detail, source: "webhook_tool_call", brandId: effectiveBrandId || undefined }); })();
            const assignedId = assignment.assignCase(contact.id);
            if (assignedId == null && assignment.isAllAgentsUnavailable()) {
              storage.updateContactNeedsAssignment(contact.id, 1);
              const tags = JSON.parse(contact.tags || "[]");
              if (!tags.includes("?????")) {
                storage.updateContactTags(contact.id, [...tags, "?????"]);
              }
              const reason = assignment.getUnavailableReason();
              storage.createMessage(contact.id, contact.platform, "system", getTransferUnavailableSystemMessage(reason));
            }
            const freshContact = storage.getContact(contact.id);
            if (freshContact?.needs_human) {
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

        /** 防呆：LLM 回覆前檢查 loopCount/orderLookupFailed 等，避免重複查單迴圈 */

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

        const loopAbort = new AbortController();
        const loopTimer = setTimeout(() => loopAbort.abort(), AI_TIMEOUT_MS);
        usedSecondLlmTelemetry = 1;
        try {
          responseMessage = await runOpenAIStream(
            openai,
            {
              model: getOpenAIModel(),
              messages: chatMessages,
              tools: allTools,
              max_completion_tokens: 1000,
              temperature: hasOrderLookupTool ? 0.2 : 0.7,
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

      storage.resetConsecutiveTimeouts(contact.id);

      const finalContact = storage.getContact(contact.id);
      /** 若 AI 回覆內容或後處理判定 needs_human，則寫入並轉人工 */
      const shouldSkipPostHandoff = state && isAiHandlableIntent(state.primary_intent);
      if (!shouldSkipPostHandoff && (finalContact?.needs_human || storage.isAiMuted(contact.id) || finalContact?.status === "awaiting_human" || finalContact?.status === "high_risk")) {
        console.log(`[Webhook AI] ???????????? handoff ????? (needs_human=${finalContact?.needs_human}, status=${finalContact?.status})`);
        const recentForHandoff = storage.getMessages(contact.id).slice(-12).map((m: any) => ({ sender_type: m.sender_type, content: m.content, message_type: m.message_type, image_url: m.image_url }));
        const orderInfoForHandoff = searchOrderInfoInRecentMessages(recentForHandoff);
        const handoffReply = buildHandoffReply({
          customerEmotion: state.customer_emotion,
          humanReason: state.human_reason ?? undefined,
          isOrderLookupContext: ORDER_LOOKUP_PATTERNS.test(userMessage),
          hasOrderInfo: !!orderInfoForHandoff.orderId,
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
        });
        return;
      }

      const rawReply = responseMessage?.content;
      let reply = rawReply && rawReply.trim() ? enforceOutputGuard(rawReply.trim(), plan.mode) : rawReply;
      // Post-generation content guard?????? mode ?????????
      if (reply && reply.trim()) {
        const guardResult = runPostGenerationGuard(reply, plan.mode, effectiveScope);
        if (!guardResult.pass) {
          const useCleaned = guardResult.cleaned && guardResult.cleaned.trim();
          reply = useCleaned ? guardResult.cleaned : "????????????????????";
          const outcome = useCleaned ? "cleaned" : "fallback";
          for (const r of (guardResult.reason || "").split(";").filter(Boolean)) {
            recordGuardHit(r as import("../content-guard-stats").GuardRuleId, outcome);
          }
        }
      }
      // Official channel hard guard??????????????????????????????????
      if (reply && reply.trim() && contact.channel_id) {
        const officialGuard = runOfficialChannelGuard(reply);
        if (!officialGuard.pass) {
          const useCleaned = officialGuard.cleaned && officialGuard.cleaned.trim();
          reply = useCleaned ? officialGuard.cleaned : "??????????????";
          recordGuardHit("official_channel_forbidden", useCleaned ? "cleaned" : "fallback");
        }
      }
      // ?? platform hard guard??????????????????????????? mode
      if (reply && reply.trim()) {
        const globalPlatformGuard = runGlobalPlatformGuard(reply);
        if (!globalPlatformGuard.pass) {
          const useCleaned = globalPlatformGuard.cleaned && globalPlatformGuard.cleaned.trim();
          reply = useCleaned ? globalPlatformGuard.cleaned : "??????????????";
          recordGuardHit("global_platform_forbidden", useCleaned ? "cleaned" : "fallback");
        }
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
        reply = ensureShippingSopCompliance(reply, plan.mode, "", userMessage, recentUserTextsForRecency);
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

        const anyLlm = usedFirstLlmTelemetry > 0 || usedSecondLlmTelemetry > 0;
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
          reply_source: secondLlmSkipped ? "deterministic_tool" : "llm",
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
        model: getOpenAIModel(),
        response_time_ms: Date.now() - startTime,
        reply_source: "error",
        used_llm: 0,
        plan_mode: null,
        reason_if_bypassed: `error: ${(err as Error).message}`.slice(0, 200),
      });
    }
  }

  return { autoReplyWithAI, handleImageVisionFirst, analyzeImageWithAI, imageFileToDataUri };
}
