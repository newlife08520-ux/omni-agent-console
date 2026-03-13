/**
 * Post-generation content guard：送出前違規掃描。
 * - 品類不符：product_scope 非甜點時，回覆不得出現甜點相關
 * - mode 禁語：handoff / return / cancel / order_lookup 時不得出現賣點、行銷、推薦、價格組合
 * 違規時回傳 { pass: false, cleaned }，由 caller 決定重生或送 cleaned/fallback。
 */
import type { ReplyPlanMode } from "./reply-plan-builder";

/** 非甜點品類時，回覆不得出現的詞（甜點專屬知識／補充） */
const SWEET_ONLY_SOURCE = "甜點|巴斯克|蛋糕|餅乾|甜點較快|甜點通常|甜點類.*出貨|3\\s*天內出貨";

/** 退貨／取消／handoff／order_lookup 模式下禁止：賣點、行銷、推薦、價格組合、主動銷售 */
const MODE_FORBIDDEN_PROMO_SOURCE = "高密度|泡附著|熱銷|超值|優惠組合|規格組合|不同價格|推薦購買|推薦您|推薦|建議您.*買|其實.*很好用|促購|行銷|賣點|限時優惠|組合價|特價|折扣.*%|買.*送|加購|考慮留下";

/** 適用「禁止賣點/推薦」的 mode */
const MODES_NO_PROMO: ReplyPlanMode[] = [
  "handoff",
  "return_form_first",
  "aftersales_comfort_first",
  "return_stage_1",
  "order_lookup",
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
  productScope: string | null
): GuardResult {
  let text = (reply || "").trim();
  if (!text) return { pass: true, cleaned: text };

  const reasons: string[] = [];

  // 品類不符：scope 非 sweet 時不得出現甜點專屬
  if (productScope && productScope !== "sweet") {
    const sweetRe = new RegExp(SWEET_ONLY_SOURCE, "gi");
    if (sweetRe.test(text)) {
      reasons.push("category_mismatch_sweet");
      text = text.replace(new RegExp(SWEET_ONLY_SOURCE, "gi"), "").replace(/\n{2,}/g, "\n").trim();
    }
  }

  // mode 禁語：退貨/取消/handoff/order_lookup 不得出現賣點、推薦、價格組合
  if (MODES_NO_PROMO.includes(planMode)) {
    const promoRe = new RegExp(MODE_FORBIDDEN_PROMO_SOURCE, "gi");
    if (promoRe.test(text)) {
      reasons.push("mode_forbidden_promo");
      text = text.replace(new RegExp(MODE_FORBIDDEN_PROMO_SOURCE, "gi"), "").replace(/\n{2,}/g, "\n").trim();
    }
  }

  const pass = reasons.length === 0;
  const cleaned = text.replace(/\n{2,}/g, "\n").trim();
  return {
    pass,
    cleaned: cleaned || reply,
    reason: reasons.length ? reasons.join(";") : undefined,
  };
}

/** 是否為「禁止賣點/推薦」的 mode */
export function isModeNoPromo(mode: ReplyPlanMode): boolean {
  return MODES_NO_PROMO.includes(mode);
}

/** 官方渠道時回覆不得出現：是否官方下單、其他平台購買等句型（post-generation hard guard） */
const OFFICIAL_CHANNEL_FORBIDDEN_SOURCE = "是否官方下單|若是其他平台|其他平台購買|官方通路下單|該平台客服|該平台|建議找該平台|若非官方|不是我們這邊的單";

/**
 * 全域禁止平台來源話術（Hotfix）：不分 mode、不分渠道，送出前一律檢查。
 * 命中任一句型即不通過，清洗或替換後再送出。
 */
export const PLATFORM_FORBIDDEN_PATTERNS = [
  "其他平台",
  "該平台",
  "官方通路",
  "非官方",
  "若是其他平台購買",
  "建議向該平台客服確認",
  "不是我們這邊的單",
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildGlobalPlatformForbiddenRe(): RegExp {
  return new RegExp(PLATFORM_FORBIDDEN_PATTERNS.map(escapeRe).join("|"), "gi");
}

/**
 * 發送前 hard guard：回覆不得包含任何「其他平台／該平台／官方通路」等句型。全域適用，不分 mode。
 */
export function runGlobalPlatformGuard(reply: string): GuardResult {
  const text = (reply || "").trim();
  if (!text) return { pass: true, cleaned: text };
  const re = buildGlobalPlatformForbiddenRe();
  if (!re.test(text)) return { pass: true, cleaned: text };
  let cleaned = text;
  for (const p of PLATFORM_FORBIDDEN_PATTERNS) {
    const re = new RegExp(escapeRe(p) + "[^。！？\n]*[。！？]?", "gi");
    cleaned = cleaned.replace(re, "").replace(/\n{2,}/g, "\n").trim();
  }
  if (!cleaned) cleaned = "了解，這邊幫您處理，請稍候。";
  return { pass: false, cleaned, reason: "global_platform_forbidden" };
}

/**
 * 若 current contact 已知為官方渠道，回覆不得出現「是否官方下單」「若是其他平台購買」等。
 * 命中則清洗後回傳 { pass: false, cleaned }。
 */
export function runOfficialChannelGuard(reply: string): GuardResult {
  const text = (reply || "").trim();
  if (!text) return { pass: true, cleaned: text };
  const re = new RegExp(OFFICIAL_CHANNEL_FORBIDDEN_SOURCE, "gi");
  if (!re.test(text)) return { pass: true, cleaned: text };
  const cleaned = text.replace(new RegExp(OFFICIAL_CHANNEL_FORBIDDEN_SOURCE, "gi"), "").replace(/\n{2,}/g, "\n").trim();
  return {
    pass: false,
    cleaned: cleaned || reply,
    reason: "official_channel_forbidden",
  };
}
