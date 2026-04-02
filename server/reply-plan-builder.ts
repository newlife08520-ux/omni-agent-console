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
 * 5b. order_followup（已有訂單上下文之出貨／物流等追問，不清除 active context）
 * 6. off_topic_guard（品牌外問題，不陪聊）
 * 7. answer_directly（商品問答、價格、smalltalk、其餘）
 */
import type { ConversationState } from "./conversation-state-resolver";
import type { AgentScenario } from "./services/phase1-types";
import { classifyOrderNumber } from "./intent-and-order";
import { extractOrderIdFromMixedSentence } from "./order-fast-path";

/** 與 intent-router ORDER_CTX 對齊，供 plan bridge 判斷查單語境 */
const PLAN_BRIDGE_ORDER_CTX = /訂單|查單|查詢訂單|我的訂單|單號|編號|物流|出貨|貨態|配送|進度|何時到/;

/** Phase 1.5：硬規則快照傳入 plan，僅作輕量橋接 */
export interface Phase1PreRouteSnapshot {
  selected_scenario: AgentScenario;
  confidence: number;
  matched_intent: string;
  route_source: string;
}

export type ReplyPlanMode =
  | "handoff"
  | "return_form_first"
  | "aftersales_comfort_first"
  | "return_stage_1"
  | "order_lookup"
  | "order_followup"
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
  "order_followup",
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
  /** 已有 active order 且本句為出貨／物流等追問（與首輪查單區隔） */
  orderFollowupTurn?: boolean;
  /** Phase 1.5：本輪使用者原文（供 router→plan 橋接，可選） */
  latestUserMessage?: string;
  /** hybrid 硬規則預路由結果；僅在 enabled+hybrid_router 時由呼叫端傳入 */
  phase1PreRoute?: Phase1PreRouteSnapshot | null;
}

function phase15BridgeToOrderLookup(
  input: PlanBuilderInput,
  isRefundReturnIntent: boolean,
  primary_intent: string
): ReplyPlan | null {
  const { phase1PreRoute, latestUserMessage } = input;
  if (
    !phase1PreRoute ||
    phase1PreRoute.selected_scenario !== "ORDER_LOOKUP" ||
    phase1PreRoute.confidence < 0.72 ||
    !latestUserMessage ||
    isRefundReturnIntent
  ) {
    return null;
  }
  const um = latestUserMessage.trim();
  const bridgeable =
    primary_intent === "general" ||
    primary_intent === "smalltalk" ||
    primary_intent === "product_consult" ||
    primary_intent === "price_purchase";
  if (!bridgeable) return null;
  const ot = classifyOrderNumber(um);
  const mixed = extractOrderIdFromMixedSentence(um);
  const compact = um.replace(/\s/g, "");
  const looksOrder =
    ot === "order_id" ||
    ot === "logistics_id" ||
    ot === "payment_id" ||
    (ot === "pending_review" && /^[A-Z]{2,4}\d{5,}$/i.test(compact)) ||
    (!!mixed && PLAN_BRIDGE_ORDER_CTX.test(um));
  return looksOrder ? { mode: "order_lookup" } : null;
}

/** 依 state 與設定產出本輪唯一 ReplyPlan */
export function buildReplyPlan(input: PlanBuilderInput): ReplyPlan {
  const { state, returnFormUrl, isReturnFirstRound = false, orderFollowupTurn = false, latestUserMessage, phase1PreRoute } = input;
  const { primary_intent, return_reason_type, needs_human, human_reason, return_stage } = state;

  if (needs_human && human_reason) {
    if (human_reason === "explicit_human_request" || human_reason === "legal_or_reputation_threat" || human_reason === "payment_or_order_risk" || human_reason === "policy_exception" || human_reason === "return_stage_3_insist" || human_reason === "repeat_unresolved") {
      return { mode: "handoff" };
    }
  }

  const isRefundReturnIntent = ["refund_or_return", "exchange_request", "cancellation_request"].includes(primary_intent);

  if (isRefundReturnIntent && !needs_human) {
    if (return_reason_type === "product_issue") {
      return {
        mode: "return_form_first",
        should_include: ["先道歉", "表示會協助處理", "退換貨／售後表單", returnFormUrl ? "表單連結" : ""].filter(Boolean),
      };
    }
    if (return_reason_type === "wait_too_long") {
      return {
        mode: "aftersales_comfort_first",
        should_include: ["先安撫", "先查詢出貨狀況", "說明是否有現貨／能否加急", "不要先丟表單", "不要先轉人工"],
      };
    }
    if (return_reason_type === "insist") {
      if (return_stage === 1) return { mode: "return_stage_1" };
      return {
        mode: "return_form_first",
        should_include: ["安撫", "表單", returnFormUrl ? "退換貨表單連結" : ""].filter(Boolean),
      };
    }
    if (return_reason_type === null || return_reason_type === undefined) {
      return {
        mode: "aftersales_comfort_first",
        should_include: ["先安撫", "先理解原因", "可查詢出貨", "不要一開口就表單"],
      };
    }
    if (return_stage === 1) return { mode: "return_stage_1" };
  }

  if (primary_intent === "order_lookup" && !isRefundReturnIntent) {
    if (orderFollowupTurn) return { mode: "order_followup" };
    return { mode: "order_lookup" };
  }

  if (primary_intent === "off_topic") {
    return { mode: "off_topic_guard" };
  }

  const bridgedPlan = phase15BridgeToOrderLookup(input, isRefundReturnIntent, primary_intent);
  if (bridgedPlan) return bridgedPlan;

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
