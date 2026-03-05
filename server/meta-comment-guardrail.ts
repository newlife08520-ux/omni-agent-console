/**
 * Deterministic rule-based guardrail：在 AI 分類前先擋下客訴/退款/爆氣/催單/品質抱怨，
 * 一律視為高風險，只產安撫第一則、不產第二則導購。
 * 另：平台／詐騙／待確認來源 → 使用共用判定（safe-after-sale-classifier），不先承認責任。
 */

import {
  PLATFORM_KEYWORDS,
  FRAUD_IMPERSONATION_KEYWORDS,
  classifyMessageForSafeAfterSale as classifyForSafeAfterSale,
  type SafeConfirmType,
  type SafeConfirmResult,
  type SafeConfirmNoMatch,
} from "./safe-after-sale-classifier";

export { PLATFORM_KEYWORDS, FRAUD_IMPERSONATION_KEYWORDS };
export type { SafeConfirmType, SafeConfirmResult, SafeConfirmNoMatch };

/** 退款/退貨類（積極涵蓋售後爭議） */
const REFUND_KEYWORDS = [
  "退款", "退貨", "取消訂單", "不要了", "申請退款", "我要退", "退費",
  "退錢", "不想要了", "拒收", "退訂", "取消",
];

/** 客訴/抱怨類（負面、爭議、敏感都納入；不含詐騙等已抽到 FRAUD_IMPERSONATION_KEYWORDS） */
const COMPLAINT_KEYWORDS = [
  "客訴", "投訴", "抱怨", "很爛", "爛透", "差勁", "失望", "生氣", "不爽",
  "傻眼", "誇張", "黑店", "負評", "雷", "地雷",
  "不推薦", "後悔", "浪費錢", "誇大", "不實",
];

/** 售後未處理/物流延遲/客服抱怨類 */
const DELIVERY_KEYWORDS = [
  "還沒收到", "沒收到", "一直沒到", "到底什麼時候到", "催單", "延遲",
  "沒出貨", "未出貨", "不回訊息", "都不回", "沒人理", "沒處理",
  "客服", "找不到人", "聯絡不上", "沒接電話", "已讀不回", "不讀不回",
  "出貨", "寄出", "物流", "配送", "遲到", "漏寄",
];

/** 商品問題/品質類 */
const QUALITY_KEYWORDS = [
  "壞掉", "有問題", "瑕疵", "漏液", "破掉", "效果很差", "太差", "過敏",
  "不舒服", "刺激", "出問題", "品質", "劣質", "損壞", "變質",
];

const ALL_KEYWORDS: { keyword: string; intent: "refund_after_sale" | "complaint" }[] = [];
for (const k of REFUND_KEYWORDS) {
  ALL_KEYWORDS.push({ keyword: k, intent: "refund_after_sale" });
}
for (const k of COMPLAINT_KEYWORDS) {
  ALL_KEYWORDS.push({ keyword: k, intent: "complaint" });
}
for (const k of DELIVERY_KEYWORDS) {
  ALL_KEYWORDS.push({ keyword: k, intent: "refund_after_sale" });
}
for (const k of QUALITY_KEYWORDS) {
  ALL_KEYWORDS.push({ keyword: k, intent: "complaint" });
}

/** 規則命中時使用的安撫文案（固定，不依賴 AI） */
const COMFORT_MESSAGE =
  "感謝您的留言，我們非常重視您的意見。已為您轉由專人處理，請私訊我們提供訂單或詳細狀況，我們會盡快協助您。";

export interface GuardrailResult {
  matched: true;
  keyword: string;
  intent: "complaint" | "refund_after_sale";
  suggest_hide: boolean;
  suggest_human: true;
}
export interface GuardrailNoMatch {
  matched: false;
}

/** 留言通道用：呼叫共用判定，保持原 API 供 auto-execute / suggest-reply 使用 */
export function checkSafeConfirmByRule(message: string): SafeConfirmResult | SafeConfirmNoMatch {
  return classifyForSafeAfterSale(message);
}

/**
 * 若留言內容命中任一高風險關鍵字，直接視為客訴/退款，不交給 AI 決定是否導購。
 * 回傳第一個命中的關鍵字與對應 intent。
 */
export function checkHighRiskByRule(message: string): GuardrailResult | GuardrailNoMatch {
  if (!message || typeof message !== "string") return { matched: false };
  const text = message.trim();
  if (!text) return { matched: false };
  for (const { keyword, intent } of ALL_KEYWORDS) {
    if (text.includes(keyword)) {
      return {
        matched: true,
        keyword,
        intent,
        suggest_hide: true,
        suggest_human: true,
      };
    }
  }
  return { matched: false };
}

/** 建議導 LINE（一對一協助）關鍵字：命中則不交給 AI，直接走 line_redirect */
const LINE_REDIRECT_KEYWORDS = [
  "適合我",
  "推薦我",
  "幫我推薦",
  "更詳細",
  "想了解更詳細",
  "幫我挑",
  "哪款比較",
  "不知道怎麼選",
];

export interface LineRedirectRuleResult {
  matched: true;
  keyword: string;
}
export interface LineRedirectRuleNoMatch {
  matched: false;
}

/**
 * 若留言內容命中「建議導 LINE」關鍵字，直接視為 dm_guide，穩定走簡答+導 LINE，不交給 AI。
 */
export function checkLineRedirectByRule(message: string): LineRedirectRuleResult | LineRedirectRuleNoMatch {
  if (!message || typeof message !== "string") return { matched: false };
  const text = message.trim();
  if (!text) return { matched: false };
  for (const keyword of LINE_REDIRECT_KEYWORDS) {
    if (text.includes(keyword)) {
      return { matched: true, keyword };
    }
  }
  return { matched: false };
}

export { COMFORT_MESSAGE };
