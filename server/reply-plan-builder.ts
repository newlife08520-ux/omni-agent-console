/**
 * Reply Plan Builder：在產出文字前決定本輪只能走哪一個 mode，避免多流程同時搶答。
 * Phase 2：一輪一個 mode，一旦決定不得被其他 probing/安撫/查單/退貨搶答。
 *
 * 【Mode 優先級表】（由高到低，先命中先得，只出一個）
 * 1. handoff（明確要真人 / 法務投訴 / 明確堅持退款退貨）
 * 2. return_form_first（商品問題型：瑕疵損壞錯貨缺件 → 正式表單）
 * 3. aftersales_comfort_first（久候型：等太久不想等 → 先安撫+查單，不先表單）
 * 4. return_stage_1（退換貨第一階段承接，尚未給表單）
 * 5. order_lookup（單純訂單/出貨查詢）
 * 6. off_topic_guard（品牌外問題，不陪聊）
 * 7. answer_directly（商品問答、價格、smalltalk、其餘）
 */
import type { ConversationState } from "./conversation-state-resolver";

export type ReplyPlanMode =
  | "handoff"
  | "return_form_first"
  | "aftersales_comfort_first"
  | "return_stage_1"
  | "order_lookup"
  | "off_topic_guard"
  | "answer_directly"
  | "ask_one_question"
  | "fallback_unknown"
  | "idle_closure"
  | "invite_rating";

/** Phase 2：mode 優先級順序（數字越小越優先），用於文件與除錯 */
export const MODE_PRIORITY_ORDER: ReplyPlanMode[] = [
  "handoff",
  "return_form_first",
  "aftersales_comfort_first",
  "return_stage_1",
  "order_lookup",
  "off_topic_guard",
  "answer_directly",
  "ask_one_question",
  "fallback_unknown",
  "idle_closure",
  "invite_rating",
];

export interface ReplyPlan {
  mode: ReplyPlanMode;
  must_not_include?: string[];
  should_include?: string[];
}

/** F2：全域禁止平台來源話術（查單/取消/退貨/handoff 等一律不得出現） */
export const F2_FORBIDDEN_PHRASES = [
  "官方通路",
  "其他平台",
  "若是其他平台購買",
  "向該平台客服",
  "建議向該平台客服確認",
  "非官方",
  "不是我們這邊的單",
];

export interface PlanBuilderInput {
  state: ConversationState;
  returnFormUrl: string;
  /** 是否為退換貨「首輪」承接（尚未給過表單、尚未查單） */
  isReturnFirstRound?: boolean;
}

/** 依 state 與設定產出本輪唯一 ReplyPlan */
export function buildReplyPlan(input: PlanBuilderInput): ReplyPlan {
  const { state, returnFormUrl, isReturnFirstRound = false } = input;
  const { primary_intent, return_reason_type, needs_human, human_reason, return_stage } = state;

  if (needs_human && human_reason) {
    if (human_reason === "explicit_human_request" || human_reason === "legal_or_reputation_threat" || human_reason === "payment_or_order_risk" || human_reason === "policy_exception" || human_reason === "return_stage_3_insist" || human_reason === "repeat_unresolved") {
      return { mode: "handoff", must_not_include: F2_FORBIDDEN_PHRASES };
    }
  }

  const isRefundReturnIntent = ["refund_or_return", "exchange_request", "cancellation_request"].includes(primary_intent);

  if (isRefundReturnIntent && !needs_human) {
    if (return_reason_type === "product_issue") {
      return {
        mode: "return_form_first",
        must_not_include: F2_FORBIDDEN_PHRASES,
        should_include: ["先道歉", "表示會協助處理", "退換貨／售後表單", returnFormUrl ? "表單連結" : ""].filter(Boolean),
      };
    }
    if (return_reason_type === "wait_too_long") {
      return {
        mode: "aftersales_comfort_first",
        must_not_include: F2_FORBIDDEN_PHRASES,
        should_include: ["先安撫", "先查詢出貨狀況", "說明是否有現貨／能否加急", "不要先丟表單", "不要先轉人工"],
      };
    }
    if (return_reason_type === "insist") {
      if (return_stage === 1) return { mode: "return_stage_1", must_not_include: F2_FORBIDDEN_PHRASES };
      return {
        mode: "return_form_first",
        must_not_include: F2_FORBIDDEN_PHRASES,
        should_include: ["安撫", "表單", returnFormUrl ? "退換貨表單連結" : ""].filter(Boolean),
      };
    }
    if (return_reason_type === null || return_reason_type === undefined) {
      return {
        mode: "aftersales_comfort_first",
        must_not_include: F2_FORBIDDEN_PHRASES,
        should_include: ["先安撫", "先理解原因", "可查詢出貨", "不要一開口就表單"],
      };
    }
    if (return_stage === 1) return { mode: "return_stage_1", must_not_include: F2_FORBIDDEN_PHRASES };
  }

  if (primary_intent === "order_lookup" && !isRefundReturnIntent) {
    return { mode: "order_lookup", must_not_include: F2_FORBIDDEN_PHRASES };
  }

  if (primary_intent === "off_topic") {
    return { mode: "off_topic_guard" };
  }

  if (primary_intent === "product_consult" || primary_intent === "price_purchase" || primary_intent === "link_request") {
    return { mode: "answer_directly" };
  }

  if (primary_intent === "smalltalk") {
    return { mode: "answer_directly" };
  }

  return { mode: "answer_directly" };
}

/** 是否本輪禁止先查單（僅商品問題型／表單型禁止先查單；久候型允許查單＋安撫） */
export function shouldNotLeadWithOrderLookup(plan: ReplyPlan, state: ConversationState): boolean {
  if (plan.mode === "return_form_first" || plan.mode === "return_stage_1") return true;
  return false;
}

/** 是否為久候型售後承接（先安撫＋查詢＋加急，可查單、不先表單） */
export function isAftersalesComfortFirst(plan: ReplyPlan): boolean {
  return plan.mode === "aftersales_comfort_first";
}
