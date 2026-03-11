/**
 * Reply Plan Builder：在產出文字前決定本輪只能走哪一個 mode，避免多流程同時搶答。
 * 流程優先級（由高到低）：
 * 1. 明確要真人 2. 法務/投訴/公開風險 3. 金流/訂單爭議 4. 明確堅持退款退貨
 * 5. 退貨/退款/取消/久候（→ 優先 return_form_first） 6. 訂單查詢/出貨 7. 商品諮詢 8. 閒聊/模糊
 */
import type { ConversationState } from "./conversation-state-resolver";

export type ReplyPlanMode =
  | "answer_directly"
  | "ask_one_question"
  | "order_lookup"
  | "return_stage_1"
  | "return_form_first"
  | "handoff"
  | "fallback_unknown"
  | "idle_closure"
  | "invite_rating";

export interface ReplyPlan {
  mode: ReplyPlanMode;
  must_not_include?: string[];
  should_include?: string[];
}

/** F2：退換貨首輪禁止出現的內容（官方/其他平台區分） */
export const F2_FORBIDDEN_PHRASES = [
  "官方通路",
  "其他平台",
  "若是其他平台購買",
  "向該平台客服",
  "非官方",
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
  const { primary_intent, needs_human, human_reason, return_stage, resolution_status } = state;

  if (needs_human && human_reason) {
    if (human_reason === "explicit_human_request" || human_reason === "legal_or_reputation_threat" || human_reason === "payment_or_order_risk" || human_reason === "policy_exception" || human_reason === "return_stage_3_insist" || human_reason === "repeat_unresolved") {
      return { mode: "handoff", must_not_include: F2_FORBIDDEN_PHRASES };
    }
  }

  const isRefundReturnIntent = ["refund_or_return", "exchange_request", "cancellation_request"].includes(primary_intent);
  if (isRefundReturnIntent && !needs_human) {
    if (isReturnFirstRound || return_stage === 0) {
      return {
        mode: "return_form_first",
        must_not_include: F2_FORBIDDEN_PHRASES,
        should_include: ["安撫", "表單", returnFormUrl ? "退換貨表單連結" : ""].filter(Boolean),
      };
    }
    if (return_stage === 1) {
      return { mode: "return_stage_1", must_not_include: F2_FORBIDDEN_PHRASES };
    }
  }

  if (primary_intent === "order_lookup" && !isRefundReturnIntent) {
    return { mode: "order_lookup" };
  }

  if (primary_intent === "product_consult" || primary_intent === "price_purchase") {
    return { mode: "answer_directly" };
  }

  if (primary_intent === "smalltalk") {
    return { mode: "answer_directly" };
  }

  return { mode: "answer_directly" };
}

/** 是否本輪禁止先查單（退換貨首輪先導表單） */
export function shouldNotLeadWithOrderLookup(plan: ReplyPlan, state: ConversationState): boolean {
  if (plan.mode === "return_form_first" || plan.mode === "return_stage_1") return true;
  return false;
}
