import type { IStorage } from "../storage";
import type { OrderInfo, OrderSource } from "@shared/schema";
import {
  fetchOrders,
  lookupOrdersByPageAndPhone,
  getCachedPages,
  getSuperLandingConfig,
} from "../superlanding";
import {
  unifiedLookupById,
  unifiedLookupByProductAndPhone,
  unifiedLookupByDateAndContact,
  unifiedLookupByPhoneGlobal,
  getUnifiedStatusLabel,
  getPaymentInterpretationForAI,
  shouldDisablePhoneOrderAgeFilter,
} from "../order-service";
import { shouldBypassLocalPhoneIndex } from "../order-lookup-policy";
import { packDeterministicMultiOrderToolResult } from "../order-multi-renderer";
import { getOrdersByPhone, lookupOrdersByProductAliasAndPhoneLocal, normalizePhone } from "../order-index";
import {
  formatOrderOnePage,
  payKindForOrder,
  customerFacingStatusLabel,
  customerFacingPaymentLabel,
  formatExtendedOrderList,
} from "../order-reply-utils";
import { packDeterministicSingleOrderToolResult } from "../order-single-renderer";
import { orderDeterministicContractFields } from "../deterministic-order-contract";
import { buildActiveOrderContextFromOrder } from "../order-active-context";
import { lookupShoplineOrdersByPhoneExact } from "../shopline";
import { classifyOrderNumber } from "../intent-and-order";
import { applyHandoff, normalizeHandoffReason } from "./handoff";
import { finalizeLlmToolJsonString } from "../tool-llm-sanitize";
import { orderFeatureFlags } from "../order-feature-flags";
import type { MessagingOutboundSkipped } from "./messaging.service";

/** 與 ai-reply 轉人工備援句一致，避免客人只看到轉接、沒有任何 AI 對話 */
export const TRANSFER_TOOL_CUSTOMER_ACK = "好的，我這邊幫您轉給專人處理，請稍等一下。";

const SYS_NOTE_ORDER_ONE_PAGE_STRICT =
  "請直接使用 one_page_summary 的內容回覆客人，不要改寫成散文。每一行的欄位（訂單編號、商品、金額、付款、配送、狀態）都要完整保留。如果付款欄位是『貨到付款』『到店付款』『宅配代收』等，絕對不要叫客人去線上付款。";

const SYS_NOTE_ORDER_ONE_PAGE_FULL_STRICT =
  "請直接使用 one_page_full 的完整內容回覆客人（多筆之間已用 --- 分隔），不要改寫成散文；每一筆的欄位都要完整保留。若付款為貨到付款／宅配代收／到店付款，絕對不要叫客人線上付款。";

/** Phase 106：local 命中時對客仍給完整卡片，僅在摘要末附快取免責 */
export const ORDER_LOOKUP_LOCAL_CACHE_DISCLAIMER =
  "\n\n*(註：此為系統快取資料，最新出貨狀態以物流端為準)*";

/** Phase 106.9：by_id live 逾時／失敗，仍用本地快取時的免責 */
export const ORDER_LOOKUP_LIVE_FALLBACK_DISCLAIMER =
  "\n\n*(註：目前無法即時連線取得最新狀態，以上為系統快取資料)*";

/** Phase 106.3：手機查單在此筆數內以完整卡片直出（可調整） */
const LOOKUP_PHONE_FULL_CARD_THRESHOLD = 3;

const PHONE_LOOKUP_INTRO_SINGLE = "依您留的手機查到的訂單如下：\n\n";

function normalizeOrderSourceForOnePage(raw: string | undefined): OrderSource {
  if (raw === "shopline" || raw === "superlanding" || raw === "unknown") return raw;
  return "superlanding";
}

function formatOrdersToolFormattedList(
  rows: Array<{
    order_id: string;
    product_list?: string | null;
    items_structured?: any;
    amount?: unknown;
    status?: string;
    payment_status_label?: string;
  }>
): string {
  return rows
    .map((o) => {
      let products = String(o.product_list ?? "").trim();
      if (!products && Array.isArray(o.items_structured) && o.items_structured.length > 0) {
        products = o.items_structured
          .map((item: any) => item.product_name || item.name || item.item_name || item.title || "未知商品")
          .join("、");
      }
      if (!products && typeof o.items_structured === "string") {
        try {
          const parsed = JSON.parse(o.items_structured);
          if (Array.isArray(parsed) && parsed.length > 0) {
            products = parsed
              .map((item: any) => item.product_name || item.name || item.item_name || item.title || "未知商品")
              .join("、");
          }
        } catch {
          /* ignore */
        }
      }
      products = products ? products.slice(0, 40) : "未提供商品名稱";

      const status = customerFacingStatusLabel(o.status || "");

      const payment = customerFacingPaymentLabel(o.payment_status_label || "");

      return `- ${o.order_id} | ${products} | NT$${o.amount ?? ""} | ${status} | ${payment}`;
    })
    .join("\n");
}

function paymentWarningFromKind(kind: string): string {
  if (kind === "failed") return "【警告】此訂單付款失敗，絕對不可說會出貨";
  if (kind === "pending") return "【注意】此訂單尚未付款，提醒客人先完成付款";
  return "";
}

function appendFailedPaymentMultiNote(baseNote: string, hasFailed: boolean): string {
  if (!hasFailed) return baseNote;
  return `${baseNote}\n其中有付款失敗的訂單，請特別注意。`;
}

function orderItemsStructuredPayload(o: OrderInfo): unknown {
  const x = o as OrderInfo & { items?: unknown };
  const raw = x.items_structured ?? x.items ?? [];
  if (!Array.isArray(raw)) return raw;
  return raw.map((it: unknown) => {
    if (it == null || typeof it !== "object") return it;
    const row = it as Record<string, unknown>;
    const resolved =
      String(
        row.product_name ??
          row.name ??
          row.item_name ??
          row.title ??
          row.product_title ??
          row.variant_title ??
          row.variant_name ??
          ""
      ).trim() || undefined;
    if (resolved && !row.product_name) {
      return { ...row, product_name: resolved };
    }
    return it;
  });
}

export interface ToolExecutorDeps {
  storage: IStorage;
  pushLineMessage: (
    userId: string,
    messages: object[],
    token?: string | null
  ) => Promise<void | MessagingOutboundSkipped>;
  sendFBMessage: (
    pageAccessToken: string,
    recipientId: string,
    text: string
  ) => Promise<void | MessagingOutboundSkipped>;
  broadcastSSE: (eventType: string, data: unknown) => void;
  imageFileToDataUri?: (imageFilePath: string) => Promise<string | null>;
  getTransferUnavailableSystemMessage?: (
    reason: "weekend" | "lunch" | "after_hours" | "all_paused" | null
  ) => string;
}

export interface ToolCallContext {
  contactId?: number;
  brandId?: number;
  channelToken?: string;
  platform?: string;
  platformUserId?: string;
  preferShopline?: boolean;
  userMessage?: string;
  recentUserMessages?: string[];
  /** 純手機等 summary 意圖：禁止回傳單筆明細給 LLM */
  orderLookupSummaryOnly?: boolean;
  /** 外層 autoReplyWithAI / 佇列處理開始時間（用於日誌與耗時對齊） */
  startTime?: number;
  queueWaitMs?: number;
  /** true：本輪 post-handoff 會略過對客句（ai-handlable 意圖），須在此工具內先送轉接確認給客人 */
  expectPostHandoffSkipped?: boolean;
}

export function createToolExecutor(deps: ToolExecutorDeps) {
  const { storage, pushLineMessage, sendFBMessage, broadcastSSE } = deps;

  async function sendImageAsset(
    asset: { id: number; filename: string; display_name: string },
    textMessage: string,
    context?: ToolCallContext
  ): Promise<string> {
    const host = process.env.APP_DOMAIN ? `https://${process.env.APP_DOMAIN}` : `http://localhost:5000`;
    const imageUrl = `${host}/api/image-assets/file/${asset.filename}`;

    if (context?.platform === "messenger" && context?.platformUserId && context?.channelToken) {
      if (textMessage) {
        await sendFBMessage(context.channelToken, context.platformUserId, textMessage);
      }
      await sendFBMessage(
        context.channelToken,
        context.platformUserId,
        `[圖片：${asset.display_name}] ${imageUrl}`
      );
      if (context.contactId) {
        const c = storage.getContact(context.contactId);
        const bid = c?.brand_id ?? undefined;
        if (textMessage) {
          const m = storage.createMessage(context.contactId, "messenger", "ai", textMessage);
          if (bid != null) {
            broadcastSSE("new_message", { contact_id: context.contactId, message: m, brand_id: bid });
            broadcastSSE("contacts_updated", { brand_id: bid });
          }
        }
        const imgMsg = storage.createMessage(context.contactId, "messenger", "ai", `[圖片: ${asset.display_name}]`, "image", imageUrl);
        if (bid != null) {
          broadcastSSE("new_message", { contact_id: context.contactId, message: imgMsg, brand_id: bid });
          broadcastSSE("contacts_updated", { brand_id: bid });
        }
      }
      return JSON.stringify({ success: true, message: `已透過 Messenger 傳送圖片連結：${asset.display_name}` });
    }

    if (context?.platform === "line" && context?.platformUserId && context?.channelToken) {
      const messages: object[] = [];
      if (textMessage) {
        messages.push({ type: "text", text: textMessage });
      }
      messages.push({
        type: "image",
        originalContentUrl: imageUrl,
        previewImageUrl: imageUrl,
      });
      await pushLineMessage(context.platformUserId, messages, context.channelToken);
      if (context.contactId) {
        const c = storage.getContact(context.contactId);
        const bid = c?.brand_id ?? undefined;
        if (textMessage) {
          const m = storage.createMessage(context.contactId, "line", "ai", textMessage);
          if (bid != null) {
            broadcastSSE("new_message", { contact_id: context.contactId, message: m, brand_id: bid });
            broadcastSSE("contacts_updated", { brand_id: bid });
          }
        }
        const imgMsg = storage.createMessage(context.contactId, "line", "ai", `[圖片：${asset.display_name}]`, "image", imageUrl);
        if (bid != null) {
          broadcastSSE("new_message", { contact_id: context.contactId, message: imgMsg, brand_id: bid });
          broadcastSSE("contacts_updated", { brand_id: bid });
        }
      }
      return JSON.stringify({ success: true, message: `已傳送圖片「${asset.display_name}」給客人。` });
    }

    return JSON.stringify({
      success: true,
      message: `已傳送圖片「${asset.display_name}」。`,
      image_url: imageUrl,
      text_message: textMessage,
    });
  }

  async function executeToolCall(
    toolName: string,
    args: Record<string, string>,
    context?: ToolCallContext
  ): Promise<string> {
    const pipelineStartMs = context?.startTime ?? Date.now();
    const queueWaitMs = context?.queueWaitMs ?? 0;
    if (queueWaitMs > 0) {
      console.log(`[ToolExecutor] queue_wait_ms=${queueWaitMs} pipeline_ref_ms=${pipelineStartMs}`);
    }

    if (toolName === "recommend_products") {
      const keyword = String(args.keyword || "").trim();
      if (!keyword) return JSON.stringify({ success: false, error: "請提供商品關鍵字" });

      const brandId = context?.brandId;
      if (!brandId) return JSON.stringify({ success: false, error: "無法判斷品牌" });

      let products = storage.searchProducts(brandId, keyword, 5) as any[];

      if (products.length === 0) {
        const rules = (storage.getMarketingRules(brandId) || []) as any[];
        const matched = rules.filter((r: any) => {
          const rk = (r.keyword || "").toLowerCase();
          const kl = keyword.toLowerCase();
          return rk.includes(kl) || kl.includes(rk);
        });
        if (matched.length > 0) {
          return JSON.stringify({
            success: true,
            found: true,
            source: "marketing_rules",
            results: matched.map((r: any) => ({
              keyword: r.keyword,
              pitch: r.pitch,
              url: r.url || undefined,
            })),
            sys_note: "品牌推廣資訊如下。有連結就提供。",
          });
        }

        const knowledgeFiles = storage.getKnowledgeFiles(brandId) as any[];
        const kMatched = knowledgeFiles.filter((f: any) => {
          const cat = (f.category || "").toLowerCase();
          const intent = (f.intent || "").toLowerCase();
          if (/policy|rule|sop|規則|政策|退換貨|客訴/i.test(cat + " " + intent)) return false;

          const content = (f.content || "").toLowerCase();
          const name = (f.original_name || "").toLowerCase();
          const kl = keyword.toLowerCase();
          return name.includes(kl) || content.includes(kl);
        });
        if (kMatched.length > 0) {
          const snippets = kMatched.slice(0, 2).map((f: any) => {
            const content = f.content || "";
            const idx = content.toLowerCase().indexOf(keyword.toLowerCase());
            const start = Math.max(0, idx - 100);
            const end = Math.min(content.length, idx + 400);
            return { name: f.original_name, snippet: content.substring(start, end).trim() };
          });
          return JSON.stringify({
            success: true,
            found: true,
            source: "knowledge_base",
            results: snippets,
            sys_note: "知識庫相關資訊如下。有價格連結就提供。",
          });
        }

        return JSON.stringify({
          success: true,
          found: false,
          keyword,
          sys_note: "查無商品。不要編造。",
        });
      }

      const results = products.map((p: any) => ({
        title: p.title,
        price: p.price || undefined,
        url: p.url || undefined,
        description: p.description_short || undefined,
        faq: p.faq || undefined,
        order_prefix: p.order_prefix || undefined,
      }));

      return JSON.stringify({
        success: true,
        found: true,
        source: "product_catalog",
        total: results.length,
        products: results,
        sys_note: `找到 ${results.length} 款「${keyword}」相關商品。重點放在特色不是價格。價格講大概就好，務必附銷售頁連結（活動以銷售頁為準）。`,
      });
    }

    if (toolName === "release_handoff_to_ai") {
      const reason = String(args.reason || "").trim();
      if (!reason) {
        return JSON.stringify({ success: false, error: "missing_reason", sys_note: "請在 reason 簡述客人為何改由 AI 服務。" });
      }
      if (!context?.contactId) {
        return JSON.stringify({ success: false, error: "missing_contact" });
      }
      storage.updateContactHumanFlag(context.contactId, 0);
      storage.updateContactStatus(context.contactId, "ai_handling");
      storage.updateContactConversationFields(context.contactId, { human_reason: null });
      const row = storage.getContact(context.contactId);
      storage.createSystemAlert({
        alert_type: "handoff_released_by_ai",
        details: JSON.stringify({
          contactId: context.contactId,
          reason,
          at: new Date().toISOString(),
        }),
        brand_id: row?.brand_id ?? undefined,
        contact_id: context.contactId,
      });
      return JSON.stringify({
        ok: true,
        success: true,
        message: "已為您切換成 AI 服務，請繼續您要詢問的問題",
      });
    }

    if (toolName === "transfer_to_human") {
      const userConfirmed = !!args.user_confirmed;
      const reasonRaw = String(args.reason || "");
      const allowDirectTransfer =
        reasonRaw === "explicit_human_request" ||
        reasonRaw === "high_risk_emotional" ||
        reasonRaw === "complaint_escalation" ||
        reasonRaw === "user_confirmed_transfer";

      if (!allowDirectTransfer && !userConfirmed) {
        return JSON.stringify({
          success: false,
          error: "must_ask_user_first",
          sys_note:
            "你不可以擅自轉接客人。請先用一句話問客人意願：" +
            "「這部分需要請專人協助處理，要幫您轉接嗎？」" +
            "等客人說「好」或「請幫我轉」之後，再呼叫此工具並把 user_confirmed 設為 true。",
        });
      }

      const reason = (args.reason || "AI 判斷需要轉人工").trim();
      console.log(`[AI Tool Call] transfer_to_human???: ${reason}?contactId: ${context?.contactId}`);
      if (context?.contactId) {
        (() => { const norm = normalizeHandoffReason(reason); applyHandoff({ contactId: context.contactId, reason: norm.reason, reason_detail: norm.reason_detail, source: "sandbox_tool_call", platform: context?.platform, brandId: context?.brandId }); })();
        storage.createMessage(context.contactId, context?.platform || "line", "system",
          `(轉接) AI 已觸發轉接人工：${reason}`);
        /** 本輪若會略過 ai-reply post-handoff 對客句，必須在此先送一句給客人（避免 ghosting） */
        if (context.expectPostHandoffSkipped === true) {
          const c = storage.getContact(context.contactId);
          const plat = context.platform || c?.platform || "line";
          const handoffMsg = TRANSFER_TOOL_CUSTOMER_ACK;
          const aiM = storage.createMessage(context.contactId, plat, "ai", handoffMsg);
          const bid = c?.brand_id ?? undefined;
          if (bid != null) {
            broadcastSSE("new_message", { contact_id: context.contactId, message: aiM, brand_id: bid });
            broadcastSSE("contacts_updated", { brand_id: bid });
          }
          if (context.channelToken && context.platformUserId) {
            if (context.platform === "messenger") {
              sendFBMessage(context.channelToken, context.platformUserId, handoffMsg).catch(() => {});
            } else {
              pushLineMessage(context.platformUserId, [{ type: "text", text: handoffMsg }], context.channelToken).catch(() => {});
            }
          }
        }
      }
      return JSON.stringify({ success: true, message: "已轉接人工客服，AI 不再回覆此對話。" });
    }

    if (toolName === "mark_form_submitted") {
      const formType = String(args.form_type || "").trim();
      if (!["cancel", "return", "exchange"].includes(formType)) {
        return JSON.stringify({
          success: false,
          error: "invalid_form_type",
        });
      }

      if (!context?.contactId) {
        return JSON.stringify({ success: false, error: "missing_contact" });
      }

      const contactRow = storage.getContact(context.contactId);
      const expected = contactRow?.waiting_for_customer?.trim() || "";
      if (!expected.endsWith("_form_submit")) {
        return JSON.stringify({
          success: false,
          error: "not_waiting_form",
          sys_note: "目前並非等待表單回填狀態，不要呼叫此工具。",
        });
      }
      const expectedType = expected.replace(/_form_submit$/, "");
      if (expectedType !== formType) {
        const expectedZh =
          expectedType === "cancel" ? "取消" : expectedType === "return" ? "退貨" : expectedType === "exchange" ? "換貨" : expectedType;
        const triedZh =
          formType === "cancel" ? "取消" : formType === "return" ? "退貨" : formType === "exchange" ? "換貨" : formType;
        return JSON.stringify({
          success: false,
          error: "form_type_mismatch",
          sys_note: `表單類型不符：系統正在等待客人完成「${expectedZh}」表單（waiting_for_customer=${expected}），您呼叫的是「${triedZh}」（form_type="${formType}"）。請依對話脈絡改給正確表單或引導客人，不要硬呼叫錯誤的 form_type。正確呼叫應為 form_type="${expectedType}"。`,
        });
      }

      const formTypeZh =
        formType === "cancel" ? "取消" : formType === "return" ? "退貨" : "換貨";

      storage.updateContactHumanFlag(context.contactId, 1);
      storage.updateContactStatus(context.contactId, "awaiting_human");
      storage.updateContactConversationFields(context.contactId, { waiting_for_customer: null });

      storage.createCaseNotification(context.contactId, "in_app", {
        type: "form_submitted",
        form_type: formType,
        priority: "high",
        message: `客戶回報已填寫 ${formTypeZh} 表單，請盡快處理`,
      });

      const plat = context.platform || contactRow?.platform || "line";
      storage.createMessage(
        context.contactId,
        plat,
        "system",
        `[表單提交] 客戶回報已填寫${formTypeZh}表單`
      );

      const bid = contactRow?.brand_id ?? undefined;
      if (bid != null) {
        broadcastSSE("contacts_updated", { brand_id: bid });
        broadcastSSE("new_message", { contact_id: context.contactId, brand_id: bid });
      } else {
        broadcastSSE("contacts_updated", {});
        broadcastSSE("new_message", { contact_id: context.contactId });
      }

      console.log(`[mark_form_submitted] contact=${context.contactId} type=${formType}`);

      return JSON.stringify({
        success: true,
        form_type: formType,
        message:
          "表單提交已記錄，已通知專員。請回覆客人「好的～收到囉，已經幫您加急處理 🙏 專員會盡快主動聯繫您確認後續」",
      });
    }

    if (toolName === "send_image_to_customer") {
      const imageName = (args.image_name || "").trim();
      const textMessage = (args.text_message || "").trim();
      if (!imageName) return JSON.stringify({ success: false, error: "請提供圖片名稱" });

      const asset = storage.getImageAssetByName(imageName, context?.brandId);
      if (!asset) {
        const allAssets = storage.getImageAssets(context?.brandId);
        const fuzzyMatch = allAssets.find(a =>
          a.display_name.includes(imageName) || imageName.includes(a.display_name) ||
          a.original_name.includes(imageName) || (a.keywords && a.keywords.includes(imageName))
        );
        if (!fuzzyMatch) return JSON.stringify({ success: false, error: `找不到圖片：${imageName}` });
        return await sendImageAsset(fuzzyMatch, textMessage, context);
      }
      return await sendImageAsset(asset, textMessage, context);
    }

    const config = getSuperLandingConfig(context?.brandId);
    const hasAnyCreds = (config.merchantNo && config.accessKey) || (() => {
      const shopBrand = context?.brandId ? storage.getBrand(context.brandId) : null;
      return !!shopBrand?.shopline_api_token?.trim();
    })();
    if (!hasAnyCreds) {
      return JSON.stringify({ success: false, error: "目前暫時無法查詢訂單，我先幫您記下來，由專人確認後回覆您。" });
    }

    /** 付款狀態與主流程一致；formatOrderOnePage 使用 order-reply-utils 單一實作 */
    /** 建立或更新 ActiveOrderContext：委派給 buildActiveOrderContextFromOrder（統一 derivePaymentStatus，COD 不誤判 failed） */
    const buildActiveOrderContext = buildActiveOrderContextFromOrder;

    const toolJson = (payload: unknown) =>
      finalizeLlmToolJsonString(toolName, JSON.stringify(payload), {
        userMessage: context?.userMessage,
        recentUserMessages: context?.recentUserMessages,
      });

    try {
      if (toolName === "lookup_order_by_id") {
        const orderIdRaw = (args.order_id || "").trim();
        const orderId = orderIdRaw.toUpperCase();
        console.log(`[AI Tool Call] lookup_order_by_id orderId=${orderId} brandId=${context?.brandId || "?"}`);

        if (!orderId) {
          return toolJson({ success: false, error: "請提供訂單編號" });
        }

        const numberType = classifyOrderNumber(orderIdRaw);
        if (context?.contactId) {
          storage.updateContactOrderNumberType(context.contactId, numberType);
        }
        const orderIdNorm = orderIdRaw.replace(/\s/g, "");
        const isLikelyShoplineId = /^202\d{12,19}$/.test(orderIdNorm);
        if (numberType === "payment_id" && !isLikelyShoplineId) {
          return toolJson({
            success: true,
            found: false,
            not_order_number: true,
            number_type: "payment_id",
            message: "您提供的號碼較像付款／交易編號，不是訂單編號。請提供訂單編號，或改用商品名稱＋手機查詢。",
          });
        }
        if (numberType === "logistics_id") {
          return toolJson({
            success: true,
            found: false,
            not_order_number: true,
            number_type: "logistics_id",
            message: "您提供的號碼較像物流編號，不是訂單編號。請提供訂單編號，或改用商品名稱＋手機查詢。",
          });
        }

        const preferSource = context?.preferShopline ? "shopline" as const : undefined;
        if (preferSource) console.log(`[AI Tool Call] 官網查單：優先 SHOPLINE`);
        const result = await unifiedLookupById(config, orderId, context?.brandId, preferSource, false);

        if (!result.found || result.orders.length === 0) {
          console.log(`[AI Tool Call] lookup_order_by_id 查無: ${orderId}`);
          return toolJson({ success: true, found: false, message: `查無單號 ${orderId}。請確認單號正確，或改用手機號碼查詢。` });
        }

        const order = result.orders[0];
        const statusLabel = getUnifiedStatusLabel(order.status, result.source);
        console.log(`[AI Tool Call] lookup_order_by_id 命中: ${orderId} source=${result.source} status=${statusLabel}`);

        if (context?.contactId) {
          storage.updateContactOrderSource(context.contactId, result.source);
        }

        const payment_interpretation = getPaymentInterpretationForAI(order, statusLabel, order.source || result.source);
        const pkId = payKindForOrder(order, statusLabel, order.source || result.source);
        const orderPayload = {
          order_id: order.global_order_id,
          status: customerFacingStatusLabel(statusLabel),
          fulfillment_status_raw: order.status ?? undefined,
          amount: order.final_total_order_amount,
          product_list: order.product_list,
          items_structured: orderItemsStructuredPayload(order),
          buyer_name: order.buyer_name,
          buyer_phone: order.buyer_phone,
          address: order.address,
          full_address: order.full_address,
          cvs_brand: order.cvs_brand,
          cvs_store_name: order.cvs_store_name,
          store_location: order.store_location,
          delivery_target_type: order.delivery_target_type,
          tracking_number: order.tracking_number,
          created_at: order.created_at,
          shipped_at: order.shipped_at,
          shipping_method: order.shipping_method,
          payment_method: order.payment_method,
          payment_status: pkId.kind,
          payment_status_label: pkId.label,
          payment_warning: paymentWarningFromKind(pkId.kind),
          source: order.source || result.source,
          prepaid: order.prepaid,
          paid_at: order.paid_at,
        };
        const lookupDisclaimer =
          result.data_coverage === "local_stale_fallback"
            ? ORDER_LOOKUP_LIVE_FALLBACK_DISCLAIMER
            : result.data_coverage === "local_only"
              ? ORDER_LOOKUP_LOCAL_CACHE_DISCLAIMER
              : "";
        const one_page_summary = formatOrderOnePage(orderPayload) + lookupDisclaimer;
        if (context?.contactId) {
          storage.linkOrderForContact(context.contactId, order.global_order_id, "ai_lookup");
          const activeCtx = buildActiveOrderContext(order, result.source, statusLabel, one_page_summary, "text");
          storage.setActiveOrderContext(context.contactId, activeCtx);
        }

        /** 與 lookup_order_by_phone 單筆相同契約：略過第二輪 LLM，對客直出 one_page_summary（付款失敗改交 LLM 語氣安撫） */
        const paymentKind = pkId.kind;
        const summaryTrim = one_page_summary.trim();
        const allowDeterministicByPayment =
          paymentKind === "success" || paymentKind === "cod" || paymentKind === "pending";
        const allowDeterministic =
          orderFeatureFlags.phoneOrderDeterministicReply &&
          allowDeterministicByPayment &&
          summaryTrim.length > 50;

        return toolJson({
          success: true,
          found: true,
          source: result.source,
          order: orderPayload,
          payment_interpretation,
          one_page_summary,
          sys_note: SYS_NOTE_ORDER_ONE_PAGE_STRICT,
          ...packDeterministicSingleOrderToolResult({
            renderer: "deterministic_single_by_id",
            one_page_summary,
            source: result.source,
          }),
          ...(allowDeterministic
            ? {
                deterministic_skip_llm: true,
                deterministic_customer_reply: one_page_summary.trim(),
              }
            : {}),
        });
      }

      if (toolName === "lookup_order_by_product_and_phone") {
        const toolStartMs = context?.startTime ?? Date.now();
        const productName = (args.product_name || "").trim();
        const productIndex = args.product_index ? parseInt(String(args.product_index)) : 0;
        const phone = (args.phone || "").trim();
        console.log("[AI Tool Call] lookup_order_by_product_and_phone???:", productName, "index:", productIndex, "??:", phone);

        if (!phone) {
          return toolJson({ success: false, error: "請提供手機號碼" });
        }

        if (!productName && !productIndex) {
          console.log("[AI Tool Call] lookup_order_by_product_and_phone 缺少商品或索引");
          return toolJson({
            success: false,
            error: "請提供 product_index 或商品名稱其中至少一項，才能以商品＋手機查詢。",
            require_product: true,
          });
        }

        if (context?.brandId && productName) {
          let localHits = lookupOrdersByProductAliasAndPhoneLocal(context.brandId, phone, productName);
          if (context?.preferShopline) {
            const sh = localHits.filter((o) => o.source === "shopline");
            if (sh.length > 0) localHits = sh;
          }
          if (localHits.length > 0) {
            console.log(`[order_lookup] product_phone local_hit n=${localHits.length}`);
            const orderSource = localHits.every((o) => o.source === "shopline")
              ? "shopline"
              : localHits.every((o) => o.source === "superlanding")
                ? "superlanding"
                : "unknown";
            if (localHits.length === 1) {
              const order = localHits[0];
              const statusLabel = getUnifiedStatusLabel(order.status, order.source || orderSource);
              const payment_interpretation = getPaymentInterpretationForAI(order, statusLabel, order.source || orderSource);
              const orderPayload = {
                order_id: order.global_order_id,
                status: customerFacingStatusLabel(statusLabel),
                amount: order.final_total_order_amount,
                product_list: order.product_list,
                buyer_name: order.buyer_name,
                buyer_phone: order.buyer_phone,
                address: order.address,
                full_address: order.full_address,
                cvs_brand: order.cvs_brand,
                cvs_store_name: order.cvs_store_name,
                delivery_target_type: order.delivery_target_type,
                tracking_number: order.tracking_number,
                created_at: order.created_at,
                shipped_at: order.shipped_at,
                shipping_method: order.shipping_method,
                payment_method: order.payment_method,
              };
              const pkPp = payKindForOrder(order, statusLabel, order.source || orderSource);
              const orderPayloadL = { ...orderPayload, payment_status_label: pkPp.label };
              const one_page_summary =
                formatOrderOnePage(orderPayloadL) + ORDER_LOOKUP_LOCAL_CACHE_DISCLAIMER;
              if (context?.contactId) {
                storage.linkOrderForContact(context.contactId, order.global_order_id, "ai_lookup");
                storage.setActiveOrderContext(
                  context.contactId,
                  buildActiveOrderContext(order, order.source || orderSource, statusLabel, one_page_summary, "product_phone")
                );
              }
              return toolJson({
                success: true,
                found: true,
                source: order.source || orderSource,
                local_hit: true,
                order: orderPayloadL,
                payment_interpretation,
                one_page_summary,
                ...packDeterministicSingleOrderToolResult({
                  renderer: "deterministic_single_product_phone",
                  one_page_summary,
                  source: order.source || orderSource,
                }),
              });
            }
            const sorted = [...localHits].sort((a, b) =>
              String(b.created_at || b.order_created_at || "").localeCompare(String(a.created_at || a.order_created_at || ""))
            );
            const n = sorted.length;
            const orderSummaries = sorted.map((o) => {
              const src = o.source || orderSource;
              const st = getUnifiedStatusLabel(o.status, src);
              const { kind, label } = payKindForOrder(o, st, src);
              return {
                order_id: o.global_order_id,
                status: customerFacingStatusLabel(st),
                amount: o.final_total_order_amount,
                product_list: o.product_list,
                buyer_name: o.buyer_name,
                buyer_phone: o.buyer_phone,
                source: src,
                payment_status: kind,
                payment_status_label: label,
                payment_interpretation: getPaymentInterpretationForAI(o, st, src),
                payment_warning: paymentWarningFromKind(kind),
                items_structured: orderItemsStructuredPayload(o),
                created_at: o.created_at,
              };
            });
            const succ = orderSummaries.filter((x) => x.payment_status === "success").length;
            const fail = orderSummaries.filter((x) => x.payment_status === "failed").length;
            const pend = orderSummaries.filter((x) => x.payment_status === "pending").length;
            const codn = orderSummaries.filter((x) => x.payment_status === "cod").length;
            const partsAgg: string[] = [];
            if (succ) partsAgg.push(`${succ} 筆付款成功`);
            if (fail) partsAgg.push(`${fail} 筆未成立／失敗`);
            if (pend) partsAgg.push(`${pend} 筆待付款`);
            if (codn) partsAgg.push(`${codn} 筆貨到付款`);
            const aggStr = partsAgg.length ? partsAgg.join("、") : "詳見下列";
            const top3 = sorted.slice(0, 3);
            const lines = top3.map((o, i) => {
              const src = o.source || orderSource;
              const st = getUnifiedStatusLabel(o.status, src);
              const { label } = payKindForOrder(o, st, src);
              const tag = "";
              return `${i + 1}. ${tag}${o.global_order_id}｜${o.created_at || ""}｜${label}｜${customerFacingStatusLabel(st)}`;
            });
            const deterministicReply =
              `商品「${productName.slice(0, 40)}」+ 手機｜${n} 筆｜${aggStr}\n` +
              lines.join("\n") +
              (n > 3 ? `\n另有 ${n - 3} 筆未列出` : "") +
              `\n回覆訂單編號以選定訂單`;
            const o0 = sorted[0];
            const status0 = getUnifiedStatusLabel(o0.status, o0.source || orderSource);
            const candidates = sorted.map((o) => {
              const src = o.source || orderSource;
              const st = getUnifiedStatusLabel(o.status, src);
              const { kind, label } = payKindForOrder(o, st, src);
              return {
                order_id: o.global_order_id,
                payment_status: kind as "success" | "failed" | "pending" | "cod" | "unknown",
                payment_status_label: label,
                fulfillment_status: customerFacingStatusLabel(st),
                order_time: o.created_at || o.order_created_at,
                source: (src === "shopline" || src === "superlanding" ? src : undefined) as
                  | "shopline"
                  | "superlanding"
                  | undefined,
              };
            });
            const successful_order_ids = candidates.filter((c) => c.payment_status === "success").map((c) => c.order_id);
            const failed_order_ids = candidates.filter((c) => c.payment_status === "failed").map((c) => c.order_id);
            const pending_order_ids = candidates.filter((c) => c.payment_status === "pending").map((c) => c.order_id);
            const cod_order_ids = candidates.filter((c) => c.payment_status === "cod").map((c) => c.order_id);
            if (context?.contactId) {
              storage.setActiveOrderContext(context.contactId, {
                ...buildActiveOrderContextFromOrder(o0, o0.source || orderSource, status0, deterministicReply, "product_phone"),
                candidate_count: n,
                active_order_candidates: candidates,
                selected_order_id: null,
                last_lookup_source: orderSource,
                aggregate_payment_summary: aggStr,
                one_page_summary: deterministicReply,
                candidate_source_summary: "商品+手機",
                successful_order_ids,
                failed_order_ids,
                pending_order_ids,
                cod_order_ids,
                selected_order_rank: null,
              });
            }
            console.log(`[order_lookup] product_phone local_multi deterministic n=${n}`);
            const hasFailedLocal = orderSummaries.some((x) => x.payment_status === "failed");
            return toolJson({
              success: true,
              found: true,
              total: n,
              local_hit: true,
              source: orderSource,
              orders: orderSummaries,
              deterministic_skip_llm: false,
              ...orderDeterministicContractFields(),
              renderer: "deterministic_product_phone_local",
              note: appendFailedPaymentMultiNote(
                `本地商品+手機命中 ${n} 筆；請依 orders 產生對客回覆。`,
                hasFailedLocal
              ),
              formatted_list: formatOrdersToolFormattedList(orderSummaries),
            });
          }
        }

        const pages = getCachedPages();

        const stripClean = (s: string) => s
          .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, "")
          .replace(/[，。．、；：？！「」『』（）【】《》／・]/g, "")
          .replace(/[^\p{L}\p{N}]/gu, "")
          .toLowerCase();

        let matchedPages: typeof pages = [];

        if (productIndex > 0 && productIndex <= pages.length) {
          matchedPages = [pages[productIndex - 1]];
          console.log("[AI Tool Call] product_index #" + productIndex + " 命中:", matchedPages[0].productName);
        }

        if (matchedPages.length === 0 && productName) {
          const cleanInput = stripClean(productName);
          const inputTokens = productName.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").split(/\s+/).filter(t => t.length > 0);
          console.log("[AI Tool Call] 商品關鍵字:", cleanInput, "tokens:", inputTokens);

          matchedPages = pages.filter(p => stripClean(p.productName) === cleanInput);

          if (matchedPages.length === 0) {
            matchedPages = pages.filter(p => stripClean(p.productName).includes(cleanInput));
          }

          if (matchedPages.length === 0 && cleanInput.length >= 2) {
            matchedPages = pages.filter(p => cleanInput.includes(stripClean(p.productName)));
          }

          if (matchedPages.length === 0 && inputTokens.length > 0) {
            const scored = pages.map(p => {
              const cleanName = stripClean(p.productName);
              let score = 0;
              for (const token of inputTokens) {
                const cleanToken = stripClean(token);
                if (cleanToken.length >= 2 && cleanName.includes(cleanToken)) {
                  score += cleanToken.length;
                }
              }
              return { page: p, score };
            }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);

            if (scored.length > 0) {
              const topScore = scored[0].score;
              const topMatches = scored.filter(s => s.score === topScore);
              const uniqueNames = new Set(topMatches.map(s => stripClean(s.page.productName)));
              if (uniqueNames.size <= 3) {
                matchedPages = topMatches.map(s => s.page);
              } else {
                const candidates = topMatches.slice(0, 5);
                console.log("[AI Tool Call] 多個候選商品:", candidates.map(s => s.page.productName));
                const matchList = candidates.map((s, i) => `#${pages.indexOf(s.page) + 1} ${s.page.productName}`).join("\n");
                return toolJson({
                  success: true,
                  found: false,
                  ambiguous: true,
                  message: `找到多個可能商品，請向客人確認是哪一個：\n${matchList}`,
                  candidates: candidates.map(s => ({ index: pages.indexOf(s.page) + 1, name: s.page.productName })),
                });
              }
            }
          }
        }

        if (matchedPages.length === 0) {
          const knowledgeFiles = storage.getKnowledgeFiles(context?.brandId);
          for (const kf of knowledgeFiles) {
            if (!kf.content) continue;
            const lines = kf.content.split(/\r?\n/);
            for (const line of lines) {
              const cols = line.split(",");
              if (cols.length < 4) continue;
              const officialName = cols[0]?.trim();
              const keywords = cols[1]?.trim();
              const pageIdStr = cols[3]?.trim();
              const pageId = parseInt(pageIdStr);
              if (!officialName || isNaN(pageId) || pageId <= 0) continue;

              const allNames = [officialName, ...(keywords ? keywords.split(/[?,?]/) : [])].map(n => stripClean(n.trim()));
              const cleanInput = stripClean(productName);
              const matched = allNames.some(n => n.length >= 2 && (n.includes(cleanInput) || cleanInput.includes(n)));
              if (matched) {
                console.log(`[AI Tool Call] 知識庫命中: ${productName} -> ${officialName} page_id=${pageId}`);
                matchedPages = [{ id: String(pageId), pageId: pageId.toString(), prefix: officialName, productName: officialName }];
                break;
              }
            }
            if (matchedPages.length > 0) break;
          }
        }

        if (matchedPages.length === 0) {
          console.log("[AI Tool Call] 無法匹配商品或 page_id:", productName);
          return toolJson({
            success: false,
            error: `找不到商品 ${productName} 的對應資訊，請改用純手機查詢。`,
            require_product: true,
          });
        }

        console.log("[AI Tool Call] 匹配商品數:", matchedPages.length, "前幾筆:", matchedPages.slice(0, 5).map(p => `${p.productName}(${p.pageId})`).join(", "), matchedPages.length > 5 ? "..." : "");
        let allResults: any[] = [];
        let orderSource: string = "superlanding";
        const preferSourceProduct = context?.preferShopline ? "shopline" as const : undefined;

        if (preferSourceProduct) {
          console.log("[AI Tool Call] 商品+手機：優先 SHOPLINE");
          const unifiedResult = await unifiedLookupByProductAndPhone(config, matchedPages, phone, context?.brandId, preferSourceProduct, false, productName);
          if (unifiedResult.found) {
            allResults = unifiedResult.orders;
            orderSource = unifiedResult.source;
          }
        }
        if (allResults.length === 0) {
          const searchBatchSize = 3;
          for (let bi = 0; bi < matchedPages.length; bi += searchBatchSize) {
            const batch = matchedPages.slice(bi, bi + searchBatchSize);
            const batchResults = await Promise.all(
              batch.map(mp => lookupOrdersByPageAndPhone(config, mp.pageId, phone))
            );
            for (const br of batchResults) {
              allResults = allResults.concat(br.orders);
            }
          }
        }
        if (allResults.length === 0) {
          console.log(`[AI Tool Call] Brand ${context?.brandId || "?"} SuperLanding 無命中，嘗試 unified（含 SHOPLINE）...`);
          const unifiedResult = await unifiedLookupByProductAndPhone(config, matchedPages, phone, context?.brandId, preferSourceProduct, false, productName);
          if (unifiedResult.found) {
            allResults = unifiedResult.orders;
            orderSource = unifiedResult.source;
          }
        }

        if (allResults.length === 0) {
          console.log("[AI Latency] tool lookup_order_by_product_and_phone (no match) done in", Date.now() - toolStartMs, "ms");
          return toolJson({ success: true, found: false, message: "在此手機與商品條件下查無訂單。" });
        }

        const seenIds = new Set<string>();
        const uniqueOrders = allResults.filter(o => {
          const id = (o.global_order_id || "").trim().toUpperCase();
          if (!id || seenIds.has(id)) return false;
          seenIds.add(id);
          return true;
        });

        if (context?.contactId) {
          storage.updateContactOrderSource(context.contactId, orderSource);
        }

        const srcNorm =
          orderSource === "shopline" || orderSource === "superlanding" ? orderSource : "superlanding";
        if (uniqueOrders.length > 1 && context?.contactId) {
          console.log(
            `[deterministic_skip_llm=true] renderer=product_phone_api_multi api_hit=1 n=${uniqueOrders.length}`
          );
          console.log("[AI Latency] tool lookup_order_by_product_and_phone done in", Date.now() - toolStartMs, "ms");
          return toolJson(
            packDeterministicMultiOrderToolResult({
              orders: uniqueOrders,
              orderSource: srcNorm,
              headerLine: `依商品與手機查到`,
              contactId: context.contactId,
              storage,
              matchedBy: "product_phone",
              renderer: "deterministic_product_phone_api",
            })
          );
        }

        if (uniqueOrders.length === 1) {
          const o0 = uniqueOrders[0];
          const st0 = getUnifiedStatusLabel(o0.status, o0.source || orderSource);
          const pk0 = payKindForOrder(o0, st0, o0.source || orderSource);
          const ol = {
            order_id: o0.global_order_id,
            status: customerFacingStatusLabel(st0),
            amount: o0.final_total_order_amount,
            product_list: o0.product_list,
            buyer_name: o0.buyer_name,
            buyer_phone: o0.buyer_phone,
            created_at: o0.created_at,
            payment_status_label: pk0.label,
            shipping_method: o0.shipping_method,
            tracking_number: o0.tracking_number,
            full_address: o0.full_address,
            cvs_brand: o0.cvs_brand,
            cvs_store_name: o0.cvs_store_name,
            delivery_target_type: o0.delivery_target_type,
          };
          const one_page_summary = formatOrderOnePage(ol);
          if (context?.contactId) {
            storage.linkOrderForContact(context.contactId, o0.global_order_id, "ai_lookup");
            storage.setActiveOrderContext(
              context.contactId,
              buildActiveOrderContext(o0, o0.source || orderSource, st0, one_page_summary, "product_phone")
            );
          }
          console.log("[AI Latency] tool lookup_order_by_product_and_phone done in", Date.now() - toolStartMs, "ms");
          return toolJson({
            success: true,
            found: true,
            total: 1,
            orders: [
              {
                order_id: o0.global_order_id,
                status: customerFacingStatusLabel(st0),
                amount: o0.final_total_order_amount,
                product_list: o0.product_list,
                buyer_name: o0.buyer_name,
                buyer_phone: o0.buyer_phone,
                address: o0.address,
                full_address: o0.full_address,
                cvs_brand: o0.cvs_brand,
                cvs_store_name: o0.cvs_store_name,
                delivery_target_type: o0.delivery_target_type,
                tracking_number: o0.tracking_number,
                created_at: o0.created_at,
                shipped_at: o0.shipped_at,
                shipping_method: o0.shipping_method,
                payment_method: o0.payment_method,
                source: o0.source || orderSource,
              },
            ],
            api_hit: true,
            one_page_summary,
            ...packDeterministicSingleOrderToolResult({
              renderer: "deterministic_single_product_phone_api",
              one_page_summary,
              source: o0.source || orderSource,
            }),
          });
        }

        const orderSummaries = uniqueOrders.map((o) => {
          const src = o.source || orderSource;
          const st = getUnifiedStatusLabel(o.status, src);
          const { kind, label } = payKindForOrder(o, st, src);
          return {
            order_id: o.global_order_id,
            status: customerFacingStatusLabel(st),
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
            source: src,
            items_structured: orderItemsStructuredPayload(o),
            payment_status: kind,
            payment_status_label: label,
            payment_interpretation: getPaymentInterpretationForAI(o, st, src),
            payment_warning: paymentWarningFromKind(kind),
          };
        });

        console.log("[AI Tool Call] lookup_order_by_product_and_phone 多筆訂單 n=", uniqueOrders.length);
        const formattedList = formatOrdersToolFormattedList(orderSummaries);
        const onePageBlocks = orderSummaries.map((o) => formatOrderOnePage(o));
        const one_page_full = onePageBlocks.join("\n\n---\n\n");
        const hasFailedProductMulti = orderSummaries.some((x) => x.payment_status === "failed");
        const multiOrderNote = appendFailedPaymentMultiNote(
          `【重要】以下共 ${uniqueOrders.length} 筆訂單。回覆時必須逐筆列出每筆的完整資訊（訂單編號、姓名、下單日期、金額、狀態、付款方式、配送方式等），不可只列一筆。請直接將下方 one_page_full 的內容完整呈現給客戶。\n簡表：\n${formattedList}`,
          hasFailedProductMulti
        );
        console.log("[AI Latency] tool lookup_order_by_product_and_phone done in", Date.now() - toolStartMs, "ms");
        return toolJson({ success: true, found: true, total: uniqueOrders.length, orders: orderSummaries, note: multiOrderNote, formatted_list: formattedList, one_page_full });
      }

      if (toolName === "lookup_order_by_date_and_contact") {
        const dateToolStartMs = context?.startTime ?? Date.now();
        const contact = (args.contact || "").trim();
        const beginDate = (args.begin_date || "").trim();
        const endDate = (args.end_date || "").trim();
        const pageId = (args.page_id || "").trim();
        console.log("[AI Tool Call] lookup_order_by_date_and_contact???:", contact, "??:", beginDate, "~", endDate, "page_id:", pageId || "(?)");

        if (!contact || !beginDate || !endDate) {
          return toolJson({ success: false, error: "請提供聯絡方式與起訖日期" });
        }

        const diffDays = Math.round((new Date(endDate).getTime() - new Date(beginDate).getTime()) / (1000 * 60 * 60 * 24));
        if (diffDays > 31) {
          return toolJson({ success: false, error: "查詢日期範圍不可超過 31 天" });
        }

        const fetchParams: Record<string, string> = {
          begin_date: beginDate,
          end_date: endDate,
        };
        if (pageId) {
          fetchParams.page_id = pageId;
        } else {
          console.warn("[AI Tool Call] lookup_order_by_date_and_contact 未傳 page_id，將以日期區間搜尋（最多 31 天）");
        }

        let page = 1;
        const perPage = 200;
        const maxPages = 25;
        let allOrders: OrderInfo[] = [];
        let truncated = false;

        while (true) {
          const orders = await fetchOrders(config, {
            ...fetchParams,
            per_page: String(perPage),
            page: String(page),
          });
          allOrders = allOrders.concat(orders);
          if (orders.length < perPage) break;
          page++;
          if (page > maxPages) {
            truncated = true;
            break;
          }
        }

        const normalizedQuery = contact.replace(/[-\s]/g, "").toLowerCase();
        const matched = allOrders.filter((o) => {
          const phone = o.buyer_phone.replace(/[-\s]/g, "").toLowerCase();
          const email = o.buyer_email.toLowerCase();
          const name = o.buyer_name.toLowerCase();
          return (
            (phone && (phone.includes(normalizedQuery) || normalizedQuery.includes(phone))) ||
            (email && email === normalizedQuery) ||
            (name && name.includes(normalizedQuery))
          );
        });

        let dateOrderSource: string = "superlanding";

        if (matched.length === 0) {
          console.log("[AI Tool Call] SuperLanding 無命中，改查 SHOPLINE...");
          const preferSourceDate = context?.preferShopline ? "shopline" as const : undefined;
          const unifiedResult = await unifiedLookupByDateAndContact(config, contact, beginDate, endDate, pageId, context?.brandId, preferSourceDate);
          if (unifiedResult.found) {
            matched.push(...unifiedResult.orders);
            dateOrderSource = unifiedResult.source;
          }
        }

        if (matched.length === 0) {
          return toolJson({ success: true, found: false, message: "此日期區間查無訂單" });
        }

        if (context?.contactId) {
          storage.updateContactOrderSource(context.contactId, dateOrderSource);
        }

        const dSrc =
          dateOrderSource === "shopline" || dateOrderSource === "superlanding"
            ? dateOrderSource
            : "superlanding";
        if (matched.length > 1 && context?.contactId) {
          console.log(
            `[deterministic_skip_llm=true] renderer=deterministic_date_contact n=${matched.length} local_hit=${matched.length > 0}`
          );
          console.log("[AI Latency] tool lookup_order_by_date_and_contact done in", Date.now() - dateToolStartMs, "ms");
          return toolJson(
            packDeterministicMultiOrderToolResult({
              orders: matched,
              orderSource: dSrc,
              headerLine: `依日期 ${beginDate}～${endDate} 查到`,
              contactId: context.contactId,
              storage,
              matchedBy: "text",
              renderer: "deterministic_date_contact",
            })
          );
        }

        if (matched.length === 1) {
          const o0 = matched[0];
          const st0 = getUnifiedStatusLabel(o0.status, o0.source || dateOrderSource);
          const pk0 = payKindForOrder(o0, st0, o0.source || dateOrderSource);
          const ob0 = formatOrderOnePage({
            order_id: o0.global_order_id,
            status: customerFacingStatusLabel(st0),
            amount: o0.final_total_order_amount,
            product_list: o0.product_list,
            buyer_name: o0.buyer_name,
            buyer_phone: o0.buyer_phone,
            created_at: o0.created_at,
            payment_status_label: pk0.label,
            shipping_method: o0.shipping_method,
            tracking_number: o0.tracking_number,
            full_address: o0.full_address,
            cvs_brand: o0.cvs_brand,
            cvs_store_name: o0.cvs_store_name,
            delivery_target_type: o0.delivery_target_type,
          });
          if (context?.contactId) {
            storage.linkOrderForContact(context.contactId, o0.global_order_id, "ai_lookup");
            storage.setActiveOrderContext(
              context.contactId,
              buildActiveOrderContextFromOrder(o0, o0.source || dateOrderSource, st0, ob0, "text")
            );
          }
          const orderSummariesOne = [
            {
              order_id: o0.global_order_id,
              status: customerFacingStatusLabel(st0),
              amount: o0.final_total_order_amount,
              product_list: o0.product_list,
              buyer_name: o0.buyer_name,
              buyer_phone: o0.buyer_phone,
              address: o0.address,
              full_address: o0.full_address,
              cvs_brand: o0.cvs_brand,
              cvs_store_name: o0.cvs_store_name,
              delivery_target_type: o0.delivery_target_type,
              tracking_number: o0.tracking_number,
              created_at: o0.created_at,
              shipped_at: o0.shipped_at,
              shipping_method: o0.shipping_method,
              payment_method: o0.payment_method,
              source: o0.source || dateOrderSource,
              items_structured: orderItemsStructuredPayload(o0),
              payment_status: pk0.kind,
              payment_status_label: pk0.label,
              payment_interpretation: getPaymentInterpretationForAI(o0, st0, o0.source || dateOrderSource),
              payment_warning: paymentWarningFromKind(pk0.kind),
            },
          ];
          console.log("[AI Latency] tool lookup_order_by_date_and_contact done in", Date.now() - dateToolStartMs, "ms");
          return toolJson({
            success: true,
            found: true,
            total: 1,
            orders: orderSummariesOne,
            truncated,
            one_page_summary: ob0,
            ...packDeterministicSingleOrderToolResult({
              renderer: "deterministic_single_date_contact",
              one_page_summary: ob0,
              source: dSrc,
            }),
          });
        }

        const orderSummaries = matched.map((o) => {
          const src = normalizeOrderSourceForOnePage(o.source || dateOrderSource);
          const st = getUnifiedStatusLabel(o.status, src);
          const { kind, label } = payKindForOrder(o, st, src);
          return {
            order_id: o.global_order_id,
            status: customerFacingStatusLabel(st),
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
            source: src,
            items_structured: orderItemsStructuredPayload(o),
            payment_status: kind,
            payment_status_label: label,
            payment_interpretation: getPaymentInterpretationForAI(o, st, src),
            payment_warning: paymentWarningFromKind(kind),
          };
        });

        console.log("[AI Tool Call] lookup_order_by_date_and_contact 命中 n=", matched.length);
        const dateFormattedList = formatOrdersToolFormattedList(orderSummaries);
        const onePageBlocks = orderSummaries.map((o) => formatOrderOnePage(o));
        const one_page_full = onePageBlocks.join("\n\n---\n\n");
        const hasFailedDateMulti = orderSummaries.some((x) => x.payment_status === "failed");
        const multiOrderNote =
          matched.length > 1
            ? appendFailedPaymentMultiNote(
                `【重要】以下共 ${matched.length} 筆訂單。回覆時必須逐筆列出每筆的完整資訊（訂單編號、姓名、下單日期、金額、狀態、付款方式、配送方式等），不可只列一筆。請直接將下方 one_page_full 的內容完整呈現給客戶。\n簡表：\n${dateFormattedList}`,
                hasFailedDateMulti
              )
            : undefined;
        console.log("[AI Latency] tool lookup_order_by_date_and_contact done in", Date.now() - dateToolStartMs, "ms");
        return toolJson({ success: true, found: true, total: matched.length, orders: orderSummaries, truncated, note: multiOrderNote, formatted_list: matched.length > 1 ? dateFormattedList : undefined, one_page_summary: matched.length === 1 ? onePageBlocks[0] : undefined, one_page_full });
      }

      if (toolName === "lookup_more_orders") {
        const phone = (args.phone || "").trim();
        let pageId = (args.page_id || "").trim();
        if (!pageId && context?.contactId) {
          const activeCtx = storage.getActiveOrderContext(context.contactId);
          if (activeCtx?.page_id) pageId = activeCtx.page_id;
        }
        if (!phone) {
          return toolJson({ success: false, error: "請提供手機號碼" });
        }
        if (!pageId) {
          return toolJson({ success: false, error: "無法取得 page_id（請先以商品+手機查單，或傳入 page_id）" });
        }
        const result = await lookupOrdersByPageAndPhone(config, pageId, phone);
        const orders = result.orders;
        if (orders.length === 0) {
          return toolJson({ success: true, found: false, message: "此頁+此手機無其他訂單" });
        }
        orders.forEach((o: OrderInfo) => { o.source = "superlanding"; });
        if (orders.length > 1 && context?.contactId) {
          console.log(`[deterministic_skip_llm=true] renderer=deterministic_more_orders_sl n=${orders.length} api_hit=1`);
          return toolJson(
            packDeterministicMultiOrderToolResult({
              orders,
              orderSource: "superlanding",
              headerLine: "此銷售頁＋手機查到",
              contactId: context.contactId,
              storage,
              matchedBy: "text",
              renderer: "deterministic_more_orders_sl",
            })
          );
        }
        const orderSummaries = orders.map((o) => {
          const st = getUnifiedStatusLabel(o.status, "superlanding");
          const { kind, label } = payKindForOrder(o, st, "superlanding");
          return {
            order_id: o.global_order_id,
            status: customerFacingStatusLabel(st),
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
            source: "superlanding" as const,
            items_structured: orderItemsStructuredPayload(o),
            payment_status: kind,
            payment_status_label: label,
            payment_interpretation: getPaymentInterpretationForAI(o, st, "superlanding"),
            payment_warning: paymentWarningFromKind(kind),
          };
        });
        const formattedList = formatOrdersToolFormattedList(orderSummaries);
        const onePageBlocks = orderSummaries.map((o) => formatOrderOnePage(o));
        const one_page_full = onePageBlocks.join("\n\n---\n\n");
        const hasFailedMoreSl = orderSummaries.some((x) => x.payment_status === "failed");
        const multiOrderNote =
          orders.length > 1
            ? appendFailedPaymentMultiNote(
                `【重要】以下共 ${orders.length} 筆訂單。回覆時必須逐筆列出。\n簡表：\n${formattedList}`,
                hasFailedMoreSl
              )
            : undefined;
        if (orders.length === 1) {
          const o0 = orders[0];
          const st0 = getUnifiedStatusLabel(o0.status, "superlanding");
          const pkMo = payKindForOrder(o0, st0, "superlanding");
          const opMo = {
            order_id: o0.global_order_id,
            status: customerFacingStatusLabel(st0),
            amount: o0.final_total_order_amount,
            product_list: o0.product_list,
            items_structured: orderItemsStructuredPayload(o0),
            buyer_name: o0.buyer_name,
            buyer_phone: o0.buyer_phone,
            created_at: o0.created_at,
            payment_status_label: pkMo.label,
            payment_warning: paymentWarningFromKind(pkMo.kind),
            shipping_method: o0.shipping_method,
            tracking_number: o0.tracking_number,
            full_address: o0.full_address,
            cvs_brand: o0.cvs_brand,
            cvs_store_name: o0.cvs_store_name,
            delivery_target_type: o0.delivery_target_type,
          };
          const obMo = formatOrderOnePage(opMo);
          if (context?.contactId) {
            storage.setActiveOrderContext(
              context.contactId,
              buildActiveOrderContextFromOrder(o0, "superlanding", st0, obMo, "text")
            );
          }
          return toolJson({
            success: true,
            found: true,
            total: 1,
            orders: orderSummaries,
            note: multiOrderNote,
            one_page_summary: obMo,
            one_page_full,
            ...packDeterministicSingleOrderToolResult({
              renderer: "deterministic_single_more_orders_sl",
              one_page_summary: obMo,
              source: "superlanding",
            }),
          });
        }
        return toolJson({ success: true, found: true, total: orders.length, orders: orderSummaries, note: multiOrderNote, formatted_list: orders.length > 1 ? formattedList : undefined, one_page_summary: orders.length === 1 ? onePageBlocks[0] : undefined, one_page_full });
      }

      if (toolName === "lookup_more_orders_shopline") {
        const phone = (args.phone || "").trim();
        let pageId = (args.page_id || "").trim();
        if (!pageId && context?.contactId) {
          const act = storage.getActiveOrderContext(context.contactId);
          if (act?.page_id) pageId = act.page_id;
        }
        if (!phone) return toolJson({ success: false, error: "請提供手機號碼" });
        const bid = context?.brandId;
        if (!bid) return toolJson({ success: false, error: "缺少品牌" });
        let localHit = true;
        let orders: OrderInfo[] = getOrdersByPhone(bid, phone, "shopline");
        if (pageId) orders = orders.filter((o) => String(o.page_id || "") === pageId);
        if (orders.length === 0) {
          localHit = false;
          const b = storage.getBrand(bid);
          if (!b?.shopline_api_token?.trim()) {
            return toolJson({
              success: true,
              found: false,
              message: "目前暫時無法查詢訂單，我先幫您記下來，由專人確認後回覆您。",
            });
          }
          const r = await lookupShoplineOrdersByPhoneExact(
            { storeDomain: (b.shopline_store_domain || "").trim(), apiToken: b.shopline_api_token.trim() },
            phone
          );
          orders = [...r.orders];
          if (pageId) orders = orders.filter((o) => String(o.page_id || "") === pageId);
        }
        orders.forEach((o) => { o.source = "shopline"; });
        if (orders.length === 0) {
          return toolJson({ success: true, found: false, message: "此條件下無其他訂單", local_hit: localHit });
        }
        console.log(
          `[order_lookup] lookup_more_orders_shopline local_hit=${localHit} n=${orders.length} cache_hit=${localHit}`
        );
        if (orders.length > 1 && context?.contactId) {
          console.log(
            `[deterministic_skip_llm=true] renderer=deterministic_more_orders_shopline local_hit=${localHit}`
          );
          const packed = packDeterministicMultiOrderToolResult({
            orders,
            orderSource: "shopline",
            headerLine: "此手機查到",
            contactId: context.contactId,
            storage,
            matchedBy: "text",
            renderer: "deterministic_more_orders_shopline",
          }) as Record<string, unknown>;
          packed.local_hit = localHit;
          packed.api_hit = !localHit;
          return toolJson(packed);
        }
        const orderSummaries = orders.map((o) => {
          const st = getUnifiedStatusLabel(o.status, "shopline");
          const { kind, label } = payKindForOrder(o, st, "shopline");
          return {
            order_id: o.global_order_id,
            status: customerFacingStatusLabel(st),
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
            source: "shopline" as const,
            items_structured: orderItemsStructuredPayload(o),
            payment_status: kind,
            payment_status_label: label,
            payment_interpretation: getPaymentInterpretationForAI(o, st, "shopline"),
            payment_warning: paymentWarningFromKind(kind),
          };
        });
        const formattedList = formatOrdersToolFormattedList(orderSummaries);
        const onePageBlocks = orderSummaries.map((o) => formatOrderOnePage(o));
        const one_page_full = onePageBlocks.join("\n\n---\n\n");
        const hasFailedShoplineList = orderSummaries.some((x) => x.payment_status === "failed");
        if (orders.length === 1) {
          const o0 = orders[0];
          const st0 = getUnifiedStatusLabel(o0.status, "shopline");
          const pkS = payKindForOrder(o0, st0, "shopline");
          const opS = {
            order_id: o0.global_order_id,
            status: customerFacingStatusLabel(st0),
            amount: o0.final_total_order_amount,
            product_list: o0.product_list,
            items_structured: orderItemsStructuredPayload(o0),
            buyer_name: o0.buyer_name,
            buyer_phone: o0.buyer_phone,
            created_at: o0.created_at,
            payment_status_label: pkS.label,
            payment_warning: paymentWarningFromKind(pkS.kind),
            shipping_method: o0.shipping_method,
            tracking_number: o0.tracking_number,
            full_address: o0.full_address,
            cvs_brand: o0.cvs_brand,
            cvs_store_name: o0.cvs_store_name,
            delivery_target_type: o0.delivery_target_type,
          };
          const obS = formatOrderOnePage(opS);
          if (context?.contactId) {
            storage.setActiveOrderContext(
              context.contactId,
              buildActiveOrderContextFromOrder(o0, "shopline", st0, obS, "text")
            );
          }
          return toolJson({
            success: true,
            found: true,
            total: 1,
            orders: orderSummaries,
            source: "shopline",
            local_hit: localHit,
            note: appendFailedPaymentMultiNote(`共 1 筆訂單。\n${formattedList}`, hasFailedShoplineList),
            formatted_list: formattedList,
            one_page_full,
            one_page_summary: obS,
            ...packDeterministicSingleOrderToolResult({
              renderer: "deterministic_single_more_orders_shopline",
              one_page_summary: obS,
              source: "shopline",
            }),
          });
        }
        return toolJson({
          success: true,
          found: true,
          total: orders.length,
          orders: orderSummaries,
          source: "shopline",
          local_hit: localHit,
          note: appendFailedPaymentMultiNote(
            `共 ${orders.length} 筆訂單，請逐筆呈現給客戶。\n${formattedList}`,
            hasFailedShoplineList
          ),
          formatted_list: formattedList,
          one_page_full,
        });
      }

      if (toolName === "lookup_order_by_phone") {
        const phone = (args.phone || "").trim();
        if (!phone) return toolJson({ success: false, error: "請提供手機號碼" });
        const preferSource = context?.preferShopline ? "shopline" as const : undefined;
        if (preferSource) console.log("[AI Tool Call] 官網查單：優先 SHOPLINE（依對話關鍵字）");
        const actBypass = context?.contactId ? storage.getActiveOrderContext(context.contactId) : null;
        const bypassLocal = shouldBypassLocalPhoneIndex(
          context?.userMessage ?? "",
          context?.recentUserMessages ?? [],
          actBypass ?? undefined
        );
        const disableAgeFilter = shouldDisablePhoneOrderAgeFilter(
          context?.userMessage ?? "",
          context?.recentUserMessages ?? []
        );
        const result = await unifiedLookupByPhoneGlobal(
          config,
          phone,
          context?.brandId,
          preferSource,
          false,
          bypassLocal,
          disableAgeFilter
        );
        if (!result.found || result.orders.length === 0) {
          const brandForDiag = context?.brandId ? storage.getBrand(context.brandId) : undefined;
          const shoplineOk = !!(brandForDiag?.shopline_api_token?.trim() && brandForDiag?.shopline_store_domain?.trim());
          const normPhone = normalizePhone(phone);
          const lookupDiag = {
            preferred_source: preferSource ?? "any",
            shopline_config_present: shoplineOk,
            normalized_phone: normPhone || phone.replace(/\s/g, ""),
            lookup_miss_reason: preferSource === "shopline" ? (shoplineOk ? "shopline_search_zero_or_mismatch" : "shopline_not_configured") : "no_hit_merged",
          };
          console.log("[order_lookup] lookup_miss", JSON.stringify(lookupDiag));
          if (preferSource === "shopline") {
            const hintNoCfg = shoplineOk
              ? "此條件下查無訂單。可請客戶提供訂單編號或當初留的 Email 再查；若訂單在其他管道建立請說明，避免混淆查詢結果。"
              : "目前暫時無法查詢訂單，我先幫您記下來，由專人確認後回覆您。";
            console.log("[reply-trace] lookup_phone_result", {
              contactId: context?.contactId,
              found: false,
              resultCount: 0,
              hasOnePageSummary: false,
              onePageSummaryLength: 0,
              hasDeterministicReply: false,
              deterministicReplyLength: 0,
              dataCoverage: undefined,
              owner_match: undefined,
            });
            return toolJson({
              success: true,
              found: false,
              message: hintNoCfg,
              lookup_diagnostic: lookupDiag,
            });
          }
          console.log("[reply-trace] lookup_phone_result", {
            contactId: context?.contactId,
            found: false,
            resultCount: 0,
            hasOnePageSummary: false,
            onePageSummaryLength: 0,
            hasDeterministicReply: false,
            deterministicReplyLength: 0,
            dataCoverage: undefined,
            owner_match: undefined,
          });
          return toolJson({
            success: true,
            found: false,
            message: "此手機號碼查無訂單紀錄；若為官網購買可確認是否已留此電話。",
            lookup_diagnostic: lookupDiag,
          });
        }
        const orders = result.orders;
        const orderSource = result.source;
        // summaryOnly 意圖：僅在筆數過多時隱藏明細；5 筆以內一律回傳完整 orders 供 AI 列出
        if (context?.orderLookupSummaryOnly && orders.length > 5) {
          console.log("[reply-trace] lookup_phone_result", {
            contactId: context?.contactId,
            found: true,
            resultCount: orders.length,
            hasOnePageSummary: false,
            onePageSummaryLength: 0,
            hasDeterministicReply: false,
            deterministicReplyLength: 0,
            dataCoverage: result.data_coverage,
            summaryOnly: true,
            owner_match: undefined,
          });
          return toolJson({
            success: true,
            found: true,
            summary_only: true,
            total: orders.length,
            source: orderSource,
            sys_note: "訂單較多，請客人說一下大概買了什麼商品或下單時間，方便幫他找。",
            message: `此手機共找到 ${orders.length} 筆訂單，數量較多。請客戶提供商品名稱或大概日期，方便縮小範圍。`,
          });
        }
        const orderSummaries = orders.map((o) => {
          const src = o.source || orderSource;
          const st = getUnifiedStatusLabel(o.status, src);
          const { kind, label } = payKindForOrder(o, st, src);
          const displayPhoneIfMissing =
            !String(o.buyer_phone || "").trim() && phone.trim() ? phone.trim() : undefined;
          return {
            order_id: o.global_order_id,
            status: customerFacingStatusLabel(st),
            amount: o.final_total_order_amount,
            product_list: o.product_list,
            buyer_name: o.buyer_name,
            buyer_phone: o.buyer_phone,
            display_phone_if_missing: displayPhoneIfMissing,
            address: o.address,
            full_address: o.full_address,
            cvs_brand: o.cvs_brand,
            cvs_store_name: o.cvs_store_name,
            store_location: o.store_location,
            delivery_target_type: o.delivery_target_type,
            tracking_number: o.tracking_number,
            created_at: o.created_at,
            shipped_at: o.shipped_at,
            shipping_method: o.shipping_method,
            payment_method: o.payment_method,
            payment_status: kind,
            payment_status_label: label,
            payment_interpretation: getPaymentInterpretationForAI(o, st, src),
            payment_warning: paymentWarningFromKind(kind),
            items_structured: orderItemsStructuredPayload(o),
            source: src,
          };
        });
        const formattedList = formatOrdersToolFormattedList(orderSummaries);
        const onePageBlocks = orderSummaries.map((o) => formatOrderOnePage(o));
        const one_page_full = onePageBlocks.join("\n\n---\n\n");
        const localOnlyDisc =
          result.data_coverage === "local_only" ? ORDER_LOOKUP_LOCAL_CACHE_DISCLAIMER : "";
        const hasFailedPhoneMulti = orderSummaries.some((x) => x.payment_status === "failed");
        const multiOrderNote =
          orders.length <= 1
            ? undefined
            : appendFailedPaymentMultiNote(
                (() => {
                  if (orders.length <= LOOKUP_PHONE_FULL_CARD_THRESHOLD) {
                    return `【重要】以下共 ${orders.length} 筆訂單。請逐字使用 one_page_full／deterministic_customer_reply 的完整卡片回覆，禁止改寫成簡表、禁止刪除任何一行。`;
                  }
                  return `共 ${orders.length} 筆訂單，已以擴充清單列於 one_page_full／one_page_summary；請完整引用並引導客人回覆訂單編號或「第 N 筆」以查看明細。`;
                })(),
                hasFailedPhoneMulti
              );

        if (orders.length > 1) {
          const n = orders.length;
          const succ = orderSummaries.filter((x) => x.payment_status === "success").length;
          const fail = orderSummaries.filter((x) => x.payment_status === "failed").length;
          const pend = orderSummaries.filter((x) => x.payment_status === "pending").length;
          const codn = orderSummaries.filter((x) => x.payment_status === "cod").length;
          const partsAgg: string[] = [];
          if (succ) partsAgg.push(`${succ} 筆付款成功`);
          if (fail) partsAgg.push(`${fail} 筆付款失敗未成立`);
          if (pend) partsAgg.push(`${pend} 筆待付款`);
          if (codn) partsAgg.push(`${codn} 筆貨到付款`);
          const aggStr = partsAgg.length ? partsAgg.join("、") : "付款狀態請見下列明細";
          const sorted = [...orders].sort((a, b) =>
            String(b.created_at || b.order_created_at || "").localeCompare(String(a.created_at || a.order_created_at || ""))
          );
          const o0 = sorted[0];
          const status0 = getUnifiedStatusLabel(o0.status, o0.source || orderSource);

          const cardSeparator = "\n\n────────\n\n";
          let deterministicReply: string;
          let onePageFullForContext: string | undefined;
          let lookupPhoneRenderMode: "multi_card_full" | "extended_list";

          if (n <= LOOKUP_PHONE_FULL_CARD_THRESHOLD) {
            lookupPhoneRenderMode = "multi_card_full";
            const cardsMulti = orderSummaries.map((o) => formatOrderOnePage(o));
            const headerMulti = `依您留的手機查到 ${n} 筆訂單：\n\n`;
            const bodyMulti = cardsMulti.join(cardSeparator);
            deterministicReply = headerMulti + bodyMulti + localOnlyDisc;
            onePageFullForContext = deterministicReply;
          } else {
            lookupPhoneRenderMode = "extended_list";
            deterministicReply = formatExtendedOrderList(orders) + localOnlyDisc;
            onePageFullForContext = deterministicReply;
          }
          const candidates = sorted.map((o) => {
            const src = o.source || orderSource;
            const st = getUnifiedStatusLabel(o.status, src);
            const { kind, label } = payKindForOrder(o, st, src);
            return {
              order_id: o.global_order_id,
              payment_status: kind as "success" | "failed" | "pending" | "cod" | "unknown",
              payment_status_label: label,
              fulfillment_status: customerFacingStatusLabel(st),
              order_time: o.created_at || o.order_created_at,
              source: (src === "shopline" || src === "superlanding" ? src : undefined) as
                | "shopline"
                | "superlanding"
                | undefined,
            };
          });
          const successful_order_ids = candidates.filter((c) => c.payment_status === "success").map((c) => c.order_id);
          const failed_order_ids = candidates.filter((c) => c.payment_status === "failed").map((c) => c.order_id);
          const pending_order_ids = candidates.filter((c) => c.payment_status === "pending").map((c) => c.order_id);
          const cod_order_ids = candidates.filter((c) => c.payment_status === "cod").map((c) => c.order_id);
          const multiCtx: import("@shared/schema").ActiveOrderContext = {
            ...buildActiveOrderContextFromOrder(o0, o0.source || orderSource, status0, deterministicReply, "text"),
            candidate_count: n,
            active_order_candidates: candidates,
            selected_order_id: null,
            last_lookup_source: orderSource,
            aggregate_payment_summary: aggStr,
            one_page_summary: deterministicReply,
            candidate_source_summary: "手機查詢",
            successful_order_ids,
            failed_order_ids,
            pending_order_ids,
            cod_order_ids,
            selected_order_rank: null,
          };
          if (context?.contactId) storage.setActiveOrderContext(context.contactId, multiCtx);
          console.log(
            `[order_lookup] renderer=deterministic lookup=phone_multi n=${n} source=${orderSource}`
          );
          /** 2–3 筆：程式直出完整卡片略過第二輪 LLM；4+ 擴充清單交 LLM */
          const usePhoneDeterministic =
            orderFeatureFlags.phoneOrderDeterministicReply && n <= LOOKUP_PHONE_FULL_CARD_THRESHOLD;
          console.log("[reply-trace] lookup_phone_render_mode", {
            contactId: context?.contactId,
            mode: lookupPhoneRenderMode,
            orderCount: n,
          });
          console.log("[reply-trace] lookup_phone_result", {
            contactId: context?.contactId,
            found: true,
            resultCount: n,
            hasOnePageSummary: !!(onePageFullForContext ?? one_page_full),
            onePageSummaryLength: (onePageFullForContext ?? `${one_page_full}${localOnlyDisc}`).length,
            hasDeterministicReply: usePhoneDeterministic,
            deterministicReplyLength: usePhoneDeterministic ? deterministicReply.length : 0,
            dataCoverage: result.data_coverage,
            owner_match: undefined,
          });
          return toolJson({
            success: true,
            found: true,
            total: n,
            orders: orderSummaries,
            source: orderSource,
            deterministic_skip_llm: usePhoneDeterministic,
            ...(usePhoneDeterministic ? { deterministic_customer_reply: deterministicReply } : {}),
            ...orderDeterministicContractFields(),
            renderer: "deterministic",
            note: multiOrderNote,
            formatted_list: undefined,
            one_page_summary: deterministicReply,
            one_page_full: onePageFullForContext ?? `${one_page_full}${localOnlyDisc}`,
            sys_note: SYS_NOTE_ORDER_ONE_PAGE_FULL_STRICT,
          });
        }

        /** Phase 106：單筆 local 亦寫入 active context，與 live 一致供後續追問 */
        if (context?.contactId && orders.length === 1) {
          const o0 = orders[0];
          const statusLabel0 = getUnifiedStatusLabel(o0.status, o0.source || orderSource);
          const pk = payKindForOrder(o0, statusLabel0, o0.source || orderSource);
          const onePagePayload = {
            order_id: o0.global_order_id,
            status: customerFacingStatusLabel(statusLabel0),
            amount: o0.final_total_order_amount,
            product_list: o0.product_list,
            items_structured: orderItemsStructuredPayload(o0),
            buyer_name: o0.buyer_name,
            buyer_phone: o0.buyer_phone,
            display_phone_if_missing:
              !String(o0.buyer_phone || "").trim() && phone.trim() ? phone.trim() : undefined,
            address: o0.address,
            full_address: o0.full_address,
            cvs_brand: o0.cvs_brand,
            cvs_store_name: o0.cvs_store_name,
            store_location: o0.store_location,
            delivery_target_type: o0.delivery_target_type,
            tracking_number: o0.tracking_number,
            created_at: o0.created_at,
            shipped_at: o0.shipped_at,
            shipping_method: o0.shipping_method,
            payment_method: o0.payment_method,
            payment_status: pk.kind,
            payment_status_label: pk.label,
            payment_warning: paymentWarningFromKind(pk.kind),
            source: o0.source || orderSource,
            prepaid: o0.prepaid,
            paid_at: o0.paid_at,
          };
          const summaryForCtx =
            PHONE_LOOKUP_INTRO_SINGLE +
            formatOrderOnePage(onePagePayload) +
            (result.data_coverage === "local_only" ? ORDER_LOOKUP_LOCAL_CACHE_DISCLAIMER : "");
          storage.linkOrderForContact(context.contactId, o0.global_order_id, "ai_lookup");
          const activeCtx = buildActiveOrderContext(o0, o0.source || orderSource, statusLabel0, summaryForCtx, "text");
          storage.setActiveOrderContext(context.contactId, activeCtx);
        }
        const singleDeterministicBody =
          orders.length === 1
            ? (() => {
                const o0 = orders[0];
                const st = getUnifiedStatusLabel(o0.status, o0.source || orderSource);
                const pk = payKindForOrder(o0, st, o0.source || orderSource);
                const payload = {
                  order_id: o0.global_order_id,
                  status: customerFacingStatusLabel(st),
                  amount: o0.final_total_order_amount,
                  product_list: o0.product_list,
                  items_structured: orderItemsStructuredPayload(o0),
                  buyer_name: o0.buyer_name,
                  buyer_phone: o0.buyer_phone,
                  display_phone_if_missing:
                    !String(o0.buyer_phone || "").trim() && phone.trim() ? phone.trim() : undefined,
                  address: o0.address,
                  full_address: o0.full_address,
                  cvs_brand: o0.cvs_brand,
                  cvs_store_name: o0.cvs_store_name,
                  store_location: o0.store_location,
                  delivery_target_type: o0.delivery_target_type,
                  tracking_number: o0.tracking_number,
                  created_at: o0.created_at,
                  shipped_at: o0.shipped_at,
                  shipping_method: o0.shipping_method,
                  payment_method: o0.payment_method,
                  payment_status: pk.kind,
                  payment_status_label: pk.label,
                  payment_warning: paymentWarningFromKind(pk.kind),
                  source: o0.source || orderSource,
                  prepaid: o0.prepaid,
                  paid_at: o0.paid_at,
                };
                /** local_only 仍組完整 one page（與 onePageBlocks 同源邏輯）；data_coverage 僅標記語氣，不縮短摘要 */
                return formatOrderOnePage(payload);
              })()
            : undefined;
        if (orders.length === 1 && singleDeterministicBody) {
          const isLocalOnly = result.data_coverage === "local_only";
          const noSingleClaim = isLocalOnly;
          const oSingle = orders[0];
          const stSingle = getUnifiedStatusLabel(oSingle.status, oSingle.source || orderSource);
          const pkSingle = payKindForOrder(oSingle, stSingle, oSingle.source || orderSource);
          const onePageSummarySingle =
            PHONE_LOOKUP_INTRO_SINGLE +
            singleDeterministicBody +
            (isLocalOnly ? ORDER_LOOKUP_LOCAL_CACHE_DISCLAIMER : "");
          console.log("[reply-trace] lookup_phone_render_mode", {
            contactId: context?.contactId,
            mode: "single_card",
            orderCount: 1,
          });
          console.log("[DEBUG_PHONE_DETERMINISTIC]", {
            source: oSingle.source,
            global_order_id: oSingle.global_order_id,
            data_coverage: result.data_coverage,
            payment_method: oSingle.payment_method,
            paymentKindResult: pkSingle.kind,
            one_page_summary_length: (onePageSummarySingle || "").trim().length,
            flag_phoneOrderDeterministicReply: orderFeatureFlags.phoneOrderDeterministicReply,
            flag_genericDeterministicOrder: orderFeatureFlags.genericDeterministicOrder,
          });
          console.log(
            "[order_lookup] renderer=deterministic lookup=phone_single source=" +
              orderSource +
              (noSingleClaim ? " data_coverage=local_only" : "")
          );
          const allowDeterministicByPayment =
            pkSingle.kind === "success" ||
            pkSingle.kind === "cod" ||
            pkSingle.kind === "pending";
          const allowDeterministic =
            orderFeatureFlags.phoneOrderDeterministicReply &&
            allowDeterministicByPayment &&
            onePageSummarySingle.trim().length > 50;
          const packedSingle = packDeterministicSingleOrderToolResult({
            renderer: "deterministic_phone_single",
            one_page_summary: onePageSummarySingle,
            source: oSingle.source || orderSource,
          });
          console.log("[reply-trace] lookup_phone_result", {
            contactId: context?.contactId,
            found: true,
            resultCount: 1,
            hasOnePageSummary: !!onePageSummarySingle,
            onePageSummaryLength: onePageSummarySingle.length,
            hasDeterministicReply: allowDeterministic,
            deterministicReplyLength: allowDeterministic ? onePageSummarySingle.trim().length : 0,
            dataCoverage: result.data_coverage,
            owner_match: undefined,
          });
          return toolJson({
            success: true,
            found: true,
            total: 1,
            orders: orderSummaries,
            source: orderSource,
            ...packedSingle,
            deterministic_skip_llm: allowDeterministic,
            ...(allowDeterministic ? { deterministic_customer_reply: onePageSummarySingle.trim() } : {}),
            one_page_summary: onePageSummarySingle,
            sys_note: SYS_NOTE_ORDER_ONE_PAGE_STRICT,
            ...(isLocalOnly ? { data_coverage: "local_only" } : {}),
            ...(result.coverage_confidence ? { coverage_confidence: result.coverage_confidence } : {}),
            ...(result.needs_live_confirm ? { needs_live_confirm: result.needs_live_confirm } : {}),
          });
        }
        {
          const ops =
            orders.length === 1 ? `${PHONE_LOOKUP_INTRO_SINGLE}${onePageBlocks[0]}${localOnlyDisc}` : undefined;
          console.log("[reply-trace] lookup_phone_result", {
            contactId: context?.contactId,
            found: true,
            resultCount: orders.length,
            hasOnePageSummary: !!ops,
            onePageSummaryLength: (ops ?? "").length,
            hasDeterministicReply: false,
            deterministicReplyLength: 0,
            dataCoverage: result.data_coverage,
            owner_match: undefined,
          });
        }
        return toolJson({
          success: true,
          found: true,
          total: orders.length,
          orders: orderSummaries,
          source: orderSource,
          note: multiOrderNote,
          formatted_list:
            orders.length > 3
              ? orders.length <= 5
                ? formattedList
                : formatOrdersToolFormattedList(orderSummaries.slice(0, 5))
              : undefined,
          one_page_summary:
            orders.length === 1 ? `${PHONE_LOOKUP_INTRO_SINGLE}${onePageBlocks[0]}${localOnlyDisc}` : undefined,
          one_page_full:
            orders.length === 1
              ? `${PHONE_LOOKUP_INTRO_SINGLE}${one_page_full}${localOnlyDisc}`
              : `${one_page_full}${localOnlyDisc}`,
          sys_note: orders.length > 1 ? SYS_NOTE_ORDER_ONE_PAGE_FULL_STRICT : SYS_NOTE_ORDER_ONE_PAGE_STRICT,
          ...(result.data_coverage ? { data_coverage: result.data_coverage } : {}),
          ...(result.coverage_confidence ? { coverage_confidence: result.coverage_confidence } : {}),
          ...(result.needs_live_confirm ? { needs_live_confirm: result.needs_live_confirm } : {}),
        });
      }

      return toolJson({ success: false, error: `未知的工具: ${toolName}` });
    } catch (err: any) {
      console.error("[AI Tool Call] tool error:", toolName, err.message);
      return toolJson({ success: false, error: `工具執行錯誤: ${err.message}` });
    }
  }

  return { executeToolCall };
}
