/**
 * Post-generation content guard：送出前違規掃描。
 * - 品類不符：product_scope 非甜點時，回覆不得出現甜點相關
 * - mode 禁語：handoff / return / cancel / order_lookup 時不得出現賣點、行銷、推薦、價格組合
 * 違規時回傳 { pass: false, cleaned }，由 caller 決定重生或送 cleaned/fallback。
 */
import type { ReplyPlanMode } from "./reply-plan-builder";

/** 非甜點品類時，回覆不得出現的詞（甜點專屬知識／補充） */
/** @deprecated Phase 1.5: 品類檢查改由品牌設定驅動 */
const SWEET_ONLY_SOURCE = "";

/** 退貨／取消／handoff／order_lookup 模式下禁止：賣點、行銷、推薦、價格組合、主動銷售 */
const MODE_FORBIDDEN_PROMO_SOURCE = "高密度|泡附著|熱銷|超值|優惠組合|規格組合|不同價格|推薦購買|推薦您|推薦|建議您.*買|其實.*很好用|促購|行銷|賣點|限時優惠|組合價|特價|折扣.*%|買.*送|加購|考慮留下";

/** 適用「禁止賣點/推薦」的 mode */
const MODES_NO_PROMO: ReplyPlanMode[] = [
  "handoff",
  "return_form_first",
  "aftersales_comfort_first",
  "return_stage_1",
  "order_lookup",
  "order_followup",
];

export interface GuardResult {
  pass: boolean;
  cleaned: string;
  reason?: string;
}

/**
 * 送出前掃描：品類不符或 mode 禁語命中則不通過，並產出清洗後文案（移除違規句或整段）。
 */
export function runPostGenerationGuard(
  reply: string,
  planMode: ReplyPlanMode,
  _productScope: string | null
): GuardResult {
  const text = (reply || "").trim();
  if (!text) return { pass: true, cleaned: reply };

  if (isModeNoPromo(planMode)) {
    const promoRe =
      /推薦您|推薦購買|建議您.*買|超值|優惠組合|限時優惠|組合價|特價|折扣.*%|買.*送|加購|考慮留下|促購/;
    if (promoRe.test(text)) {
      const cleaned = text.replace(promoRe, "").replace(/\s{2,}/g, " ").trim();
      return { pass: false, cleaned: cleaned || text, reason: "mode_no_promo" };
    }
  }

  return { pass: true, cleaned: text };
}

/** 是否為「禁止賣點/推薦」的 mode */
export function isModeNoPromo(mode: ReplyPlanMode): boolean {
  return MODES_NO_PROMO.includes(mode);
}

/** 僅保留常數供其他模組或文件參考；Phase 1.5 已不再用於攔截。 */
export const PLATFORM_FORBIDDEN_PATTERNS = [
  "其他平台",
  "該平台",
  "官方通路",
  "非官方",
  "若是其他平台購買",
  "建議向該平台客服確認",
  "不是我們這邊的單",
];

/** 攔截「其他平台」「不是我們的單」等推責話術；命中時移除含禁語的整句，保留其餘。 */
export function runGlobalPlatformGuard(reply: string): GuardResult {
  const text = (reply || "").trim();
  if (!text) return { pass: true, cleaned: text || reply };

  for (const pattern of PLATFORM_FORBIDDEN_PATTERNS) {
    if (text.includes(pattern)) {
      const sentences = text.split(/(?<=[。！\n])/);
      const cleaned = sentences
        .filter((s) => !PLATFORM_FORBIDDEN_PATTERNS.some((p) => s.includes(p)))
        .join("")
        .trim();
      return {
        pass: false,
        cleaned: cleaned || text,
        reason: "global_platform_forbidden",
      };
    }
  }
  return { pass: true, cleaned: text };
}

const OFFICIAL_CHANNEL_FORBIDDEN_PHRASES = [
  "是否在官網下單",
  "是否官方下單",
  "是在官網",
  "是否為官方",
  "請問是在哪個通路",
  "您是在哪裡下單",
];

/**
 * 官方渠道（LINE 官方帳號等）回覆不得出現「是否在官網下單」等多餘反問；命中則移除該句。
 */
export function runOfficialChannelGuard(reply: string): GuardResult {
  const text = (reply || "").trim();
  if (!text) return { pass: true, cleaned: text || reply };

  for (const phrase of OFFICIAL_CHANNEL_FORBIDDEN_PHRASES) {
    if (text.includes(phrase)) {
      const sentences = text.split(/(?<=[。！？\n])/);
      const cleaned = sentences
        .filter((s) => !OFFICIAL_CHANNEL_FORBIDDEN_PHRASES.some((p) => s.includes(p)))
        .join("")
        .trim();
      return {
        pass: false,
        cleaned: cleaned || text,
        reason: "official_channel_forbidden",
      };
    }
  }
  return { pass: true, cleaned: text };
}
