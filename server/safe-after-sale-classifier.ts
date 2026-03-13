/**
 * 共用判定邏輯：非本店／他平台／待確認訂單來源／詐騙冒用。
 * 供「公開留言」與「私訊（Facebook/IG 等）」共用，避免兩套邏輯分叉。
 * 使用層：comment guardrail、comment auto-execute、suggest-reply、contact/DM 處理。
 */

/** 粉專未設定售後 LINE 時，模板內 {after_sale_line_url} 的 fallback 文案（不輸出空連結） */
export const FALLBACK_AFTER_SALE_LINE_LABEL = "請私訊官方 LINE（由客服提供）";

/** 圖片型私訊：不亂猜、不亂承諾，先縮小問題、先蒐集有效資訊。 */

/** 1. 圖片型私訊通用補充版（僅圖片無文字，或圖片＋極短／模糊文字時） */
export const IMAGE_DM_GENERIC =
  "已收到您的圖片～想快點幫您處理，需要再跟您確認幾件事：\n\n" +
  "① 目前是屬於哪一類呢？\n・訂單查詢／出貨物流\n・商品問題（瑕疵、過敏等）\n・付款問題\n・疑似詐騙／假客服\n\n" +
  "② 若方便的話，可以補充：訂單編號、商品名稱、或下單手機，我們會依您提供的資訊盡快協助。";

/** 2. 圖片型私訊疑似訂單／物流畫面 */
export const IMAGE_DM_ORDER_SHIPPING =
  "收到您的圖片了～看起來可能跟訂單或出貨有關。\n\n" +
  "為免搞錯，再跟您確認：請補充「訂單編號」或「下單手機」，以及您目前遇到的狀況（例如：還沒出貨、查不到物流等），我們會依資訊幫您查。";

/** 3. 圖片型私訊疑似詐騙／付款截圖 */
export const IMAGE_DM_FRAUD_PAYMENT =
  "收到您的圖片了，若涉及詐騙或付款問題我們會謹慎處理。\n\n" +
  "請補充：這是哪一種情況（例如：被要求轉帳、假客服、付款後沒下文），若有對話截圖或對方帳號也可以一併說明，我們會依您提供的資訊協助釐清、不先下結論。";

/** 4. 圖片型私訊商品問題／瑕疵／過敏 */
export const IMAGE_DM_PRODUCT_ISSUE =
  "收到您的圖片了～若與商品使用、瑕疵或過敏有關，我們想先了解狀況。\n\n" +
  "請補充：訂單編號或商品名稱，以及目前狀況（例如：擦了過敏、有瑕疵），我們會依資訊協助後續。";

/** 僅圖片、無文字時沿用通用版（與原 SAFE_IMAGE_ONLY_REPLY 語意一致，改為上述通用補充版） */
export const SAFE_IMAGE_ONLY_REPLY = IMAGE_DM_GENERIC;

/**
 * Vision-first 低信心時才用：只問 1 個最關鍵問題，不要四選一問卷。
 * 用於圖片意圖判讀為 unreadable 或 confidence 為 low 時。
 */
export const SHORT_IMAGE_FALLBACK =
  "收到圖了～可以簡單說一下這張圖是關於「訂單/出貨」、「商品問題」還是其他嗎？一句就好，我才能對應處理。";

/** 圖片＋極短／模糊文字：視為尚未確認情境，不直接進一般售後承諾 */
const SHORT_OR_AMBIGUOUS_PHRASES = [
  "幫我看", "幫我看看", "看一下", "你看一下", "這個怎麼辦", "怎麼辦", "這什麼", "是不是被騙", "被騙", "你看", "這個", "幫幫我",
];
const SHORT_CAPTION_MAX_LEN = 20;

export function isShortOrAmbiguousImageCaption(text: string): boolean {
  if (!text || typeof text !== "string") return true;
  const t = text.trim();
  if (t.length <= SHORT_CAPTION_MAX_LEN) return true;
  return SHORT_OR_AMBIGUOUS_PHRASES.some((p) => t.includes(p));
}

/** 圖片型補充模板名稱（供 log 追蹤） */
export type ImageDmTemplateName = "IMAGE_DM_GENERIC" | "IMAGE_DM_ORDER_SHIPPING" | "IMAGE_DM_FRAUD_PAYMENT" | "IMAGE_DM_PRODUCT_ISSUE";

/** 依圖片＋短文字的關鍵字 hint 選一則補充模板（不猜責任，只引導補資訊） */
export function getImageDmReplyForShortCaption(text: string): string {
  const { text: out } = getImageDmReplyAndTemplateForShortCaption(text);
  return out;
}

/** 回傳補充模板內文與模板名稱（供 log） */
export function getImageDmReplyAndTemplateForShortCaption(text: string): { text: string; templateName: ImageDmTemplateName } {
  if (!text || typeof text !== "string") return { text: IMAGE_DM_GENERIC, templateName: "IMAGE_DM_GENERIC" };
  const t = text.trim();
  if (/詐騙|被騙|假客服|轉帳|匯款|騙/.test(t)) return { text: IMAGE_DM_FRAUD_PAYMENT, templateName: "IMAGE_DM_FRAUD_PAYMENT" };
  if (/訂單|出貨|物流|還沒到|漏寄|查詢/.test(t)) return { text: IMAGE_DM_ORDER_SHIPPING, templateName: "IMAGE_DM_ORDER_SHIPPING" };
  if (/過敏|瑕疵|商品|壞掉|有問題|擦了/.test(t)) return { text: IMAGE_DM_PRODUCT_ISSUE, templateName: "IMAGE_DM_PRODUCT_ISSUE" };
  return { text: IMAGE_DM_GENERIC, templateName: "IMAGE_DM_GENERIC" };
}

/** 連續 N 次仍為圖片補充回覆時升級人工（避免無限循環補問） */
export const IMAGE_SUPPLEMENT_ESCALATE_THRESHOLD = 2;

/** 判斷近期 AI 回覆中有幾則為「圖片型補充模板」內容（含舊版問卷與 vision 縮短 fallback） */
export function countRecentImageSupplementReplies(messages: { sender_type: string; content?: string }[]): number {
  const ai = messages.filter((m) => m.sender_type === "ai");
  const recent = ai.slice(-6);
  return recent.filter((m) => {
    const c = (m.content || "").trim();
    return c.startsWith("已收到您的圖片") || c.startsWith("收到您的圖片了") || c.startsWith("收到圖了～");
  }).length;
}

export function shouldEscalateImageSupplement(messages: { sender_type: string; content?: string }[]): boolean {
  return countRecentImageSupplementReplies(messages) >= IMAGE_SUPPLEMENT_ESCALATE_THRESHOLD;
}

/** 連續無效補充時轉人工的固定文案 */
export const IMAGE_SUPPLEMENT_ESCALATE_MESSAGE = "已為您轉接專人檢視，請稍候。";

/** 回傳套用的模板名稱（供 log；與 getImageDmReplyAndTemplateForShortCaption 一致） */
export function getImageDmTemplateNameForShortCaption(text: string): ImageDmTemplateName {
  return getImageDmReplyAndTemplateForShortCaption(text).templateName;
}

/** 平台關鍵字：命中時視為他平台訂單或待確認來源 */
export const PLATFORM_KEYWORDS = [
  "蝦皮", "淘寶", "momo", "pchome", "露天", "yahoo購物", "yahoo", "amazon", "博客來", "東森", "康是美", "屈臣氏",
];

/** 詐騙／冒用：僅在出現明確風險訊號時觸發。不可僅因「連結」「帳號」「購買」就誤觸。 */
export const FRAUD_RISK_SIGNAL_KEYWORDS = [
  "私人帳號", "匯款", "轉帳", "驗證碼", "假客服", "冒用", "詐騙", "可疑收款", "被騙", "盜用", "假官方", "騙錢", "詐欺", "付款後沒下文",
];
/** @deprecated 改用 FRAUD_RISK_SIGNAL_KEYWORDS；保留名稱以相容呼叫端，實際比對改為僅風險訊號 */
export const FRAUD_IMPERSONATION_KEYWORDS = FRAUD_RISK_SIGNAL_KEYWORDS;

/** 訂單／售後相關但來源不明時，先安全確認。須無「本店」提示才觸發 */
export const ORDER_SOURCE_AMBIGUOUS_KEYWORDS = [
  "訂單", "退款", "退貨", "沒收到", "漏寄", "改地址", "發票", "扣款", "品質", "瑕疵", "過敏", "客服不回",
];

/** 本店提示：留言含任一時，不觸發「訂單來源不明」待確認 */
export const OUR_STORE_HINTS = ["官網", "官方", "官網下單", "官方通路", "你們家", "你們官網"];

export type SafeConfirmType = "fraud_impersonation" | "external_platform" | "safe_confirm_order";

export interface SafeConfirmResult {
  matched: true;
  keyword: string;
  type: SafeConfirmType;
  suggest_hide: boolean;
  suggest_human: boolean;
}

export interface SafeConfirmNoMatch {
  matched: false;
}

/**
 * 共用判定：是否為「非本店／他平台／待確認來源／詐騙冒用」。
 * 優先順序：詐騙冒用 > 平台關鍵字 > 訂單來源不明（且無本店提示）。
 * 留言與私訊皆呼叫此函式，再依通道決定行為（留言：模板+隱藏+導 LINE；私訊：模板回覆+視情況轉人工）。
 */
export function classifyMessageForSafeAfterSale(message: string): SafeConfirmResult | SafeConfirmNoMatch {
  if (!message || typeof message !== "string") return { matched: false };
  const text = message.trim();
  if (!text) return { matched: false };

  for (const keyword of FRAUD_RISK_SIGNAL_KEYWORDS) {
    if (text.includes(keyword)) {
      return {
        matched: true,
        keyword,
        type: "fraud_impersonation",
        suggest_hide: true,
        suggest_human: true,
      };
    }
  }
  for (const keyword of PLATFORM_KEYWORDS) {
    if (text.includes(keyword)) {
      return {
        matched: true,
        keyword,
        type: "external_platform",
        suggest_hide: false,
        suggest_human: false,
      };
    }
  }
  const hasOurStoreHint = OUR_STORE_HINTS.some((h) => text.includes(h));
  if (!hasOurStoreHint) {
    for (const keyword of ORDER_SOURCE_AMBIGUOUS_KEYWORDS) {
      if (text.includes(keyword)) {
        return {
          matched: true,
          keyword,
          type: "safe_confirm_order",
          suggest_hide: false,
          suggest_human: false,
        };
      }
    }
  }
  return { matched: false };
}
