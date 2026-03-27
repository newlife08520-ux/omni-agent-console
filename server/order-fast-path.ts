/**
 * Phase 2.3：查單 Fast Path（略過 first LLM）
 */
import type { OrderInfo } from "@shared/schema";
import type { SuperLandingConfig } from "./superlanding";
import type { IStorage } from "./storage";
import {
  unifiedLookupById,
  unifiedLookupByPhoneGlobal,
  getUnifiedStatusLabel,
  isShoplineLookupConfiguredForBrand,
  type OrderLookupPreferSource,
} from "./order-service";
import {
  formatOrderOnePage,
  formatLocalOnlyCandidateSummary,
  payKindForOrder,
  sourceChannelLabel,
  buildDeterministicFollowUpReply,
} from "./order-reply-utils";
import { buildActiveOrderContextFromOrder } from "./order-active-context";
import {
  deriveOrderLookupIntent,
  resolveOrderSourceIntent,
  shouldDirectLookupByPhone,
  shouldRequireApiConfirmBeforeSingleClaim,
  shouldBypassLocalPhoneIndex,
} from "./order-lookup-policy";

const ASK_ORDER_KW = /我要查訂單|查訂單|訂單查詢|幫我查訂單|想查訂單/i;
const ONE_PAGE_HINTS = /一頁商店|一頁|粉絲團|團購|superlanding|SuperLanding/i;

function extractTwPhone(msg: string): string | null {
  const m = (msg || "").match(/09\d{8}/);
  return m ? m[0] : null;
}

function isLineMostlyPhone(msg: string): boolean {
  const t = (msg || "").trim().replace(/\s/g, "");
  return /^09\d{8}$/.test(t) || /^\+8869\d{8}$/.test(t) || /^8869\d{8}$/.test(t);
}

function isLineMostlyOrderId(msg: string): boolean {
  const t = (msg || "").trim();
  if (/^09\d/.test(t)) return false;
  /** Phase 34-2：整句為官網長數字單號時允許 fast path（與 isLikelyShoplineNumericOrderId 一致） */
  if (/^\d{15,22}$/.test(t)) return true;
  if (t.length < 5 || t.length > 14) return false;
  return /^[A-Za-z0-9\-]+$/.test(t);
}

/** 混合句內的 15～22 位純數字（官網單號），避免被長度 14 上限擋下 */
export function extractLongNumericOrderIdFromMixedSentence(msg: string): string | null {
  if (!msg) return null;
  const m = msg.match(/(?<!\d)\d{15,22}(?!\d)/);
  return m ? m[0] : null;
}

/** 依訊息內容決定 lookup_order_by_id 管道：長數字預設官網，除非句內有一頁／團購意圖 */
function preferSourceForOrderIdLookup(
  msg: string,
  preferShop: boolean,
  preferSl: boolean
): OrderLookupPreferSource | undefined {
  const hasLongNumeric =
    /^\d{15,22}$/.test(msg.trim()) || /(?<!\d)\d{15,22}(?!\d)/.test(msg);
  if (hasLongNumeric) {
    if (ONE_PAGE_HINTS.test(msg)) return "superlanding";
    return "shopline";
  }
  if (preferShop) return "shopline";
  if (preferSl) return "superlanding";
  return undefined;
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

/** Phase 34-5：與確定性追問一致，含久候／預購類關鍵字以觸發品牌話術 */
const FOLLOWUP_FP_KW =
  /出貨|付款成功|寄到哪|地址|門市|全家|物流|單號|追蹤|貨到|取件|配送|多久|預購|久等|怎麼還沒|沒收到|催|什麼時候/i;

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
  const { userMessage, brandId, contactId, slConfig, storage, planMode, recentUserMessages } = params;
  const msg = (userMessage || "").trim();
  if (!brandId) return null;
  if (typeof planMode === "string" && /return/i.test(planMode) && planMode !== "order_lookup") {
    return null;
  }

  /** Phase 2.4 / 34：已有 active context 時，追問不進第一輪 LLM（與 routes 確定性短路模式對齊） */
  if (
    planMode === "order_lookup" ||
    planMode === "order_followup" ||
    planMode === "answer_directly" ||
    planMode === "aftersales_comfort_first" ||
    planMode === "return_stage_1" ||
    planMode === "ask_one_question" ||
    planMode === "fallback_unknown" ||
    planMode === "idle_closure" ||
    planMode === "invite_rating"
  ) {
    const ctx = storage.getActiveOrderContext(contactId);
    if (ctx?.order_id && FOLLOWUP_FP_KW.test(msg) && !isLineMostlyPhone(msg)) {
      const det = buildDeterministicFollowUpReply(ctx, msg);
      if (det) {
        console.log(
          `[order_followup_fast_path_hit=true] followup_intent=followup_reply contact=${contactId} order=${ctx.order_id}`
        );
        return { reply: det, fastPathType: "order_followup" };
      }
    }
  }

  const sourceIntent = resolveOrderSourceIntent(msg, recentUserMessages);
  const preferShop = sourceIntent === "shopline";
  const preferSl = sourceIntent === "superlanding";

  const mixedOid =
    !isLineMostlyOrderId(msg) &&
    (extractOrderIdFromMixedSentence(msg) || extractLongNumericOrderIdFromMixedSentence(msg));
  const allowFast =
    planMode === "order_lookup" ||
    planMode === "order_followup" ||
    planMode === "answer_directly" ||
    (isLineMostlyPhone(msg) && msg.length <= 14) ||
    isLineMostlyOrderId(msg) ||
    (!!mixedOid && /查|幫我|看一下|訂單|請問|幫忙|查詢/i.test(msg)) ||
    (preferShop && extractTwPhone(msg)) ||
    (preferSl && extractTwPhone(msg));
  if (!allowFast) return null;

  if (planMode === "off_topic_guard" && !isLineMostlyPhone(msg) && !isLineMostlyOrderId(msg)) {
    return null;
  }

  if (ASK_ORDER_KW.test(msg) && !extractTwPhone(msg) && !isLineMostlyOrderId(msg)) {
    return {
      reply:
        "要幫您查訂單的話，請直接傳「訂單編號」（官網也可能是較長的純數字編號）；若沒有單號，請提供「商品名稱＋手機號碼」（例如：OO 商品 0912345678）。若只要查全部訂單摘要，可說「查我全部訂單」並附手機。詳見品牌話術可參考 docs/persona。",
      fastPathType: "ask_for_identifier",
    };
  }

  if (mixedOid && !isLineMostlyOrderId(msg)) {
    const id = mixedOid;
    const prefer: OrderLookupPreferSource | undefined = preferSourceForOrderIdLookup(msg, preferShop, preferSl);
    const result = await unifiedLookupById(slConfig, id, brandId, prefer, false);
    if (!result.found || !result.orders[0]) {
      const shopNote =
        preferShop && !isShoplineLookupConfiguredForBrand(brandId)
          ? "（官網即時查詢尚未啟用：後台未完成 SHOPLINE API 設定，無法代查官網；若單號正確仍查無，請洽人工或確認是否為一頁／其他管道訂單。）"
          : "";
      return {
        reply: `這個編號目前查不到紀錄，請再確認是否正確。${shopNote}`.trim(),
        fastPathType: "order_id_mixed",
      };
    }
    const order = result.orders[0];
    const st = getUnifiedStatusLabel(order.status, order.source || result.source);
    const pk = payKindForOrder(order, st, order.source || result.source);
    const payload = {
      order_id: order.global_order_id,
      status: st,
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
      payment_status_label: pk.label,
      source_channel: sourceChannelLabel(order.source),
    };
    const onePage = formatOrderOnePage(payload);
    const reply = `查到一筆：\n${onePage}`;
    storage.linkOrderForContact(contactId, order.global_order_id, "ai_lookup");
    storage.setActiveOrderContext(contactId, buildActiveOrderContextFromOrder(order, result.source, st, onePage, "text"));
    storage.updateContactOrderSource(contactId, order.source || result.source);
    console.log(`[order_fast_path_hit=true] fast_path_type=order_id_mixed order=${id}`);
    return { reply, fastPathType: "order_id_mixed" };
  }

  if (isLineMostlyOrderId(msg)) {
    const raw = msg.trim();
    const id = /^\d{15,22}$/.test(raw) ? raw : raw.toUpperCase();
    const prefer: OrderLookupPreferSource | undefined = preferSourceForOrderIdLookup(msg, preferShop, preferSl);
    const result = await unifiedLookupById(slConfig, id, brandId, prefer, false);
    if (!result.found || !result.orders[0]) {
      const shopNote =
        preferShop && !isShoplineLookupConfiguredForBrand(brandId)
          ? "（官網即時查詢尚未啟用：後台未完成 SHOPLINE API 設定。）"
          : "";
      return {
        reply: `這個編號目前查不到紀錄，請再確認是否正確。${shopNote}`.trim(),
        fastPathType: "order_id",
      };
    }
    const order = result.orders[0];
    const st = getUnifiedStatusLabel(order.status, order.source || result.source);
    const pk = payKindForOrder(order, st, order.source || result.source);
    const payload = {
      order_id: order.global_order_id,
      status: st,
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
      payment_status_label: pk.label,
      source_channel: sourceChannelLabel(order.source),
    };
    const onePage = formatOrderOnePage(payload);
    const reply = `幫您查到了：\n${onePage}`;
    storage.linkOrderForContact(contactId, order.global_order_id, "ai_lookup");
    storage.setActiveOrderContext(contactId, buildActiveOrderContextFromOrder(order, result.source, st, onePage, "text"));
    storage.updateContactOrderSource(contactId, order.source || result.source);
    return { reply, fastPathType: "order_id" };
  }

  const phone = extractTwPhone(msg);
  if (phone && (isLineMostlyPhone(msg) || preferShop || preferSl)) {
    if (preferShop && !isShoplineLookupConfiguredForBrand(brandId)) {
      return {
        reply:
          "您提到要查官網訂單，但目前後台尚未完成官網（SHOPLINE）API 設定，無法代為即時查官網。請改傳訂單編號、或說明在一頁／團購下單並提供「商品名稱＋手機」；若只要訂單摘要可說「查我全部訂單」並附手機。",
        fastPathType: "shopline_phone",
      };
    }
    const activeCtx = storage.getActiveOrderContext(contactId);
    const intent = deriveOrderLookupIntent(msg, recentUserMessages, activeCtx ?? undefined);
    const purePhoneOnly = !preferShop && !preferSl && isLineMostlyPhone(msg);
    if (purePhoneOnly && !shouldDirectLookupByPhone(msg, recentUserMessages, activeCtx ?? undefined)) {
      return {
        reply:
          "若要查特定訂單，請提供「商品名稱＋手機號碼」或直接傳訂單編號；若只要查全部訂單摘要，可說「查我全部訂單」或「還有其他訂單嗎」。",
        fastPathType: "ask_for_identifier",
      };
    }
    let prefer: OrderLookupPreferSource | undefined;
    if (preferShop) prefer = "shopline";
    else if (preferSl) prefer = "superlanding";
    const bypassLocal = shouldBypassLocalPhoneIndex(msg, recentUserMessages, activeCtx ?? undefined);
    const result = await unifiedLookupByPhoneGlobal(slConfig, phone, brandId, prefer, false, bypassLocal);
    if (!result.found || result.orders.length === 0) {
      const hint = preferShop ? "（官網）" : preferSl ? "（一頁商店）" : "";
      return {
        reply: `這支手機${hint}目前查無訂單紀錄，請確認號碼或是否用其他電話下單。`,
        fastPathType: preferShop ? "shopline_phone" : preferSl ? "superlanding_phone" : "phone",
      };
    }
    const orders = result.orders;
    const orderSource = result.source;
    const needsConfirm = shouldRequireApiConfirmBeforeSingleClaim(
      intent,
      result.data_coverage,
      orders.length
    );
    const isLocalOnlySingle = orders.length === 1 && result.data_coverage === "local_only";

    if (orders.length > 1) {
      const orderSummaries = orders.map((o) => {
        const src = o.source || orderSource;
        const st = getUnifiedStatusLabel(o.status, src);
        const { kind, label } = payKindForOrder(o, st, src);
        return {
          order_id: o.global_order_id,
          payment_status: kind,
          payment_status_label: label,
          fulfillment_status: st,
          order_time: o.created_at || o.order_created_at,
          o,
          src,
          st,
        };
      });
      const n = orders.length;
      const succ = orderSummaries.filter((x) => x.payment_status === "success").length;
      const fail = orderSummaries.filter((x) => x.payment_status === "failed").length;
      const pend = orderSummaries.filter((x) => x.payment_status === "pending").length;
      const codn = orderSummaries.filter((x) => x.payment_status === "cod").length;
      const ch =
        orderSource === "shopline" ? "官網" : orderSource === "superlanding" ? "一頁商店" : "合併來源";
      const partsAgg: string[] = [];
      if (succ) partsAgg.push(`${succ} 筆付款成功`);
      if (fail) partsAgg.push(`${fail} 筆未成立／失敗`);
      if (pend) partsAgg.push(`${pend} 筆待付款`);
      if (codn) partsAgg.push(`${codn} 筆貨到付款`);
      const aggStr = partsAgg.length ? partsAgg.join("、") : "詳見下列";
      const sorted = [...orderSummaries].sort((a, b) =>
        String(b.order_time || "").localeCompare(String(a.order_time || ""))
      );
      const top3 = sorted.slice(0, 3);
      const lines = top3.map((x, i) => {
        const tag = x.src === "shopline" ? "[官網]" : x.src === "superlanding" ? "[一頁]" : "";
        return `${i + 1}. ${tag}${x.order_id}｜${x.order_time || ""}｜${x.payment_status_label}｜${x.st}`;
      });
      const reply =
        `查到 ${n} 筆訂單（${ch}）。${aggStr}。\n` +
        lines.join("\n") +
        (n > 3 ? `\n（另有 ${n - 3} 筆，說「全部訂單」可列出）` : "") +
        `\n要看哪一筆請回覆訂單編號。`;
      const o0 = sorted[0].o;
      const status0 = sorted[0].st;
      const successful_order_ids = orderSummaries.filter((x) => x.payment_status === "success").map((x) => x.order_id);
      const failed_order_ids = orderSummaries.filter((x) => x.payment_status === "failed").map((x) => x.order_id);
      const pending_order_ids = orderSummaries.filter((x) => x.payment_status === "pending").map((x) => x.order_id);
      const cod_order_ids = orderSummaries.filter((x) => x.payment_status === "cod").map((x) => x.order_id);
      const candidates = sorted.map((x) => ({
        order_id: x.order_id,
        payment_status: x.payment_status as "success" | "failed" | "pending" | "cod" | "unknown",
        payment_status_label: x.payment_status_label,
        fulfillment_status: x.st,
        order_time: x.order_time,
        source: (x.src === "shopline" || x.src === "superlanding" ? x.src : undefined) as
          | "shopline"
          | "superlanding"
          | undefined,
      }));
      const multiCtx = {
        ...buildActiveOrderContextFromOrder(o0, o0.source || orderSource, status0, reply, "text"),
        candidate_count: n,
        active_order_candidates: candidates,
        selected_order_id: null as string | null,
        last_lookup_source: orderSource,
        aggregate_payment_summary: aggStr,
        one_page_summary: reply,
        candidate_source_summary: ch,
        successful_order_ids,
        failed_order_ids,
        pending_order_ids,
        cod_order_ids,
        selected_order_rank: null as number | null,
      };
      storage.setActiveOrderContext(contactId, multiCtx);
      return {
        reply,
        fastPathType: preferShop ? "shopline_phone" : preferSl ? "superlanding_phone" : "phone",
      };
    }

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
      source_channel: sourceChannelLabel(o0.source),
    };
    const onePage = formatOrderOnePage(payload);
    if (isLocalOnlySingle || needsConfirm) {
      const candidate =
        isLocalOnlySingle
          ? formatLocalOnlyCandidateSummary({
              order_id: o0.global_order_id,
              created_at: o0.created_at || o0.order_created_at,
              product_list: o0.product_list,
              items_structured: o0.items_structured,
              source_channel: sourceChannelLabel(o0.source || orderSource),
              status_short: st,
            })
          : onePage;
      const reply =
        (isLocalOnlySingle
          ? "目前從已同步資料先看到 1 筆候選訂單（尚未最終確認）。\n\n"
          : "目前從已同步資料先看到 1 筆訂單；若您有更早或其他訂單，可說「還有其他訂單嗎」再查。\n\n") +
        candidate;
      storage.linkOrderForContact(contactId, o0.global_order_id, "ai_lookup");
      storage.setActiveOrderContext(
        contactId,
        buildActiveOrderContextFromOrder(o0, o0.source || orderSource, st, reply, "text")
      );
      storage.updateContactOrderSource(contactId, o0.source || orderSource);
      return {
        reply,
        fastPathType: preferShop ? "shopline_phone" : preferSl ? "superlanding_phone" : "phone",
      };
    }
    const reply = `幫您查到了：\n${onePage}`;
    storage.linkOrderForContact(contactId, o0.global_order_id, "ai_lookup");
    storage.setActiveOrderContext(
      contactId,
      buildActiveOrderContextFromOrder(o0, o0.source || orderSource, st, onePage, "text")
    );
    storage.updateContactOrderSource(contactId, o0.source || orderSource);
    return {
      reply,
      fastPathType: preferShop ? "shopline_phone" : preferSl ? "superlanding_phone" : "phone",
    };
  }

  return null;
}
