/**
 * Phase 31：查單政策統一 — fast path 與 tool path 共用。
 * 目標：有單號直接查；沒單號預設商品+手機；純手機僅在「查全部/其他訂單」時允許，且 local_only 單筆不得定案。
 */

import { ORDER_FOLLOWUP_PATTERNS } from "./conversation-state-resolver";

/** 簡化版 active context 用於意圖推斷（僅需部分欄位） */
export interface OrderLookupPolicyContext {
  order_id?: string | null;
  candidate_count?: number | null;
  active_order_candidates?: unknown[] | null;
  selected_order_id?: string | null;
}

export type OrderLookupIntentKind =
  | "order_id_direct"
  | "product_phone_rescue"
  | "phone_all_orders"
  | "phone_ambiguous"
  | "followup_on_selected_order"
  | "date_contact_rescue";

export interface OrderLookupIntent {
  kind: OrderLookupIntentKind;
  /** 此意圖是否要求先有商品關鍵字（沒單號時預設要商品+手機） */
  requiresProduct: boolean;
  /** 是否允許僅用手機直接查（僅在查全部/其他訂單等明確情境） */
  allowPhoneOnly: boolean;
  /** 單筆結果是否需先 live API 確認才能當最終答案（local_only 單筆時為 true） */
  requireApiConfirmBeforeSingleClaim: boolean;
  /** 純手機等情境：Tool 層只允許摘要、不得對 LLM 輸出單筆明細 */
  summaryOnly: boolean;
}

const ORDER_ID_PATTERN = /[A-Za-z][A-Za-z0-9\-]{4,13}/g;
const TW_PHONE = /09\d{8}/;

/** 是否像「查全部 / 還有其他訂單 / 我有幾筆」 */
const PHONE_ALL_ORDERS_KW =
  /全部訂單|所有訂單|還有其他訂單|其他訂單|我有幾筆|我有幾個訂單|幾筆訂單|幾個訂單|查我全部|全部查|列出全部|列出所有/i;

/** 是否像「官網」查單（僅查 SHOPLINE） */
const SHOPLINE_HINTS = /官網|官方網站|官網購買|官網下單|官網買|在官網|從官網|SHOPLINE|shopline/i;

/** 是否像「一頁」查單 */
const SUPERLANDING_HINTS = /一頁商店|一頁|粉絲團|團購|superlanding|SuperLanding/i;

/** Phase 32/33：反向語句 — 清除或反轉官網偏好 */
const SHOPLINE_NEGATIVE =
  /不是官網|不是官網的|不是在官網買的|不是在官網|不是官方網站|不是網站買的|不是網站|不是那個平台|粉專買的|一頁買的|團購買的|社團買的/i;

/** Phase 32 Ticket 1：查單來源意圖 — 僅當前句＋負向即清，不讓「官網」殘留到下一支手機 */
export type OrderSourceIntent = "shopline" | "superlanding" | "unknown";

/** Phase 33 Ticket 33-1：含 clear，呼叫端可明確清除 sticky preference */
export type LookupSourceIntent = "shopline" | "superlanding" | "unknown" | "clear";

/**
 * Phase 33 Ticket 33-1：偵測查單來源意圖。
 * - 當前句含負向語句 → `clear`（應清除先前官網偏好）。
 * - 當前句同時含手機與負向 → 僅依當前句，不讀 recent 的官網。
 */
export function detectLookupSourceIntent(
  currentMessage: string,
  recentMessages?: string[]
): LookupSourceIntent {
  const msg = (currentMessage || "").trim();
  if (SHOPLINE_NEGATIVE.test(msg)) return "clear";
  if (SHOPLINE_HINTS.test(msg)) return "shopline";
  if (SUPERLANDING_HINTS.test(msg)) return "superlanding";

  const isOnlyPhone = /^09\d{8}$/.test(msg.replace(/\s/g, "")) || /^\+?8869\d{8}$/.test(msg.replace(/\s/g, ""));
  if (isOnlyPhone && msg.length <= 14) {
    // 純手機句允許繼承上一句的官網/一頁意圖（窄繼承）
    if (Array.isArray(recentMessages) && recentMessages.length > 0) {
      const lastUserMsg = recentMessages[recentMessages.length - 1] || "";
      if (SHOPLINE_HINTS.test(lastUserMsg)) return "shopline";
      if (SUPERLANDING_HINTS.test(lastUserMsg)) return "superlanding";
    }
    return "unknown";
  }

  return "unknown";
}

export function resolveOrderSourceIntent(
  currentMessage: string,
  recentMessages?: string[]
): OrderSourceIntent {
  const d = detectLookupSourceIntent(currentMessage, recentMessages);
  if (d === "clear") return "unknown";
  return d;
}

function extractOrderId(msg: string): string | null {
  const t = (msg || "").trim();
  /** Phase 34-2：官網（SHOPLINE）長純數字單號，與人格／查單決策樹一致 */
  if (/^\d{15,22}$/.test(t)) return t;
  if (t.length >= 5 && t.length <= 14 && /^[A-Za-z0-9\-]+$/.test(t) && !/^09\d/.test(t)) return t.toUpperCase();
  let m: RegExpExecArray | null;
  ORDER_ID_PATTERN.lastIndex = 0;
  while ((m = ORDER_ID_PATTERN.exec(msg)) !== null) {
    const u = m[0].toUpperCase();
    if (/^09\d/.test(u)) continue;
    if (u.length >= 5 && u.length <= 14) return u;
  }
  const isolatedLong = msg.match(/(?<!\d)\d{15,22}(?!\d)/);
  if (isolatedLong) return isolatedLong[0];
  return null;
}

function extractPhone(msg: string): string | null {
  const m = (msg || "").match(TW_PHONE);
  return m ? m[0] : null;
}

/** 整行幾乎只有手機號（無其他明顯關鍵字） */
function isLineMostlyPhone(msg: string): boolean {
  const t = (msg || "").trim().replace(/\s/g, "");
  return /^09\d{8}$/.test(t) || /^\+8869\d{8}$/.test(t) || /^8869\d{8}$/.test(t);
}

/**
 * 依使用者訊息與近期對話、active context 推斷查單意圖。
 */
export function deriveOrderLookupIntent(
  userMessage: string,
  recentMessages: string[],
  activeCtx: OrderLookupPolicyContext | null | undefined
): OrderLookupIntent {
  const msg = (userMessage || "").trim();
  const recent = (recentMessages || []).slice(-5).join(" ");
  const combined = `${msg} ${recent}`;

  // 有訂單號 → 直接查，不補問
  const orderId = extractOrderId(msg);
  if (orderId) {
    return {
      kind: "order_id_direct",
      requiresProduct: false,
      allowPhoneOnly: false,
      requireApiConfirmBeforeSingleClaim: false,
      summaryOnly: false,
    };
  }

  // 已有選定訂單的追問（出貨、付款、地址等）
  if (activeCtx?.order_id && activeCtx?.selected_order_id === null && !extractOrderId(msg)) {
    if (ORDER_FOLLOWUP_PATTERNS.test(msg)) {
      return {
        kind: "followup_on_selected_order",
        requiresProduct: false,
        allowPhoneOnly: false,
        requireApiConfirmBeforeSingleClaim: false,
        summaryOnly: false,
      };
    }
  }

  // 僅「當前訊息」命中查全部／其他訂單等，才允許 phone-only（禁止用 combined 從歷史幽靈放行）
  if (PHONE_ALL_ORDERS_KW.test(msg)) {
    return {
      kind: "phone_all_orders",
      requiresProduct: false,
      allowPhoneOnly: true,
      requireApiConfirmBeforeSingleClaim: true, // 單筆時仍要確認
      summaryOnly: false,
    };
  }

  const phone = extractPhone(msg);

  // P0：純手機（無單號、非「查全部」）一律補問商品，禁止只拿手機當單筆答案
  if (phone && isLineMostlyPhone(msg)) {
    return {
      kind: "phone_ambiguous",
      requiresProduct: true,
      allowPhoneOnly: false,
      requireApiConfirmBeforeSingleClaim: true,
      summaryOnly: true,
    };
  }

  const sourceIntent = resolveOrderSourceIntent(msg, recentMessages ?? []);
  const hasShopline = sourceIntent === "shopline";
  const hasSuperlanding = sourceIntent === "superlanding";

  // 官網+手機 或 一頁+手機（同一句明確意圖）：允許該管道用手機查
  if ((hasShopline || hasSuperlanding) && phone) {
    return {
      kind: "product_phone_rescue",
      requiresProduct: false,
      allowPhoneOnly: true,
      requireApiConfirmBeforeSingleClaim: true,
      summaryOnly: false,
    };
  }

  // 含手機但非純手機列（例如「查訂單 09…」）→ 仍要求補齊商品語意前不當 phone-only 定案
  if (phone && /查訂單|幫我查|訂單查詢/i.test(msg)) {
    return {
      kind: "phone_ambiguous",
      requiresProduct: true,
      allowPhoneOnly: false,
      requireApiConfirmBeforeSingleClaim: true,
      summaryOnly: true,
    };
  }

  // 有商品關鍵字 + 手機
  if (phone && msg.length > 12) {
    return {
      kind: "product_phone_rescue",
      requiresProduct: false,
      allowPhoneOnly: false,
      requireApiConfirmBeforeSingleClaim: true,
      summaryOnly: false,
    };
  }

  return {
    kind: "phone_ambiguous",
    requiresProduct: true,
    allowPhoneOnly: false,
    requireApiConfirmBeforeSingleClaim: true,
    summaryOnly: true,
  };
}

/**
 * Phase 106：手機全域查單是否跳過本地索引／cache 早退。
 * 僅在「全部／所有訂單」等明確要看完整列表時 bypass（本地可能未覆蓋全部）；其餘一律先 local。
 */
export function shouldBypassLocalPhoneIndex(
  userMessage: string,
  recentMessages: string[],
  activeCtx: OrderLookupPolicyContext | null | undefined
): boolean {
  const intent = deriveOrderLookupIntent(userMessage, recentMessages, activeCtx);
  if (intent.kind === "phone_all_orders") return true;
  return false;
}

/** 是否允許僅用手機直接查（不補問商品） */
export function shouldAllowPhoneOnlyDirectLookup(intent: OrderLookupIntent): boolean {
  return intent.allowPhoneOnly;
}

/** 是否要求先有商品關鍵字才查 */
export function shouldRequireProductForLookup(intent: OrderLookupIntent): boolean {
  return intent.requiresProduct;
}

/** 單筆結果是否需先 live API 確認才能當最終答案（local_only 單筆時由 call 方設為 true） */
export function shouldRequireApiConfirmBeforeSingleClaim(
  intent: OrderLookupIntent,
  dataCoverage: "local_only" | "api_only" | "merged_local_api" | undefined,
  orderCount: number
): boolean {
  if (orderCount !== 1) return false;
  if (dataCoverage === "api_only" || dataCoverage === "merged_local_api") return false;
  if (dataCoverage === "local_only") return true;
  return intent.requireApiConfirmBeforeSingleClaim;
}

/**
 * Phase 33 Ticket 33-2：是否允許依手機直接查（不先補問商品）。
 * 單號、商品+手機、明確「全部訂單」類、官網/一頁+手機 → true；純手機且意圖不明 → false。
 */
export function shouldDirectLookupByPhone(
  userMessage: string,
  recentMessages: string[],
  activeCtx: OrderLookupPolicyContext | null | undefined
): boolean {
  const intent = deriveOrderLookupIntent(userMessage, recentMessages, activeCtx);
  if (intent.kind === "order_id_direct") return true;
  if (intent.kind === "phone_all_orders") return true;
  if (intent.kind === "product_phone_rescue") return true;
  return shouldAllowPhoneOnlyDirectLookup(intent);
}
