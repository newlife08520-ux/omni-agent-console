/**
 * 訂單回覆格式與付款狀態（供 fast path / tool 共用）
 * 付款狀態一律走 derivePaymentStatus，COD 顯示「貨到付款（到收／取件時付款）」。
 */
import type { OrderInfo, ActiveOrderContext } from "@shared/schema";
import { derivePaymentStatus, type PaymentKind } from "./order-payment-utils";

const CVS_SHIPPING_KEYWORDS = ["超商", "門市", "7-11", "7-ELEVEN", "全家", "OK", "萊爾富"];

/**
 * 對客顯示用：禁止輸出 API 內部代碼（pending / to_store / credit_card 等）。
 * 若未辨識則回傳中性描述，避免把 raw 英文塞給客人。
 */
export function displayPaymentMethod(raw: string | null | undefined): string {
  const t = (raw || "").trim();
  if (!t) return "（此筆訂單系統未回傳）";
  const lower = t.toLowerCase().replace(/\s+/g, "_");
  if (lower === "pending") return "線上付款處理中（系統未顯示具體通道）";
  if (lower === "credit_card" || lower === "creditcard") return "信用卡";
  if (/^line[_\s-]?pay$/i.test(t) || lower.includes("linepay") || lower.includes("line_pay")) return "LINE Pay";
  if (/jkopay|街口/i.test(t)) return "街口支付";
  if (/apple[_\s-]?pay/i.test(t)) return "Apple Pay";
  if (/google[_\s-]?pay/i.test(t)) return "Google Pay";
  if (/atm|虛擬帳|轉帳|匯款|ibon|超商代碼|繳費/i.test(t)) return t.replace(/\bcredit_card\b/gi, "信用卡").replace(/\bpending\b/gi, "處理中");
  if (/貨到|到收|取件時付款|cod|cash_on_delivery/i.test(t)) return t;
  if (/^[a-z0-9_\-]+$/i.test(t) && t.length <= 32 && !/[\u4e00-\u9fff]/.test(t)) {
    return "線上支付（已隱藏內部代碼）";
  }
  return t.replace(/\bcredit_card\b/gi, "信用卡").replace(/\bpending\b/gi, "處理中").replace(/\bto_store\b/gi, "超商取貨");
}

export function displayShippingMethod(raw: string | null | undefined): string {
  const t = (raw || "").trim();
  if (!t) return "（此筆訂單系統未回傳）";
  const lower = t.toLowerCase();
  if (lower === "to_store" || lower.includes("to_store")) return "超商取貨";
  if (lower.includes("home") || /宅配|到府|delivery/i.test(t)) return "宅配";
  if (/超商|門市|7-11|全家|萊爾富|ok|取貨/i.test(t)) return t.replace(/\bto_store\b/gi, "超商取貨");
  if (/^[a-z0-9_\-]+$/i.test(t) && t.length <= 32 && !/[\u4e00-\u9fff]/.test(t)) {
    return "物流配送（已隱藏內部代碼）";
  }
  return t.replace(/\bto_store\b/gi, "超商取貨");
}

export type PayKind = PaymentKind;

export function payKindForOrder(order: OrderInfo, statusLabel: string, source: string): { kind: PayKind; label: string } {
  const p = derivePaymentStatus(order, statusLabel, source);
  return { kind: p.kind, label: p.label };
}

/**
 * Phase 2.9：對客商品明細人類可讀，禁止 raw JSON。
 * 優先 items_structured，再解析 product_list JSON，最後純字串。
 */
export function formatProductLinesForCustomer(o: {
  product_list?: string;
  items_structured?: unknown;
}): string {
  const raw = o.items_structured;
  if (Array.isArray(raw) && raw.length > 0) {
    const lines = raw.map((item: unknown) => {
      if (item != null && typeof item === "object") {
        const x = item as Record<string, unknown>;
        const name = String(x.name ?? x.title ?? x.product_name ?? x.product_title ?? x.code ?? "").trim();
        const qty = x.quantity ?? x.qty ?? 1;
        if (!name) return "";
        return `${name} × ${qty}`;
      }
      return String(item ?? "").trim();
    });
    const s = lines.filter(Boolean).join("；");
    if (s) return s;
  }
  const pl = o.product_list;
  if (pl == null || !String(pl).trim()) return "";
  const s = String(pl).trim();
  if (s.startsWith("[") && s.includes("{")) {
    try {
      const arr = JSON.parse(s) as unknown;
      if (Array.isArray(arr)) {
        const lines = arr.map((x: unknown) => {
          if (x != null && typeof x === "object") {
            const r = x as Record<string, unknown>;
            const name = String(r.name ?? r.title ?? r.product_name ?? r.code ?? "").trim();
            const qty = r.quantity ?? r.qty ?? 1;
            return name ? `${name} × ${qty}` : "";
          }
          return String(x ?? "").trim();
        });
        const out = lines.filter(Boolean).join("；");
        if (out) return out;
      }
    } catch {
      /* fall through */
    }
  }
  return s.replace(/\s*\n\s*/g, "；");
}

export function formatOrderOnePage(o: {
  order_id?: string;
  buyer_name?: string;
  buyer_phone?: string;
  created_at?: string;
  payment_method?: string;
  payment_status_label?: string;
  amount?: number;
  shipping_method?: string;
  tracking_number?: string;
  address?: string;
  product_list?: string;
  status?: string;
  shipped_at?: string;
  delivery_target_type?: string;
  cvs_brand?: string;
  cvs_store_name?: string;
  full_address?: string;
  source_channel?: string;
}): string {
  const lines: string[] = [];
  if (o.order_id) lines.push(`訂單編號：${o.order_id}`);
  if (o.source_channel) lines.push(`來源：${o.source_channel}`);
  if (o.buyer_name) lines.push(`收件人：${o.buyer_name}`);
  if (o.buyer_phone) lines.push(`電話：${o.buyer_phone}`);
  if (o.created_at) lines.push(`下單時間：${o.created_at}`);
  lines.push(`付款方式：${displayPaymentMethod(o.payment_method)}`);
  if (o.payment_status_label) lines.push(`付款狀態：${o.payment_status_label}`);
  if (o.amount != null) lines.push(`金額：$${Number(o.amount).toLocaleString()}`);
  lines.push(`配送方式：${displayShippingMethod(o.shipping_method)}`);
  if (o.tracking_number) lines.push(`物流單號：${o.tracking_number}`);
  const isCvs =
    o.delivery_target_type === "cvs" ||
    (o.delivery_target_type !== "home" &&
      CVS_SHIPPING_KEYWORDS.some((k) => (o.shipping_method || "").toLowerCase().includes(k.toLowerCase())));
  const addressDisplay = isCvs
    ? [o.cvs_brand, o.cvs_store_name, o.full_address].filter(Boolean).join(" ") || o.address
    : o.full_address || o.address;
  if (addressDisplay) lines.push(isCvs ? `門市／地址：${addressDisplay}` : `地址：${addressDisplay}`);
  const prodLine = formatProductLinesForCustomer({
    product_list: o.product_list,
    items_structured: (o as { items_structured?: unknown }).items_structured,
  });
  if (prodLine) lines.push(`商品：${prodLine}`);
  if (o.status) lines.push(`狀態：${o.status}`);
  if (o.shipped_at) lines.push(`出貨時間：${o.shipped_at}`);
  return lines.join("\n");
}

export function sourceChannelLabel(src: string | undefined): string {
  if (src === "shopline") return "官網（SHOPLINE）";
  if (src === "superlanding") return "一頁商店";
  return "訂單";
}

/** 對客回覆禁止出現的 API raw token（verify 與手動檢查共用） */
export const CUSTOMER_FACING_RAW_DENYLIST = ["pending", "to_store", "credit_card"] as const;

/** 若回覆含 denylist token（獨立詞／底線形式）回傳命中項，否則 null */
export function findCustomerFacingRawLeak(text: string): string | null {
  const s = text || "";
  for (const t of CUSTOMER_FACING_RAW_DENYLIST) {
    const esc = t.replace(/_/g, "[_\\s]");
    if (new RegExp(`(?:^|[^a-z0-9])${esc}(?:$|[^a-z0-9])`, "i").test(s)) return t;
  }
  return null;
}

/**
 * Phase34B：local_only 單筆僅給「候選摘要」，非 final order card。
 * 僅含：編號、時間、商品摘要、來源、狀態一句、下一步引導（不含電話／地址／金額／付款方式列）。
 */
export function formatLocalOnlyCandidateSummary(o: {
  order_id: string;
  created_at?: string;
  product_list?: string;
  items_structured?: unknown;
  source_channel?: string;
  status_short?: string;
}): string {
  const prod = formatProductLinesForCustomer({
    product_list: o.product_list,
    items_structured: o.items_structured,
  });
  const lines: string[] = [
    "【候選訂單摘要】（僅依目前已同步資料，非最終定案）",
    `訂單編號：${o.order_id}`,
  ];
  if (o.created_at) lines.push(`下單／建立時間：${o.created_at}`);
  if (prod) lines.push(`商品摘要：${prod}`);
  if (o.source_channel) lines.push(`來源：${o.source_channel}`);
  if (o.status_short) lines.push(`狀態（參考）：${o.status_short}`);
  lines.push(
    "",
    "下一步：若要確認是否還有其他訂單，請回「還有其他訂單嗎」；或補「商品名稱／下單日」方便核對。完整取貨、付款與地址等明細需待系統或人員再確認後提供。"
  );
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Phase 2.4：deterministic 模板禁用句型（verify 掃描） */
export const PHASE24_BANNED_DETERMINISTIC_PHRASES = [
  "我會隨時在這裡幫您",
  "感謝您的耐心等候",
  "感謝您的耐心",
  "非常抱歉造成您的困擾",
];

export function deterministicReplyHasBannedPhrase(text: string): string | null {
  const t = text || "";
  for (const p of PHASE24_BANNED_DETERMINISTIC_PHRASES) {
    if (t.includes(p)) return p;
  }
  return null;
}

function isDelayFulfillmentStatus(status: string | undefined): boolean {
  if (!status) return true;
  return /待出貨|新訂單|確認中|備貨|處理中|尚未出貨|排程|awaiting|confirming/i.test(status);
}

/** Phase 34-5／R1-5：品牌久候／預購話術（單一模板；不對客播報 pending／to_store／待出貨 等後台口吻） */
export const BRAND_DELAY_SHIPPING_TEMPLATE =
  "真的很不好意思讓您久等了🥺 這邊先跟您說聲抱歉。我們這邊出貨多為排單／預購型安排：若有現貨可排，會盡量在 5 個工作天內幫您處理；若屬預購或補貨批次，常見約 7–20 個工作天。這邊先不想亂跟您保證確切日期，但我先幫您催促加急、盡快確認最新安排。";

/** Active order 追問：COD 不誤導付款失敗；久候／出貨追問套用品牌話術（見 docs/persona） */
export function buildDeterministicFollowUpReply(ctx: ActiveOrderContext, userMessage?: string): string | null {
  if (!ctx?.order_id) return null;
  const msg = (userMessage || "").trim();
  const delayAsk =
    msg &&
    /什麼時候|多久|還沒|預購|缺貨|久等|出貨|寄出|到了嗎|怎麼還沒|沒收到貨|催/i.test(msg);
  const needsBrandDelay =
    delayAsk &&
    isDelayFulfillmentStatus(ctx.fulfillment_status) &&
    !ctx.tracking_no?.trim();

  const parts: string[] = [`訂單 ${ctx.order_id}`];
  if (ctx.payment_status && ctx.payment_status !== "unknown") {
    const paymentText =
      ctx.payment_status === "cod"
        ? "此筆為貨到付款（到收／取件時付款），不是付款失敗，取件時再付即可"
        : ctx.payment_status === "success"
          ? "已付款完成"
          : ctx.payment_status === "failed"
            ? "這筆線上款項未完成／未成立，若要繼續可重新下單或跟我說要查別筆"
            : "付款還在確認中";
    parts.push(paymentText);
  }
  /** R1-5：久候模板路徑不逐字唸後台狀態（待出貨等），改由上方品牌話術統一說明 */
  if (ctx.fulfillment_status && !needsBrandDelay) parts.push(`目前狀態：${ctx.fulfillment_status}`);
  if (ctx.delivery_target_type === "cvs") {
    const storeBits = [ctx.cvs_brand, ctx.cvs_store_name].filter(Boolean).join(" ").trim();
    const addr = (ctx.full_address || "").trim();
    if (storeBits || addr) {
      parts.push(
        storeBits
          ? `取貨門市：${storeBits}${addr ? `（${addr}）` : ""}`
          : `取貨地址：${addr}`
      );
    }
  } else if (ctx.full_address?.trim() || ctx.address_or_store?.trim()) {
    parts.push(`寄送地址：${(ctx.full_address || ctx.address_or_store || "").trim()}`);
  }
  if (ctx.tracking_no?.trim()) {
    parts.push(`物流單號 ${ctx.tracking_no.trim()}，可到物流公司網站查進度`);
  } else if (ctx.shipping_method?.trim() && ctx.delivery_target_type !== "cvs") {
    parts.push(`配送方式：${displayShippingMethod(ctx.shipping_method)}`);
  }
  const body = parts.length > 1 ? parts.join("；") + "。" : null;
  if (!body) return null;

  /** 已出貨有單號時追問「何時收到」：先道歉＋物流說明，不使用 5–20 工作天預購模板 */
  const receiptAsk =
    msg &&
    /什麼時候收到|何時收到|多久到貨|什麼時候到貨|什麼時候會到|還沒收到|沒收到貨/i.test(msg);
  if (receiptAsk && ctx.tracking_no?.trim()) {
    const intro =
      "了解您關心包裹何時會到，先跟您說聲不好意思讓您久候🙏 建議您先用上方物流單號到物流公司官網查最新配送進度；若顯示已送達您仍未收到，再跟我說我幫您反映。";
    return `${intro}\n\n${body}`;
  }

  if (needsBrandDelay) {
    const cvsNote =
      ctx.delivery_target_type === "cvs"
        ? " 出貨後系統才會更新物流／到店進度，到時也會比較清楚。"
        : "";
    return `${BRAND_DELAY_SHIPPING_TEMPLATE}${cvsNote}\n\n${body}`;
  }
  return body;
}
