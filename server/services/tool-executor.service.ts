import type { IStorage } from "../storage";
import type { OrderInfo } from "@shared/schema";
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
} from "../order-service";
import { shouldBypassLocalPhoneIndex } from "../order-lookup-policy";
import { packDeterministicMultiOrderToolResult } from "../order-multi-renderer";
import { getOrdersByPhone, lookupOrdersByProductAliasAndPhoneLocal, normalizePhone } from "../order-index";
import {
  formatOrderOnePage,
  formatLocalOnlyCandidateSummary,
  payKindForOrder,
} from "../order-reply-utils";
import { packDeterministicSingleOrderToolResult } from "../order-single-renderer";
import { orderDeterministicContractFields } from "../deterministic-order-contract";
import { buildActiveOrderContextFromOrder } from "../order-active-context";
import { lookupShoplineOrdersByPhoneExact } from "../shopline";
import { classifyOrderNumber } from "../intent-and-order";
import { applyHandoff, normalizeHandoffReason } from "./handoff";
import { finalizeLlmToolJsonString } from "../tool-llm-sanitize";

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
      let structured = o.items_structured;
      if (typeof structured === "string") {
        try {
          structured = JSON.parse(structured);
        } catch {
          structured = null;
        }
      }
      if (!products && Array.isArray(structured) && structured.length > 0) {
        products = structured
          .map((item: any) => item.product_name || item.name || "未知商品")
          .join("、");
      }
      products = products ? products.slice(0, 40) : "未提供商品名稱";
      return `- ${o.order_id} | ${products} | $${o.amount ?? ""} | ${o.status || ""} | ${o.payment_status_label ?? ""}`;
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
  return x.items_structured ?? x.items ?? [];
}

export interface ToolExecutorDeps {
  storage: IStorage;
  pushLineMessage: (userId: string, messages: object[], token?: string | null) => Promise<void>;
  sendFBMessage: (pageAccessToken: string, recipientId: string, text: string) => Promise<void>;
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

    if (toolName === "transfer_to_human") {
      const reason = (args.reason || "AI 判斷需要轉人工").trim();
      console.log(`[AI Tool Call] transfer_to_human???: ${reason}?contactId: ${context?.contactId}`);
      if (context?.contactId) {
        (() => { const norm = normalizeHandoffReason(reason); applyHandoff({ contactId: context.contactId, reason: norm.reason, reason_detail: norm.reason_detail, source: "sandbox_tool_call", platform: context?.platform, brandId: context?.brandId }); })();
        storage.createMessage(context.contactId, context?.platform || "line", "system",
          `(轉接) AI 已觸發轉接人工：${reason}`);
      }
      return JSON.stringify({ success: true, message: "已轉接人工客服，AI 不再回覆此對話。" });
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
      return JSON.stringify({ success: false, error: "查單功能未設定完成，請聯繫管理員確認 API 金鑰。" });
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
          status: statusLabel,
          amount: order.final_total_order_amount,
          product_list: order.product_list,
          items_structured: orderItemsStructuredPayload(order),
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
          payment_status: pkId.kind,
          payment_status_label: pkId.label,
          payment_warning: paymentWarningFromKind(pkId.kind),
        };
        const one_page_summary = formatOrderOnePage(orderPayload);
        if (context?.contactId) {
          storage.linkOrderForContact(context.contactId, order.global_order_id, "ai_lookup");
          const activeCtx = buildActiveOrderContext(order, result.source, statusLabel, one_page_summary, "text");
          storage.setActiveOrderContext(context.contactId, activeCtx);
        }
        return toolJson({
          success: true,
          found: true,
          source: result.source,
          order: orderPayload,
          payment_interpretation,
          one_page_summary,
          ...packDeterministicSingleOrderToolResult({
            renderer: "deterministic_single_by_id",
            one_page_summary,
            source: result.source,
          }),
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
                status: statusLabel,
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
              const one_page_summary = formatOrderOnePage(orderPayloadL);
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
                status: st,
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
              return `${i + 1}. ${tag}${o.global_order_id}｜${o.created_at || ""}｜${label}｜${st}`;
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
                fulfillment_status: st,
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
            status: st0,
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
                status: st0,
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
            status: st0,
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
              status: st0,
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
          const src = o.source || dateOrderSource;
          const st = getUnifiedStatusLabel(o.status, src);
          const { kind, label } = payKindForOrder(o, st, src);
          return {
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
            status: st0,
            amount: o0.final_total_order_amount,
            product_list: o0.product_list,
            buyer_name: o0.buyer_name,
            buyer_phone: o0.buyer_phone,
            created_at: o0.created_at,
            payment_status_label: pkMo.label,
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
            return toolJson({ success: true, found: false, message: "本地無符合訂單且品牌未設定商店串接" });
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
            status: st0,
            amount: o0.final_total_order_amount,
            product_list: o0.product_list,
            buyer_name: o0.buyer_name,
            buyer_phone: o0.buyer_phone,
            created_at: o0.created_at,
            payment_status_label: pkS.label,
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
        const result = await unifiedLookupByPhoneGlobal(
          config,
          phone,
          context?.brandId,
          preferSource,
          false,
          bypassLocal
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
              : "商店串接尚未完成，無法查詢部分訂單。請客戶提供訂單編號，或請管理員確認後台 API 與網域設定。";
            return toolJson({
              success: true,
              found: false,
              message: hintNoCfg,
              lookup_diagnostic: lookupDiag,
            });
          }
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
          return {
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
        const hasFailedPhoneMulti = orderSummaries.some((x) => x.payment_status === "failed");
        const multiOrderNote =
          orders.length > 1
            ? appendFailedPaymentMultiNote(
                `【重要】以下共 ${orders.length} 筆訂單。回覆時必須逐筆列出。\n簡表：\n${formattedList}`,
                hasFailedPhoneMulti
              )
            : undefined;

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
          const sorted = [...orders].sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
          const top3 = sorted.slice(0, 3);
          const lines = top3.map((o, i) => {
            const src = o.source || orderSource;
            const st = getUnifiedStatusLabel(o.status, src);
            const { label } = payKindForOrder(o, st, src);
            const srcTag = "";
            return `${i + 1}. ${srcTag}${o.global_order_id}｜${o.created_at || ""}｜${label}｜${st}`;
          });
          const deterministicReply =
            `${n} 筆｜${aggStr}\n` +
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
              fulfillment_status: st,
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
          return toolJson({
            success: true,
            found: true,
            total: n,
            orders: orderSummaries,
            source: orderSource,
            deterministic_skip_llm: false,
            ...orderDeterministicContractFields(),
            renderer: "deterministic",
            note: multiOrderNote,
            formatted_list: formattedList,
          });
        }

        const isSingleLocalOnly = orders.length === 1 && result.data_coverage === "local_only";
        /** P0：local_only 單筆不寫入 DB active context（下段僅在非 local_only 執行） */
        if (context?.contactId && orders.length === 1 && !isSingleLocalOnly) {
          const o0 = orders[0];
          const statusLabel0 = getUnifiedStatusLabel(o0.status, o0.source || orderSource);
          const pk = payKindForOrder(o0, statusLabel0, o0.source || orderSource);
          const onePagePayload = {
            order_id: o0.global_order_id,
            status: statusLabel0,
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
            payment_status_label: pk.label,
          };
          const summaryForCtx = formatOrderOnePage(onePagePayload);
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
                  status: st,
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
                  payment_status_label: pk.label,
                };
                if (isSingleLocalOnly) {
                  return formatLocalOnlyCandidateSummary({
                    order_id: o0.global_order_id,
                    created_at: o0.created_at || o0.order_created_at,
                    product_list: o0.product_list,
                    items_structured: o0.items_structured,
                    status_short: st,
                  });
                }
                return formatOrderOnePage(payload);
              })()
            : undefined;
        if (orders.length === 1 && singleDeterministicBody) {
          const isLocalOnly = result.data_coverage === "local_only";
          const noSingleClaim = isLocalOnly;
          /** local_only 單筆：候選摘要，禁止定案語與完整 order card */
          const replyText = singleDeterministicBody;
          console.log(
            "[order_lookup] renderer=deterministic lookup=phone_single source=" +
              orderSource +
              (noSingleClaim ? " data_coverage=local_only" : "")
          );
          return toolJson({
            success: true,
            found: true,
            total: 1,
            orders: orderSummaries,
            source: orderSource,
            deterministic_skip_llm: false,
            ...orderDeterministicContractFields(),
            renderer: "deterministic",
            one_page_summary: noSingleClaim ? singleDeterministicBody : onePageBlocks[0],
            ...(isLocalOnly
              ? {
                  data_coverage: "local_only",
                  sys_note:
                    "【營運指導】：目前資料正在與主機連線確認中，請用有溫度的語氣請客戶稍候，委婉表達狀態還在同步，不要把話說死。",
                }
              : {}),
            ...(result.coverage_confidence ? { coverage_confidence: result.coverage_confidence } : {}),
            ...(result.needs_live_confirm ? { needs_live_confirm: result.needs_live_confirm } : {}),
          });
        }
        return toolJson({
          success: true,
          found: true,
          total: orders.length,
          orders: orderSummaries,
          source: orderSource,
          note: multiOrderNote,
          formatted_list: orders.length > 1 ? formattedList : undefined,
          one_page_summary:
            orders.length === 1
              ? isSingleLocalOnly
                ? formatLocalOnlyCandidateSummary({
                    order_id: orders[0].global_order_id,
                    created_at: orders[0].created_at || orders[0].order_created_at,
                    product_list: orders[0].product_list,
                    items_structured: orders[0].items_structured,
                    status_short: getUnifiedStatusLabel(orders[0].status, orders[0].source || orderSource),
                  })
                : onePageBlocks[0]
              : undefined,
          one_page_full,
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
