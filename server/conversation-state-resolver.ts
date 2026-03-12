/**
 * 對話狀態解析：每次新訊息進來先產出 ConversationState，供 reply-plan-builder 與 reply 使用。
 * 不直接丟給 LLM，先判斷再說話。
 */
import type { Contact } from "@shared/schema";

export type PrimaryIntent =
  | "product_consult"
  | "price_purchase"
  | "order_lookup"
  | "shipping_delay"
  | "refund_or_return"
  | "exchange_request"
  | "cancellation_request"
  | "complaint"
  | "human_request"
  | "smalltalk"
  | "unclear";

export type HumanReason =
  | "explicit_human_request"
  | "legal_or_reputation_threat"
  | "payment_or_order_risk"
  | "policy_exception"
  | "repeat_unresolved"
  | "return_stage_3_insist"
  | "special_case_manual_review"
  | null;

export type CustomerEmotion = "calm" | "neutral" | "frustrated" | "angry" | "high_risk";

export type OrderInfoStatus =
  | "none"
  | "partial"
  | "suspected_order_no"
  | "valid_order_no"
  | "invalid"
  | "found"
  | "not_found";

export type WaitingForCustomer =
  | "none"
  | "order_number"
  | "product_name"
  | "phone"
  | "photo_video"
  | "reason"
  | "return_form_submit"
  | "other";

export type ResolutionStatus = "open" | "awaiting_customer" | "awaiting_human" | "resolved" | "closed";

/** 退換貨／取消的原因類型：久候型先安撫＋查詢；商品問題型走正式表單；明確堅持再升級 */
export type ReturnReasonType = "wait_too_long" | "product_issue" | "insist" | null;

export interface ConversationState {
  primary_intent: PrimaryIntent;
  secondary_intent?: string | null;
  /** 退換貨時區分：久候型(先安撫查詢)、商品問題型(走表單)、明確堅持(轉人工) */
  return_reason_type?: ReturnReasonType;
  needs_human: boolean;
  human_reason?: HumanReason;
  return_stage: 0 | 1 | 2 | 3;
  customer_emotion: CustomerEmotion;
  knowledge_confidence: "high" | "medium" | "low" | "none";
  order_info_status: OrderInfoStatus;
  waiting_for_customer: WaitingForCustomer;
  resolution_status: ResolutionStatus;
  rating_eligible: boolean;
  rating_invited_at?: string | null;
  last_customer_reply_at?: string | null;
  last_ai_reply_at?: string | null;
}

const HUMAN_REQUEST_PATTERNS = /真人|轉人工|不要機器人|找客服|找主管|真人處理|真人客服|人工客服/i;
const HIGH_RISK_PATTERNS = /詐騙|檢舉|投訴|消保官|公開|發文|再不處理/i;
const INSIST_REFUND_PATTERNS = /我就是要退|直接幫我退|我不要其他方案|我就是要退款|不要再跟我說別的方法|我不接受其他處理方式/i;
/** 商品瑕疵／損壞／錯貨／缺件 → 正式售後，走表單或人工 */
const PRODUCT_ISSUE_PATTERNS = /瑕疵|損壞|錯貨|缺件|漏寄|壞掉|破損|收到.*有問題|使用.*瑕疵|有問題|破掉/i;
/** 退貨／退款／換貨／取消／久候等關鍵字 */
const REFUND_RETURN_PATTERNS = /退貨|退款|換貨|取消訂單|不想等|不要了|等太久|怎麼還沒|還沒收到|等很久|不要等/i;
/** 單純問訂單／出貨進度（不帶強烈退貨意圖時） */
const ORDER_LOOKUP_PATTERNS = /訂單|查單|出貨|物流|還沒到|單號|編號|什麼時候到|何時出貨|出貨進度|還沒寄/i;
const PRODUCT_CONSULT_PATTERNS = /尺寸|成分|規格|用法|怎麼用|哪款|比較|差異/i;
const PRICE_PATTERNS = /價格|多少錢|優惠|折扣|活動/i;

function detectPrimaryIntent(userMessage: string, recentUserMessages: string[], contact: Contact): PrimaryIntent {
  const text = (userMessage || "").trim();
  const combined = [text, ...recentUserMessages].join(" ");

  if (HUMAN_REQUEST_PATTERNS.test(text)) return "human_request";
  if (HIGH_RISK_PATTERNS.test(combined)) return "complaint";
  if (INSIST_REFUND_PATTERNS.test(text)) return "refund_or_return";
  if (REFUND_RETURN_PATTERNS.test(combined)) return "refund_or_return";
  if (ORDER_LOOKUP_PATTERNS.test(combined) || /^[A-Z0-9\-]{5,}$/i.test(text)) return "order_lookup";
  if (PRODUCT_CONSULT_PATTERNS.test(combined)) return "product_consult";
  if (PRICE_PATTERNS.test(combined)) return "price_purchase";
  if (/^[\s\W]*$/.test(text) || /^(好|嗯|喔|謝謝|感謝|了解)$/.test(text)) return "smalltalk";
  if (text.length >= 5) return "unclear";
  return "unclear";
}

/** 區分退換貨／取消的原因類型：商品問題型(走表單)、久候型(先安撫查詢)、明確堅持(轉人工)。
 * 地雷4：當同時命中「久候」與「商品問題」時，優先用久候型（先安撫＋查詢），避免誤走 return_form_first。 */
function detectReturnReasonType(userMessage: string, primary_intent: PrimaryIntent): ReturnReasonType {
  if (!["refund_or_return", "exchange_request", "cancellation_request"].includes(primary_intent)) return null;
  const t = (userMessage || "").trim();
  const combined = [t].join(" ");
  if (INSIST_REFUND_PATTERNS.test(t)) return "insist";
  const hasWaitTooLong = /等太久|不想等|不要等|怎麼還沒|還沒收到|等很久|想取消|不要了/.test(combined);
  const hasProductIssue = PRODUCT_ISSUE_PATTERNS.test(combined);
  if (hasWaitTooLong) return "wait_too_long";
  if (hasProductIssue) return "product_issue";
  return "wait_too_long";
}

function detectEmotion(userMessage: string): CustomerEmotion {
  const t = (userMessage || "").trim();
  if (/消保官|檢舉|詐騙|公開|發文|再不處理/.test(t)) return "high_risk";
  if (/氣死|爛透了|到底|搞什麼|什麼態度/.test(t)) return "angry";
  if (/太久了|不想等了|到底要多久/.test(t)) return "frustrated";
  return "neutral";
}

function inferOrderInfoStatus(contact: Contact, lastUserMessage: string): OrderInfoStatus {
  const msg = (lastUserMessage || "").trim();
  if (/^[A-Z0-9\-]{5,}$/i.test(msg) && msg.length <= 25) return "suspected_order_no";
  if (contact.order_number_type === "order_id") return "valid_order_no";
  return "none";
}

function inferResolutionStatus(contact: Contact): ResolutionStatus {
  if (contact.status === "awaiting_human" || contact.status === "high_risk") return "awaiting_human";
  if (contact.status === "closed" || contact.status === "resolved") return contact.status as ResolutionStatus;
  const tags = JSON.parse(contact.tags || "[]") as string[];
  if (tags.some((t) => ["待訂單編號", "待補單號", "待填表單"].includes(t))) return "awaiting_customer";
  return "open";
}

function inferWaitingForCustomer(contact: Contact, recentAiMessages: string[]): WaitingForCustomer {
  const lastAi = (recentAiMessages[recentAiMessages.length - 1] || "").toLowerCase();
  if (/訂單編號|單號|編號/.test(lastAi) && !/手機|電話/.test(lastAi)) return "order_number";
  if (/商品名稱|哪個商品|買的是/.test(lastAi)) return "product_name";
  if (/手機|電話|聯絡方式/.test(lastAi)) return "phone";
  if (/表單|填寫/.test(lastAi)) return "return_form_submit";
  if (/照片|圖片|傳圖/.test(lastAi)) return "photo_video";
  return "none";
}

/** 判斷是否可發評價：resolved/closed、非投訴、非待人工、尚未發過 */
function isRatingEligible(contact: Contact, state: Partial<ConversationState>): boolean {
  const status = contact.status as string;
  if (status !== "resolved" && status !== "closed") return false;
  if (contact.status === "awaiting_human" || contact.status === "high_risk") return false;
  if ((contact as any).rating_invited_at) return false;
  if (contact.cs_rating != null || contact.ai_rating != null) return false;
  if (state.primary_intent === "complaint" || state.customer_emotion === "high_risk") return false;
  return true;
}

export interface ResolveInput {
  contact: Contact;
  userMessage: string;
  recentUserMessages: string[];
  recentAiMessages: string[];
  lastMessageAtBySender?: { user?: string; ai?: string } | null;
}

/** 解析對話狀態，供 reply plan 與 reply generator 使用 */
export function resolveConversationState(input: ResolveInput): ConversationState {
  const { contact, userMessage, recentUserMessages, recentAiMessages, lastMessageAtBySender } = input;
  const primary_intent = detectPrimaryIntent(userMessage, recentUserMessages, contact);
  const customer_emotion = detectEmotion(userMessage);
  const order_info_status = inferOrderInfoStatus(contact, userMessage);
  const resolution_status = inferResolutionStatus(contact);
  const waiting_for_customer = inferWaitingForCustomer(contact, recentAiMessages);

  let needs_human = contact.needs_human === 1;
  let human_reason: HumanReason = (contact as any).human_reason as HumanReason ?? null;
  if (primary_intent === "human_request") {
    needs_human = true;
    human_reason = "explicit_human_request";
  }
  if (primary_intent === "complaint" || customer_emotion === "high_risk") {
    needs_human = true;
    human_reason = human_reason || "legal_or_reputation_threat";
  }
  if (INSIST_REFUND_PATTERNS.test((userMessage || "").trim())) {
    needs_human = true;
    human_reason = "return_stage_3_insist";
  }

  const return_stage = Math.min(3, Math.max(0, (contact as any).return_stage ?? 0)) as 0 | 1 | 2 | 3;
  const return_reason_type = detectReturnReasonType(userMessage, primary_intent);
  const rating_invited_at = (contact as any).rating_invited_at ?? null;
  const rating_eligible = isRatingEligible(contact, { primary_intent, customer_emotion });

  return {
    primary_intent,
    return_reason_type: return_reason_type ?? undefined,
    needs_human,
    human_reason: human_reason ?? undefined,
    return_stage,
    customer_emotion,
    knowledge_confidence: "medium",
    order_info_status,
    waiting_for_customer,
    resolution_status,
    rating_eligible,
    rating_invited_at: rating_invited_at || undefined,
    last_customer_reply_at: lastMessageAtBySender?.user ?? contact.last_message_at ?? undefined,
    last_ai_reply_at: lastMessageAtBySender?.ai ?? undefined,
  };
}
