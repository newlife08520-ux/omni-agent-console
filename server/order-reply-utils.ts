/**
 * 訂單回覆格式與付款狀態（供 fast path / tool 共用）
 * 付款狀態一律走 derivePaymentStatus；對客卡片見 formatOrderOnePage。
 */
import type { OrderInfo, ActiveOrderContext } from "@shared/schema";
import { derivePaymentStatus, isCodPaymentMethod, type PaymentKind } from "./order-payment-utils";

/** Phase 106.35 v2：formatOrderOnePage → buildOrderStatusFollowupHint 選填欄位 */
export type BuildOrderStatusFollowupHintExtras = {
  shippedAt?: string;
  deliveryStatusRaw?: string;
  /** 與第二參數併用：通常傳 shipping_method || shipping_type */
  shippingMethod?: string;
  source?: string;
};

const SHIPPED_DELIVERY_CODES = new Set([
  "collected",
  "request_accepted",
  "arrived",
  "shipped",
  "delivered",
  "partially_fulfilled",
  "已發貨",
  "已送達",
]);

function normalizeOrderStatusHint(s: string | null | undefined): string {
  return String(s ?? "")
    .trim()
    .toLowerCase();
}

function normalizeDeliveryRawHint(s: string | null | undefined): string {
  return String(s ?? "")
    .trim()
    .toLowerCase();
}

/** 分支 B：超商關鍵字（其餘視為宅配） */
function isConvenienceBranchShipping(shipRaw: string): boolean {
  const s = shipRaw || "";
  const lower = s.toLowerCase();
  if (
    /超商|7-11|711|tw_711|seven|全家|fami|萊爾富|hilife|ok\s*mart|ok\s*超商|convenience|cvs|門市|pickup|to_store|取貨/i.test(
      s
    ) ||
    /tw_family|tw_hilife|tw_ok|fmt|okm/i.test(lower)
  ) {
    return true;
  }
  if (/\bok\b/.test(lower) && /mart|超商/.test(s)) return true;
  return false;
}

function isPreparingBranchF(
  source: string | undefined,
  rawStatus: string,
  deliveryNorm: string,
  payKind: PaymentKind
): boolean {
  if (payKind !== "success" && payKind !== "cod") return false;
  const st = normalizeOrderStatusHint(rawStatus);
  const d = deliveryNorm.trim().toLowerCase();
  const zhPrep = /新訂單|待處理|確認中|已確認|待出貨|處理中/.test(rawStatus);

  if (source === "shopline") {
    if (d !== "pending" && d !== "") return false;
    return (
      st === "confirmed" ||
      st === "pending" ||
      st === "new_order" ||
      st === "processing" ||
      st === "awaiting_for_shipment" ||
      zhPrep
    );
  }

  return (
    st === "new_order" ||
    st === "pending" ||
    st === "confirming" ||
    st === "confirmed" ||
    st === "awaiting_for_shipment" ||
    st === "processing" ||
    zhPrep
  );
}
import { maskName, maskPhone } from "./tool-llm-sanitize";
import { getUnifiedStatusLabel } from "./order-service";

/** 訂單狀態轉成客人聽得懂的極簡業務語言（Phase 106.10） */
export function customerFacingStatusLabel(rawStatus: string | null | undefined): string {
  if (!rawStatus) return "處理中";

  const s = rawStatus.toLowerCase().trim();

  if (s === "shipped" || s === "shipping" || /已出貨|出貨中/.test(rawStatus)) {
    return "已出貨";
  }
  if (s === "canceled" || s === "cancelled" || /已取消|取消/.test(rawStatus)) {
    return "已取消";
  }
  if (s === "returned" || /已退貨|退貨/.test(rawStatus)) {
    return "已退貨";
  }
  if (s === "refunded" || /已退款|退款完成/.test(rawStatus)) {
    return "已退款";
  }
  if (s === "awaiting_for_shipment" || /待出貨/.test(rawStatus)) {
    return "待出貨";
  }
  if (s === "confirmed" || /已確認/.test(rawStatus)) {
    return "已確認";
  }
  if (s === "replacement" || /換貨/.test(rawStatus)) {
    return "換貨處理中";
  }
  if (s === "delay_handling" || /延遲/.test(rawStatus)) {
    return "出貨稍有延遲";
  }
  if (s === "new_order" || /新訂單/.test(rawStatus)) {
    return "訂單已收到";
  }
  if (s === "pending" || /待處理/.test(rawStatus)) {
    return "處理中";
  }
  if (s === "confirming" || /確認中/.test(rawStatus)) {
    return "訂單確認中";
  }
  if (s === "refunding" || /退款中/.test(rawStatus)) {
    return "退款處理中";
  }
  if (/\[本地快取/i.test(rawStatus)) {
    return "確認中";
  }
  return rawStatus;
}

/**
 * 依訂單狀態 + 物流 raw + 付款組配套提醒（僅單筆完整卡片使用）
 * Phase 106.34：payKind（失敗／未付）
 * Phase 106.35 v2：Shopline 以 delivery_status_raw（真實 API 英文碼）優先於狀態字串；分支 A～G
 */
export function buildOrderStatusFollowupHint(
  rawStatus: string | null | undefined,
  shippingMethod: string | null | undefined,
  payKind: PaymentKind,
  extras?: BuildOrderStatusFollowupHintExtras
): string {
  const orderSt = String(rawStatus ?? "").trim();
  const deliveryRaw = extras?.deliveryStatusRaw;
  const deliveryNorm = normalizeDeliveryRawHint(deliveryRaw);
  const shipCombined = String(extras?.shippingMethod ?? shippingMethod ?? "").trim();
  const source = extras?.source;

  if (!orderSt && !deliveryNorm) return "";

  const st = normalizeOrderStatusHint(orderSt);

  // --- 分支 A：已取消（訂單狀態優先）---
  if (st === "cancelled" || st === "canceled" || orderSt.trim() === "已取消") {
    return "\n\n您這筆訂單已取消唷～如果還是有需要商品，歡迎重新下單；若有付款相關問題，我們專員會再協助您確認。";
  }

  // --- 分支 B：已出貨／履約（delivery_status_raw）---
  if (deliveryNorm && SHIPPED_DELIVERY_CODES.has(deliveryNorm)) {
    const dateStr = extras?.shippedAt ? formatDateTaipei(extras.shippedAt, "YYYY-MM-DD") : "";
    const hasDate = !!dateStr;
    const cvs = isConvenienceBranchShipping(shipCombined);
    if (cvs) {
      if (hasDate) {
        return `\n\n您這筆訂單已於 ${dateStr} 出貨到您選擇的門市唷～到店後會收到簡訊通知，記得在期限內領取。`;
      }
      return "\n\n您這筆訂單已出貨到您選擇的門市唷～到店後會收到簡訊通知，記得在期限內領取。";
    }
    if (hasDate) {
      return `\n\n您這筆訂單已於 ${dateStr} 出貨唷～實際送達時間依物流配送時程為準，如果需要追蹤編號可以告訴我。`;
    }
    return "\n\n您這筆訂單已出貨唷～實際送達時間依物流配送時程為準，如果需要追蹤編號可以告訴我。";
  }

  // --- 分支 C：退貨／逾期（delivery）---
  if (deliveryNorm === "returning") {
    return "\n\n您的訂單目前正在退貨處理中，請稍候唷～有進一步疑問歡迎告訴我。";
  }
  if (deliveryNorm === "returned") {
    return "\n\n您的訂單已完成退貨處理唷～如果還需要商品歡迎重新下單。";
  }
  if (deliveryNorm === "expired") {
    return "\n\n您這筆訂單超商取貨已逾期，會自動退回店家唷～如果還需要商品歡迎重新下單。";
  }

  // --- 分支 D：付款失敗 ---
  if (payKind === "failed") {
    return "\n\n您的訂單付款未成功，請重新下單或聯繫我們協助處理。";
  }

  // --- 分支 E：未付款（非 COD；cod 為獨立 PaymentKind 不會進此分支）---
  if (payKind === "pending" || payKind === "unknown") {
    return "\n\n您的訂單因為付款還未完成，我們暫時無法安排出貨唷～請完成付款後系統會自動處理；如果付款遇到問題需要取消重下，請告訴我。";
  }

  // --- 分支 F：準備中（已付或 COD）---
  if (isPreparingBranchF(source, orderSt, deliveryNorm, payKind)) {
    return "\n\n您這筆訂單已收到，正在為您安排～關於出貨時間，現貨商品大概 5 個工作天內會幫您安排寄出；預售商品可能會稍等 7-20 個工作天唷～";
  }

  // --- 分支 G：其他 ---
  return "";
}

/** 付款標籤對客清洗——去掉工程感文字 */
export function customerFacingPaymentLabel(raw: string): string {
  const s = (raw || "").trim();
  if (!s) return "";
  if (/^(success|paid)$/i.test(s)) return "已付款";
  if (/^failed$/i.test(s)) return "付款失敗";
  if (/^pending$/i.test(s)) return "未付款";
  if (/^cod$/i.test(s)) return "貨到付款";
  if (/^unknown$/i.test(s)) return "未付款";
  if (/貨到付款/i.test(s)) return "貨到付款";
  if (/已付款|付款成功|已收款|已收/i.test(s)) return "已付款";
  if (/失敗|取消|未成立|授權失敗|刷卡不成功/i.test(s)) return "付款失敗";
  if (/未付款|待付款/i.test(s)) return "未付款";
  if (/同步中|確認中|processing|syncing|pending/i.test(s)) return "未付款";
  return s;
}

/** 宅配地址隱碼：只顯示縣市區 + *** */
export function maskAddress(addr: string): string {
  const s = (addr || "").trim();
  if (!s) return "";
  const match = s.match(/^(.{2,8}(?:市|區|鎮|鄉|里|村))/);
  if (match) return match[1] + "***";
  return s.length > 6 ? s.slice(0, 6) + "***" : s;
}

const CVS_SHIPPING_KEYWORDS = ["超商", "門市", "7-11", "7-ELEVEN", "全家", "OK", "萊爾富"];

/** 對客顯示用：辨識常見付款方式；無法辨識則回空字串（由付款狀態列處理）。 */
export function displayPaymentMethod(raw: string | null | undefined): string {
  const t = (raw || "").trim();
  if (!t) return "";

  if (
    /貨到付款|到收|取件時付款|cod|cash_on_delivery|tw_711_b2c_pay|tw_fami_b2c_pay|tw_hilife_b2c_pay|tw_ok_b2c_pay|b2c_pay|home_delivery_cod/i.test(
      t
    )
  )
    return "貨到付款";
  if (/黑貓|宅急便|t_cat/i.test(t) && /代收|貨到/.test(t)) return "貨到付款";

  const lower = t.toLowerCase().replace(/\s+/g, "_");
  if (lower === "credit_card" || lower === "creditcard" || /信用卡|刷卡/.test(t)) return "信用卡";
  if (/line[_\s-]?pay/i.test(t)) return "LINE Pay";
  if (/jkopay|街口/i.test(t)) return "街口支付";
  if (/apple[_\s-]?pay/i.test(t)) return "Apple Pay";
  if (/google[_\s-]?pay/i.test(t)) return "Google Pay";
  if (/atm|虛擬帳|轉帳|匯款/i.test(t)) return "ATM 轉帳";
  if (/ibon|超商代碼|繳費/i.test(t)) return "超商代碼繳費";

  if (lower === "pending") return "";

  if (/[\u4e00-\u9fff]/.test(t)) return t;

  return "";
}

/**
 * SuperLanding／Shopline 物流代碼轉對客文案；isCod 時加「（貨到付款）」以利宅配到付與超商取貨付款區分。
 */
export function displayShippingMethod(raw: string | null | undefined, isCod?: boolean): string {
  const original = String(raw ?? "").trim();
  const lower = original.toLowerCase();
  if (!original) return "";

  const c = !!isCod;

  // === Shopline 平台代碼（含 delivery_type / platform 片段）===
  if (/tw_711|seven|7-?11/.test(lower)) {
    return c ? "7-11 取貨付款" : "7-11 取貨";
  }
  if (/tw_family|^family$|fmt|fami|全家/.test(lower)) {
    return c ? "全家取貨付款" : "全家取貨";
  }
  if (/tw_hilife|hilife|萊爾富/.test(lower)) {
    return c ? "萊爾富取貨付款" : "萊爾富取貨";
  }
  if (/tw_okmart|okm|^ok_|ok\.?mart/.test(lower)) {
    return c ? "OK 超商取貨付款" : "OK 超商取貨";
  }
  if (/^pickup$/i.test(lower)) {
    return c ? "超商取貨付款" : "超商取貨";
  }
  if (/^home_delivery$/i.test(lower)) {
    return c ? "宅配到府（貨到付款）" : "宅配到府";
  }

  if (/to_home|home_delivery/i.test(lower) || /宅配|到府|郵寄|寄送/i.test(original)) {
    return c ? "宅配到府（貨到付款）" : "宅配到府";
  }
  if (
    lower.includes("home") &&
    !/store|cvs|711|fami|hilife|okm|seven|fmt|to_store|pickup|eleven|超商|門市|全家|萊爾富/i.test(lower)
  ) {
    return c ? "宅配到府（貨到付款）" : "宅配到府";
  }

  if (/黑貓|宅急便|t[_\s]?cat/i.test(lower)) {
    return c ? "黑貓宅配（貨到付款）" : "黑貓宅配";
  }

  if (/cvs|超商|門市|取貨|711|pickup|to_store|便利|商店/i.test(lower)) {
    return c ? "超商取貨付款" : "超商取貨";
  }

  if (/[\u4e00-\u9fff]/.test(original)) return original;

  return "";
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
function productLineNameFromRow(row: Record<string, unknown>): string {
  const zhTitle =
    row.title_translations != null && typeof row.title_translations === "object"
      ? String((row.title_translations as Record<string, string>)["zh-hant"] ?? "").trim()
      : "";
  const name = String(
    row.product_name ??
      row.name ??
      row.item_name ??
      row.title ??
      row.product_title ??
      row.variant_title ??
      row.variant_name ??
      row.line_item_title ??
      row.display_name ??
      zhTitle ??
      ""
  ).trim();
  const code = String(row.code ?? row.sku ?? row.variant_id ?? row.product_id ?? "").trim();
  if (name) return name;
  if (code) return `品項（${code}）`;
  return "";
}

export function formatProductLinesForCustomer(o: {
  product_list?: string;
  items_structured?: unknown;
}): string {
  let raw: unknown = o.items_structured;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (t.startsWith("[") || t.startsWith("{")) {
      try {
        raw = JSON.parse(t) as unknown;
      } catch {
        raw = null;
      }
    }
  }
  if (Array.isArray(raw) && raw.length > 0) {
    const lines = raw.map((item: unknown) => {
      if (item != null && typeof item === "object") {
        const x = item as Record<string, unknown>;
        const label = productLineNameFromRow(x);
        const qty = x.quantity ?? x.qty ?? 1;
        if (!label) return "";
        return `${label} × ${qty}`;
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
            const label = productLineNameFromRow(r);
            const qty = r.quantity ?? r.qty ?? 1;
            return label ? `${label} × ${qty}` : "";
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
  /** 手機查單時 API／快取若未帶收件電話，用客人提供的號碼做隱碼顯示 */
  display_phone_if_missing?: string;
  created_at?: string;
  payment_method?: string;
  payment_status_label?: string;
  payment_status?: string;
  payment_warning?: string;
  amount?: number;
  shipping_method?: string;
  shipping_display?: string;
  tracking_number?: string;
  address?: string;
  product_list?: string;
  items_structured?: unknown;
  status?: string;
  shipped_at?: string;
  delivery_target_type?: string;
  cvs_brand?: string;
  cvs_store_name?: string;
  store_location?: string;
  full_address?: string;
  source_channel?: string;
  /** 與 OrderInfo.source 一致時可正確套用 SuperLanding pending+to_home 等 COD 規則 */
  source?: string;
  prepaid?: boolean;
  paid_at?: string | null;
  /** API 原始 fulfillment status，供配套提醒（與對客 status 文案分離） */
  fulfillment_status_raw?: string | null;
  /** Shopline：order_delivery.delivery_status 等 */
  delivery_status_raw?: string;
  shipping_type?: string;
}): string {
  const lines: string[] = [];

  if (o.order_id) lines.push(`訂單編號：${o.order_id}`);

  if (o.buyer_name) lines.push(`收件人：${maskName(o.buyer_name)}`);

  const phoneLine = String(o.buyer_phone || "").trim() || String(o.display_phone_if_missing || "").trim();
  if (phoneLine) lines.push(`電話：${maskPhone(phoneLine)}`);

  if (o.created_at) lines.push(`下單時間：${o.created_at}`);

  const prodLine = formatProductLinesForCustomer({
    product_list: o.product_list,
    items_structured: o.items_structured,
  }).trim();
  // 固定格式：一定有一行「商品」，避免 LLM／空明細時整段消失
  lines.push(`商品：${prodLine || "暫無明細"}`);

  if (o.amount != null) lines.push(`金額：NT$ ${Number(o.amount).toLocaleString()}`);

  const codProbe = {
    source: o.source,
    payment_method: o.payment_method,
    shipping_method: o.shipping_method,
    delivery_target_type: o.delivery_target_type,
    prepaid: o.prepaid,
    paid_at: o.paid_at ?? null,
  } as OrderInfo;
  const srcRaw = String(o.source || "superlanding");
  const srcForPayKind = srcRaw === "shopline" ? "shopline" : "superlanding";
  const rawFulfillmentForPay = String(o.fulfillment_status_raw ?? "").trim() || String(o.status ?? "").trim();
  const orderForPayKind = {
    ...codProbe,
    status: rawFulfillmentForPay,
    global_order_id: String(o.order_id ?? ""),
  } as OrderInfo;
  const unifiedStatusForPayKind = getUnifiedStatusLabel(rawFulfillmentForPay, srcForPayKind);
  const { kind: payKindForHint } = payKindForOrder(orderForPayKind, unifiedStatusForPayKind, srcForPayKind);

  const isCod =
    isCodPaymentMethod(codProbe) ||
    o.payment_status === "cod" ||
    /^cod$/i.test(String(o.payment_status || "").trim()) ||
    /貨到付款|到收/i.test(String(o.payment_status_label || ""));

  const pmLower = String(o.payment_method || "").trim().toLowerCase();
  const payMethod =
    isCod && pmLower === "pending" ? "貨到付款" : displayPaymentMethod(o.payment_method);

  let payLabel = customerFacingPaymentLabel(
    String(o.payment_status_label || "").trim() || String(o.payment_status || "").trim()
  );
  if (isCod && (!payLabel || payLabel === "未付款")) {
    payLabel = "貨到付款";
  }

  const isCvs =
    o.delivery_target_type === "cvs" ||
    o.delivery_target_type === "超商" ||
    (o.delivery_target_type !== "home" &&
      o.delivery_target_type !== "宅配" &&
      CVS_SHIPPING_KEYWORDS.some((k) => (o.shipping_method || "").toLowerCase().includes(k.toLowerCase())));

  if (payMethod === "貨到付款" && isCvs) {
    lines.push("付款：貨到付款（取貨時付款）");
  } else if (payMethod === "貨到付款") {
    lines.push("付款：貨到付款");
  } else if (payLabel && payMethod) {
    lines.push(`付款：${payLabel}（${payMethod}）`);
  } else if (payLabel) {
    lines.push(`付款：${payLabel}`);
  }

  const shipping = o.shipping_display || displayShippingMethod(o.shipping_method, isCod);

  // 1. 超商取貨 → 門市名；2. 黑貓／一般宅配 → 配送標籤 + 地址隱碼（略過「台灣」占位）
  if (isCvs) {
    if (shipping) lines.push(`配送：${shipping}`);
    const storeDisplay =
      String(o.store_location || "").trim() ||
      [o.cvs_brand, o.cvs_store_name].filter(Boolean).join(" ");
    if (storeDisplay) lines.push(`取貨門市：${storeDisplay}`);
  } else {
    if (shipping) lines.push(`配送：${shipping}`);
    const addr = o.full_address || o.address || "";
    if (addr && addr !== "台灣") {
      lines.push(`寄送地址：${maskAddress(addr)}`);
    }
  }

  if (o.tracking_number) lines.push(`物流單號：${o.tracking_number}`);

  if (o.status) lines.push(`狀態：${customerFacingStatusLabel(o.status)}`);

  if (o.shipped_at) lines.push(`出貨時間：${o.shipped_at}`);

  const card = lines.join("\n");
  const orderStatusForHint = String(o.fulfillment_status_raw ?? o.status ?? "").trim() || undefined;
  const shipHint = String(o.shipping_method || o.shipping_type || "").trim() || undefined;
  const hint = buildOrderStatusFollowupHint(orderStatusForHint, shipHint, payKindForHint, {
    shippedAt: o.shipped_at,
    deliveryStatusRaw: o.delivery_status_raw || undefined,
    source: o.source,
  });
  return card + hint;
}

/** 台北時區日期字串（對客用，禁止輸出 ISO raw） */
export function formatDateTaipei(isoOrRaw: string | null | undefined, pattern: "YYYY-MM-DD"): string {
  if (pattern !== "YYYY-MM-DD") return "";
  const raw = String(isoOrRaw ?? "").trim();
  if (!raw) return "";
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(t));
}

const EXT_LIST_NAME_MAX = 20;
const EXT_LIST_ITEMS_MAX = 2;

function truncateProductNameForList(name: string): string {
  const t = name.trim();
  if (t.length <= EXT_LIST_NAME_MAX) return t;
  return t.slice(0, EXT_LIST_NAME_MAX) + "…";
}

/** 擴充清單：拆出品項（名稱 + 數量） */
function parseOrderLineItemsForExtendedList(o: {
  product_list?: string;
  items_structured?: unknown;
}): { name: string; qty: number }[] {
  let raw: unknown = o.items_structured;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (t.startsWith("[") || t.startsWith("{")) {
      try {
        raw = JSON.parse(t) as unknown;
      } catch {
        raw = null;
      }
    }
  }
  const out: { name: string; qty: number }[] = [];
  if (Array.isArray(raw) && raw.length > 0) {
    for (const item of raw) {
      if (item != null && typeof item === "object") {
        const x = item as Record<string, unknown>;
        const label = productLineNameFromRow(x);
        const qty = Number(x.quantity ?? x.qty ?? 1) || 1;
        if (label) out.push({ name: label, qty });
      }
    }
    if (out.length) return out;
  }
  const pl = o.product_list;
  if (pl == null || !String(pl).trim()) return [];
  const s = String(pl).trim();
  if (s.startsWith("[") && s.includes("{")) {
    try {
      const arr = JSON.parse(s) as unknown;
      if (Array.isArray(arr)) {
        for (const x of arr) {
          if (x != null && typeof x === "object") {
            const r = x as Record<string, unknown>;
            const label = productLineNameFromRow(r);
            const qty = Number(r.quantity ?? r.qty ?? 1) || 1;
            if (label) out.push({ name: label, qty });
          }
        }
      }
    } catch {
      return [];
    }
    return out;
  }
  return [];
}

function formatExtendedProductSummary(o: {
  product_list?: string;
  items_structured?: unknown;
}): string {
  const rows = parseOrderLineItemsForExtendedList(o);
  if (rows.length === 0) return "暫無明細";
  const head = rows.slice(0, EXT_LIST_ITEMS_MAX).map((r) => `${truncateProductNameForList(r.name)} ×${r.qty}`);
  const joined = head.join(", ");
  if (rows.length <= EXT_LIST_ITEMS_MAX) return joined;
  return `${joined}，等 ${rows.length} 項`;
}

function formatExtendedAmountPaymentLine(o: OrderInfo, statusLabel: string, source: string): string {
  const amt = o.final_total_order_amount;
  const amtStr = amt != null && !Number.isNaN(Number(amt)) ? `NT$${Number(amt).toLocaleString()}` : "金額未明";
  const pk = payKindForOrder(o, statusLabel, source);
  const pm = displayPaymentMethod(o.payment_method);
  const isCod =
    isCodPaymentMethod(o) ||
    pk.kind === "cod" ||
    /^cod$/i.test(String(pk.kind || "").trim()) ||
    /貨到付款|到收/i.test(String(pk.label || ""));
  let payPart = pm || customerFacingPaymentLabel(pk.label) || customerFacingPaymentLabel(String(pk.kind || ""));
  if (isCod && (!payPart || payPart === "未付款")) payPart = "貨到付款";
  if (!payPart) payPart = "未註明";
  return `金額：${amtStr}｜${payPart}`;
}

/**
 * Phase 106.3：手機多筆（4+）擴充清單；每筆 5 行，筆間空一行。
 * brandContext 保留供日後品牌語氣／幣別擴充。
 */
export function formatExtendedOrderList(orders: OrderInfo[], _brandContext?: unknown): string {
  const blocks: string[] = [];
  for (const o of orders) {
    const src = (o.source || "superlanding") as string;
    const st = getUnifiedStatusLabel(o.status, src);
    const id = String(o.global_order_id || "").trim() || "—";
    const dateStr = formatDateTaipei(o.order_created_at || o.created_at, "YYYY-MM-DD") || "—";
    const recv = String(o.buyer_name || "").trim();
    const recvLine = recv ? maskName(recv) : "—";
    const lines = [
      `${id}｜${dateStr}`,
      `收件人：${recvLine}`,
      `商品：${formatExtendedProductSummary(o)}`,
      formatExtendedAmountPaymentLine(o, st, src),
      `狀態：${customerFacingStatusLabel(st)}`,
    ];
    blocks.push(lines.join("\n"));
  }
  return (
    blocks.join("\n\n") +
    "\n\n要看哪一筆完整資訊請回覆訂單編號或「第 N 筆」。"
  );
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
 * 僅含：編號、時間、商品摘要、狀態一句、下一步引導（不含電話／地址／金額／付款方式列）。
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
    "以下是目前查到的訂單資訊：",
    `訂單編號：${o.order_id}`,
  ];
  if (o.created_at) lines.push(`下單／建立時間：${o.created_at}`);
  if (prod) lines.push(`商品摘要：${prod}`);
  if (o.status_short) lines.push(`狀態：${customerFacingStatusLabel(o.status_short)}`);
  lines.push(
    "",
    "若要看其他訂單或確認更多細節，隨時跟我說。"
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

/** P0：久候模板已停用；若需話術請改由 DB／LLM */
export const BRAND_DELAY_SHIPPING_TEMPLATE = "";

/** P0 Minimal Safe Mode：不組確定性追問句，交還 LLM */
export function buildDeterministicFollowUpReply(_ctx: ActiveOrderContext, _userMessage?: string): string | null {
  return null;
}
