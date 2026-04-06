# 10 - 轉人工 + 安全防護（handoff.ts + phase2-output.ts + content-guard.ts + sop-compliance-guard.ts）

轉人工邏輯、對客固定文案、內容防護、出貨 SOP 合規。

請審查：
- 轉人工時對客有沒有回話
- 固定文案是否像真人
- 出貨 SOP 前綴是否自然

---

## server/services/handoff.ts

```typescript
/**
 * 統一 handoff（轉人工）入口，避免人格與多處散落改狀態互相打架。
 * reason 必須為 canonical enum；自由文字存 reason_detail。idempotent 不重複改狀態，但新事件仍留 audit。
 */

import { storage } from "../storage";

export type HandoffReason =
  | "explicit_human_request"
  | "legal_or_reputation_threat"
  | "payment_or_order_risk"
  | "policy_exception"
  | "repeat_unresolved"
  | "return_stage_3_insist"
  | "timeout_escalation"
  | "high_risk_short_circuit"
  | "awkward_repeat"
  | "post_reply_handoff";

const CANONICAL_REASONS: HandoffReason[] = [
  "explicit_human_request",
  "legal_or_reputation_threat",
  "payment_or_order_risk",
  "policy_exception",
  "repeat_unresolved",
  "return_stage_3_insist",
  "timeout_escalation",
  "high_risk_short_circuit",
  "awkward_repeat",
  "post_reply_handoff",
];

/** 自由文字對應到 canonical reason 的關鍵字（小寫比對） */
const REASON_KEYWORDS: { kw: string[]; reason: HandoffReason }[] = [
  { kw: ["high_risk", "high risk", "legal", "風險", "法務"], reason: "high_risk_short_circuit" },
  { kw: ["timeout", "逾時", "超時"], reason: "timeout_escalation" },
  { kw: ["awkward", "重複", "repeat"], reason: "awkward_repeat" },
  { kw: ["return_stage", "退換貨", "堅持退"], reason: "return_stage_3_insist" },
  { kw: ["explicit", "人工", "真人", "轉人工", "keyword"], reason: "explicit_human_request" },
  { kw: ["policy", "safe_confirm", "safe confirm"], reason: "policy_exception" },
  { kw: ["repeat_unresolved", "already_provided", "查無"], reason: "repeat_unresolved" },
  { kw: ["post_reply", "image_escalate", "video"], reason: "post_reply_handoff" },
];

export interface NormalizedHandoffReason {
  reason: HandoffReason;
  reason_detail?: string;
}

/**
 * 將自由文字轉成 canonical reason + 可選 reason_detail（原文字截短安全存）。
 */
export function normalizeHandoffReason(rawReason: string | null | undefined): NormalizedHandoffReason {
  const raw = (rawReason ?? "").trim();
  if (!raw) {
    return { reason: "explicit_human_request", reason_detail: undefined };
  }
  const lower = raw.toLowerCase();
  const alreadyCanonical = CANONICAL_REASONS.find((r) => r === lower || r === raw);
  if (alreadyCanonical) {
    return { reason: alreadyCanonical, reason_detail: undefined };
  }
  for (const { kw, reason } of REASON_KEYWORDS) {
    if (kw.some((k) => lower.includes(k))) {
      const detail = raw.length > 200 ? raw.slice(0, 200) + "…" : raw;
      return { reason, reason_detail: detail };
    }
  }
  const detail = raw.length > 200 ? raw.slice(0, 200) + "…" : raw;
  return { reason: "explicit_human_request", reason_detail: detail };
}

export interface ApplyHandoffParams {
  contactId: number;
  /** 僅接受 canonical HandoffReason */
  reason: HandoffReason;
  /** 自由文字另存，不污染 reason enum */
  reason_detail?: string;
  source: string;
  platform?: string;
  createCaseNotification?: boolean;
  markNeedsAssignment?: boolean;
  brandId?: number;
  statusOverride?: "awaiting_human" | "high_risk";
}

function writeTransferAlert(payload: {
  contactId: number;
  source: string;
  reason: HandoffReason;
  reason_detail?: string;
  brandId?: number;
  previous_status?: string;
  next_status: string;
}): void {
  const details = JSON.stringify({
    source: payload.source,
    reason: payload.reason,
    reason_detail: payload.reason_detail ?? null,
    contact_id: payload.contactId,
    previous_status: payload.previous_status ?? null,
    next_status: payload.next_status,
  });
  storage.createSystemAlert({
    alert_type: "transfer",
    details,
    contact_id: payload.contactId,
    brand_id: payload.brandId,
  });
}

/**
 * 單一真實入口：套用轉人工狀態與副作用，並寫入固定格式 alert（JSON）。
 * Idempotent：已在 handoff 時不重複改狀態，但**仍寫入新 alert**；若新 reason 為 high_risk_short_circuit 則允許升級為 high_risk。
 */
export function applyHandoff(params: ApplyHandoffParams): boolean {
  const {
    contactId,
    reason,
    reason_detail,
    source,
    createCaseNotification = true,
    brandId,
    statusOverride,
  } = params;

  const contact = storage.getContact(contactId);
  if (!contact) {
    console.warn(`[Handoff] contact ${contactId} not found, skip`);
    return false;
  }

  const effectiveBrandId = brandId ?? contact.brand_id ?? undefined;
  const targetStatus = statusOverride ?? "awaiting_human";
  const alreadyHandoff = (contact.status === "awaiting_human" || contact.status === "high_risk") && contact.needs_human === 1;
  const allowUpgrade = alreadyHandoff && reason === "high_risk_short_circuit" && contact.status !== "high_risk";

  if (alreadyHandoff && !allowUpgrade) {
    console.log(`[Handoff] contact ${contactId} already handoff (${contact.status}), skip state update; still recording event (source=${source}, reason=${reason})`);
    writeTransferAlert({
      contactId,
      source,
      reason,
      reason_detail,
      brandId: effectiveBrandId,
      previous_status: contact.status,
      next_status: contact.status,
    });
    return false;
  }

  if (allowUpgrade) {
    storage.updateContactStatus(contactId, "high_risk");
    storage.updateContactHumanFlag(contactId, 1);
    storage.updateContactAssignmentStatus(contactId, "waiting_human");
    if (createCaseNotification !== false) storage.createCaseNotification(contactId, "in_app");
    writeTransferAlert({
      contactId,
      source,
      reason,
      reason_detail,
      brandId: effectiveBrandId,
      previous_status: contact.status,
      next_status: "high_risk",
    });
    console.log(`[Handoff] contact ${contactId} upgraded to high_risk reason=${reason} source=${source}`);
    return true;
  }

  storage.updateContactStatus(contactId, targetStatus);
  storage.updateContactHumanFlag(contactId, 1);
  storage.updateContactAssignmentStatus(contactId, "waiting_human");
  if (createCaseNotification !== false) {
    storage.createCaseNotification(contactId, "in_app");
  }
  writeTransferAlert({
    contactId,
    source,
    reason,
    reason_detail,
    brandId: effectiveBrandId,
    previous_status: contact.status,
    next_status: targetStatus,
  });
  console.log(`[Handoff] contact ${contactId} reason=${reason} source=${source}`);
  return true;
}
```

## server/phase2-output.ts

```typescript
/**
 * Phase 2 輸出常數與 output guard，供 routes 與 phase2-verify 共用，確保文案驗收與實際送出一致。
 */
import { storage } from "./storage";

/**
 * 品牌覆寫查詢：若品牌 phase1_agent_ops_json 內有 message_overrides，優先使用。
 * 沒有覆寫則回 fallback（即原本的硬編碼文案）。
 */
export function brandMessage(brandId: number | undefined, key: string, fallback: string): string {
  if (!brandId) return fallback;
  try {
    const brand = storage.getBrand(brandId);
    if (!brand?.phase1_agent_ops_json) return fallback;
    const json = JSON.parse(brand.phase1_agent_ops_json);
    const overrides = json?.message_overrides;
    if (overrides && typeof overrides[key] === "string" && overrides[key].trim()) {
      return overrides[key].trim();
    }
  } catch {
    /* ignore invalid JSON */
  }
  return fallback;
}

/** Phase 2 off_topic_guard：品牌外問題短句收邊界；不得推薦菜單／餐廳 */
export const OFF_TOPIC_GUARD_MESSAGE =
  "這部分比較不是我們服務範圍，若有商品或訂單相關問題，隨時跟我說，我來幫您處理。";

/**
 * Handoff 強制告知句（程式層保證）：只要進入轉接真人流程，回覆第一句必須明確告知「已轉接真人專員」。
 * 語意等價：「這邊先幫您轉接真人專員處理，請稍後。」／「我先為您轉接真人專員協助處理，麻煩您稍候一下。」
 */
export const HANDOFF_MANDATORY_OPENING = "這邊先幫您轉接真人專員處理，請稍後。";

/** Handoff 時僅在「明確查單且缺關鍵資料」時可補一句（Hotfix：handoff ≠ order_lookup） */
export const HANDOFF_OPTIONAL_ORDER_HINT = "若方便，也可先提供訂單編號，專員會更快協助您確認。";

/** 轉人工時若為午休／下班／非客服時段，程式層硬規則：必須在回覆中明確告知客戶（不依賴 prompt） */
export const HANDOFF_OFF_HOURS_SUFFIX = "目前人工客服不在線，之後才會由真人客服回覆。";

/** 全員忙碌／暫停時也需告知客戶，避免誤以為有人正在看 */
export const HANDOFF_ALL_PAUSED_SUFFIX = "目前客服暫時無法即時回覆，您的需求已記錄，會盡快由專人處理。";

/** 週休二日：專屬文案，避免週末被誤判為午休或全員忙碌 */
export const HANDOFF_WEEKEND_SUFFIX = "目前為假日非服務時間，您的需求已記錄，我們將於下個工作日為您處理，請稍候。";

/**
 * 依是否為非客服時段，回傳要送給客戶的完整 handoff 文案（程式層硬規則）。
 * 週末：加「目前為假日非服務時間…下個工作日為您處理。」
 * 午休或下班時：加「目前人工客服不在線，之後才會由真人客服回覆。」
 * 全員忙碌／暫停時：加「目前客服暫時無法即時回覆…」
 */
export function getHandoffReplyForCustomer(
  baseReply: string,
  unavailableReason: "weekend" | "lunch" | "after_hours" | "all_paused" | null
): string {
  if (unavailableReason === "weekend") {
    return baseReply + "\n" + HANDOFF_WEEKEND_SUFFIX;
  }
  if (unavailableReason === "lunch" || unavailableReason === "after_hours") {
    return baseReply + "\n" + HANDOFF_OFF_HOURS_SUFFIX;
  }
  if (unavailableReason === "all_paused") {
    return baseReply + "\n" + HANDOFF_ALL_PAUSED_SUFFIX;
  }
  return baseReply;
}

/**
 * 組裝 handoff 回覆：第一句必為固定告知句。
 * 第二句（訂單提示）僅當：已明確是查單/訂單處理、且真的缺關鍵資料、且非情緒差。
 * 純「人呢」「我要轉人工」等不得補訂單提示。
 */
export function buildHandoffReply(options: {
  customerEmotion?: string;
  humanReason?: string | null;
  /** 同一句或本輪是否明確提到查單/訂單/出貨；僅此時才允許補訂單提示 */
  isOrderLookupContext?: boolean;
  /** 是否已有訂單編號或產品名稱+手機；有則不補訂單提示 */
  hasOrderInfo?: boolean;
  brandId?: number;
}): string {
  const { customerEmotion, humanReason, isOrderLookupContext, hasOrderInfo, brandId } = options;
  const opening = brandMessage(brandId, "handoff_opening", HANDOFF_MANDATORY_OPENING);
  const emotionOnly = (customerEmotion === "angry" || customerEmotion === "high_risk" || customerEmotion === "frustrated");
  if (emotionOnly) return opening;
  const mayAddHint = humanReason === "explicit_human_request" && isOrderLookupContext === true && hasOrderInfo !== true;
  if (mayAddHint) {
    return opening + "\n" + HANDOFF_OPTIONAL_ORDER_HINT;
  }
  return opening;
}

/** order_lookup / order_followup 回覆建議上限（與 enforceOutputGuard 對齊） */
export const OUTPUT_GUARD_MAX_CHARS = 600;
/** 其餘 mode 回覆建議上限 */
export const OUTPUT_GUARD_MAX_CHARS_RELAXED = 800;

/**
 * 回覆長度控制：查單／出貨跟進較嚴、一般較寬；避免 LINE 上超長 wall of text。
 */
export function enforceOutputGuard(text: string, planMode: string): string {
  const trimmed = (text || "").trim();
  if (!trimmed) return trimmed;

  const maxChars =
    planMode === "order_lookup" || planMode === "order_followup" ? 600 : 800;

  if (trimmed.length <= maxChars) return trimmed;

  const candidates = [
    trimmed.lastIndexOf("。", maxChars),
    trimmed.lastIndexOf("！", maxChars),
    trimmed.lastIndexOf("～", maxChars),
    trimmed.lastIndexOf("\n", maxChars),
  ].filter((i) => i >= Math.floor(maxChars * 0.5) && i < maxChars);

  if (candidates.length > 0) {
    const cutAt = Math.max(...candidates) + 1;
    return trimmed.slice(0, cutAt);
  }

  return trimmed.slice(0, maxChars - 1) + "…";
}
```

## server/content-guard.ts

```typescript
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
```

## server/sop-compliance-guard.ts

```typescript
/**
 * Phase 3.0 / 90：出貨 SOP 事後合規（Post-Generation），非整段 Deterministic 回覆。
 * Phase 90：前綴改為真人語感敘述，降低「補丁感」，仍保證道歉＋工作天＋不加壓確切日＋催促加急。
 */
import { brandMessage } from "./phase2-output";
import { shouldInjectShippingSopForToolContext } from "./tool-llm-sanitize";

/** 簡短道歉＋雙時程＋不保證到貨日＋承諾跟進；品牌可經 message_overrides.shipping_sop_prefix 覆寫 */
export const SHIPPING_SOP_COMPLIANCE_PREFIX =
  "不好意思讓您久等了，現貨品我們大約五個工作天內會幫您安排寄出，預購品大約七到二十個工作天。確切時間沒辦法保證，但我會幫您留意，需要的話也會幫忙催一下。\n\n";

const APOLOGY_HINT = /抱歉|不好意思|久候|久等|讓您等/;
/** 已用口語交代出貨時程或物流承諾時，視為自然合規，降低 Guard 出手率（Phase 96） */
const NATURAL_SHIPPING_SUBSTANCE_HINT =
  /工作天|天內|安排|7[-～－]\s*20|七\s*到\s*二十|五\s*個|預購|現貨|寄出|出貨|物流|配送|倉儲|加急|催促|盯|進度|催/;

/** Phase 97：致歉＋盡快處理／安排／寄出（仍鼓勵模型補齊工作天數，由主 prompt 與 SOP 小抄拉齊） */
function hasApologyPlusExpeditedHandling(text: string): boolean {
  if (!APOLOGY_HINT.test(text)) return false;
  if (!/盡快/.test(text)) return false;
  return /處理|安排|寄出|出貨|配送/.test(text);
}

/** Phase 97：願意幫客人向物流端催促（即使未先致歉，仍視為有物流行動承諾；極短無義句除外） */
function hasLogisticsFollowThrough(text: string): boolean {
  if (!/物流|配送|出貨|寄件/.test(text)) return false;
  if (!/催|催促|盯|進度|幫您|幫你|我會/.test(text)) return false;
  return text.length >= 8;
}

/**
 * @param intent 保留擴充用；目前以 planMode + user/recent 語意為主。
 */
export function ensureShippingSopCompliance(
  reply: string,
  planMode: string,
  _intent: string,
  userMessage?: string,
  recentUserMessages?: string[],
  brandId?: number
): string {
  if (planMode !== "order_followup") return reply;
  if (!shouldInjectShippingSopForToolContext(userMessage, recentUserMessages)) return reply;
  const text = (reply || "").trim();
  if (!text) return reply;

  const prefix = brandMessage(brandId, "shipping_sop_prefix", SHIPPING_SOP_COMPLIANCE_PREFIX);

  if (text.startsWith(prefix)) return reply;
  if (APOLOGY_HINT.test(text) && NATURAL_SHIPPING_SUBSTANCE_HINT.test(text)) return reply;
  if (hasApologyPlusExpeditedHandling(text)) return reply;
  if (hasLogisticsFollowThrough(text)) return reply;
  console.warn("[SOP_GUARD_TRIGGERED] LLM 漏講出貨 SOP，Guard 介入兜底。");
  return prefix + reply;
}
```
