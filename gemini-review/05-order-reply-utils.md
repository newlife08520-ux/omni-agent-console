# 05 - 訂單格式化（server/order-reply-utils.ts）

負責把訂單資料格式化成客人看到的文字卡片。
包含：formatOrderOnePage、formatProductLinesForCustomer、
customerFacingStatusLabel、customerFacingPaymentLabel、
displayPaymentMethod、displayShippingMethod、maskAddress 等。

請審查：
- 完整卡片格式是否清楚好讀
- 隱碼（姓名、電話、地址）是否正確
- 付款和狀態的人話轉換是否恰當
- 有沒有內部術語殘留

---

```typescript
/**
 * 訂單回覆格式與付款狀態（供 fast path / tool 共用）
 * 付款狀態一律走 derivePaymentStatus，COD 顯示「貨到付款（到收／取件時付款）」。
 */
import type { OrderInfo, ActiveOrderContext } from "@shared/schema";
import { derivePaymentStatus, type PaymentKind } from "./order-payment-utils";
import { maskName, maskPhone } from "./tool-llm-sanitize";

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

/** 付款標籤對客清洗——去掉工程感文字 */
export function customerFacingPaymentLabel(raw: string): string {
  const s = (raw || "").trim();
  if (/貨到付款/i.test(s)) return "貨到付款（取貨時付款）";
  if (/付款成功|已付款|已收款/i.test(s)) return "已付款";
  if (/付款失敗|未成立|授權失敗|刷卡不成功/i.test(s)) return "付款未成功";
  if (/同步中|確認中|processing|syncing/i.test(s)) return "付款確認中";
  if (/未付款|待付款/i.test(s)) return "尚未付款";
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

/**
 * 對客顯示用：禁止輸出 API 內部代碼（pending / to_store / credit_card 等）。
 * 若未辨識則回傳中性描述，避免把 raw 英文塞給客人。
 */
export function displayPaymentMethod(raw: string | null | undefined): string {
  const t = (raw || "").trim();
  if (!t) return "（此筆訂單系統未回傳）";
  // 黑貓宅配代收（也是貨到付款的一種）
  if (/黑貓|宅急便|t_cat/i.test(t) && /代收|貨到/.test(t)) return "貨到付款";
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
  const original = String(raw ?? "").trim();
  const s = original.toLowerCase();
  if (!s) return "";

  if (/cvs|超商|門市|取貨|711|7-11|全家|萊爾富|ok.?mart|hilife|pickup|to_store/.test(s)) return "超商取貨";

  if (/黑貓|宅急便|t[_\s]?cat/.test(s)) return "黑貓宅配";

  if (/宅配|home|delivery|到府|address|郵寄|寄送/.test(s)) return "宅配";

  if (/[\u4e00-\u9fff]/.test(s)) return original;

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
export function formatProductLinesForCustomer(o: {
  product_list?: string;
  items_structured?: unknown;
}): string {
  const raw = o.items_structured;
  if (Array.isArray(raw) && raw.length > 0) {
    const lines = raw.map((item: unknown) => {
      if (item != null && typeof item === "object") {
        const x = item as Record<string, unknown>;
        const name = String(
          x.product_name ?? x.name ?? x.item_name ?? x.title ?? x.product_title ?? x.code ?? ""
        ).trim();
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
  full_address?: string;
  source_channel?: string;
}): string {
  const lines: string[] = [];

  if (o.order_id) lines.push(`訂單編號：${o.order_id}`);

  if (o.buyer_name) lines.push(`收件人：${maskName(o.buyer_name)}`);

  if (o.buyer_phone) lines.push(`電話：${maskPhone(o.buyer_phone)}`);

  if (o.created_at) lines.push(`下單時間：${o.created_at}`);

  const prodLine = formatProductLinesForCustomer({
    product_list: o.product_list,
    items_structured: o.items_structured,
  });
  if (prodLine) {
    lines.push(`商品：${prodLine}`);
  }

  if (o.amount != null) lines.push(`金額：NT$ ${Number(o.amount).toLocaleString()}`);

  const label0 = (o.payment_status_label || "").trim();
  const ps = (o.payment_status || "").trim();
  const paySource =
    label0 || (/^(success|failed|pending|cod|unknown)$/i.test(ps) ? "" : ps);
  const payLabel = customerFacingPaymentLabel(paySource);
  const payMethod = displayPaymentMethod(o.payment_method);
  if (payLabel) {
    const methodSuffix = (o.payment_method || "").trim() ? `（${payMethod}）` : "";
    lines.push(`付款：${payLabel}${methodSuffix}`);
  }

  if (o.payment_warning && o.payment_warning.trim()) {
    lines.push(`⚠️ ${o.payment_warning}`);
  }

  const shipping = o.shipping_display || displayShippingMethod(o.shipping_method);

  const isCvs =
    o.delivery_target_type === "cvs" ||
    o.delivery_target_type === "超商" ||
    (o.delivery_target_type !== "home" &&
      o.delivery_target_type !== "宅配" &&
      CVS_SHIPPING_KEYWORDS.some((k) => (o.shipping_method || "").toLowerCase().includes(k.toLowerCase())));

  // 1. 超商取貨 → 門市名；2. 黑貓／一般宅配 → 配送標籤 + 地址隱碼（略過「台灣」占位）
  if (isCvs) {
    if (shipping) lines.push(`配送：${shipping}`);
    const storeName = [o.cvs_brand, o.cvs_store_name].filter(Boolean).join(" ");
    if (storeName) lines.push(`取貨門市：${storeName}`);
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
```
