/**
 * 訂單回覆格式與付款狀態（供 fast path / tool 共用）
 * 付款狀態一律走 derivePaymentStatus，COD 顯示「貨到付款（到收／取件時付款）」。
 */
import type { OrderInfo, ActiveOrderContext } from "@shared/schema";
import { derivePaymentStatus, type PaymentKind } from "./order-payment-utils";

/** 訂單狀態轉成客人聽得懂的人話 */
export function customerFacingStatusLabel(raw: string): string {
  const s = (raw || "").trim();
  if (/待處理|pending/i.test(s)) return "訂單已收到，正在安排中";
  if (/處理中|processing/i.test(s)) return "正在安排出貨";
  if (/確認中/i.test(s)) return "付款確認中";
  if (/已出貨|shipped/i.test(s)) return "已出貨";
  if (/已完成|completed|delivered/i.test(s)) return "已完成";
  if (/已取消|cancelled/i.test(s)) return "已取消";
  if (/新訂單/i.test(s)) return "新訂單，準備中";
  if (/\[本地快取/i.test(s)) return "確認中";
  return s;
}

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
  if (o.status) lines.push(`狀態：${customerFacingStatusLabel(o.status)}`);
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
