/**
 * 對話狀態解析：每次新訊息進來先產出 ConversationState，供 reply-plan-builder 與 reply 使用。
 * 不直接丟給 LLM，先判斷再說話。
 */
import type { Contact } from "@shared/schema";

export type PrimaryIntent =
  | "product_consult"
  | "price_purchase"
  | "link_request"
  | "order_lookup"
  | "shipping_delay"
  | "refund_or_return"
  | "exchange_request"
  | "cancellation_request"
  | "complaint"
  | "human_request"
  | "off_topic"
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

/** 可由 AI 處理的意圖：本輪為此時不沿用 needs_human，僅明確要真人或 legal_risk／必須人工時才設。供 routes 判斷是否補 handoff 句。 */
export const AI_HANDLABLE_INTENTS: PrimaryIntent[] = ["order_lookup", "link_request", "product_consult", "price_purchase", "smalltalk", "unclear"];
export function isAiHandlableIntent(intent: PrimaryIntent): boolean {
  return AI_HANDLABLE_INTENTS.includes(intent);
}

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
  /** Phase 2：已鎖定商品範圍（bag/sweet），回覆不得跨品類 */
  product_scope_locked?: string | null;
}

/** Phase 1：僅「明確要求轉接真人」才 handoff；不含單獨「真人」「找客服」等模糊句，避免隨便轉人工。 */
const HUMAN_REQUEST_PATTERNS = /轉人工|我要轉人工|找真人(客服)?|找主管|不要機器人|真人處理|真人客服|人工客服|能轉人工嗎|我要人工|轉真人|可以幫我轉人工|我要找真人|轉接真人|轉接人工|要真人客服|要人工客服/i;
/** 純招呼或曖昧短句：不視為「明確要求真人」，避免誤切待人工（真人感 ≠ 轉真人）。 */
const PURE_GREETING_OR_VAGUE = /^(在嗎|哈囉|嗨|嗯|好|喔|太誇張了|太扯了|等一下|有人嗎|人呢|喂)$/i;
const HIGH_RISK_PATTERNS = /詐騙|檢舉|投訴|消保官|公開|發文|再不處理/i;
/** Phase 1：糾正語 → 本輪以當前句重算意圖，不沿用前輪 */
const CORRECTION_OVERRIDE_PATTERNS = /說錯|不是|我要的是|改成|其實是|剛剛說錯/i;
const INSIST_REFUND_PATTERNS = /我就是要退|直接幫我退|我不要其他方案|我就是要退款|不要再跟我說別的方法|我不接受其他處理方式/i;
/** 商品瑕疵／損壞／錯貨／缺件 → 正式售後，走表單或人工 */
const PRODUCT_ISSUE_PATTERNS = /瑕疵|損壞|錯貨|缺件|漏寄|壞掉|破損|收到.*有問題|使用.*瑕疵|有問題|破掉/i;
/** 退貨／退款／換貨／取消／久候等關鍵字 */
const REFUND_RETURN_PATTERNS = /退貨|退款|換貨|取消訂單|不想等|不要了|等太久|怎麼還沒|還沒收到|等很久|不要等/i;
/** 單純問訂單／出貨進度（不帶強烈退貨意圖時）；供 handoff 第二句條件用（同一句有提到才可補訂單提示） */
export const ORDER_LOOKUP_PATTERNS = /訂單|查單|出貨|物流|還沒到|單號|編號|什麼時候到|什麼時候到貨|什麼時候出貨|何時出貨|出貨進度|還沒寄|何時會到/i;

/**
 * 訂單追問相關關鍵字（出貨進度、物流、地址、付款狀態等）
 * 供 reply-plan（ai-reply）、order-lookup-policy、order-fast-path 統一使用。
 */
export const ORDER_FOLLOWUP_PATTERNS =
  /出貨|付款|寄到|地址|門市|全家|物流|單號|編號|追蹤|貨到|取件|配送|多久|預購|久等|怎麼還沒|沒收到|催|什麼時候|查詢|收到|付款成功|成功了嗎|待出貨|已出貨|物流單號|便利商店|哪間超商|寄到哪裡|哪間全家/i;

/** 像訂單編號的格式：英數字+連字號 5 碼以上，可含空格（會先去除）。只要偵測到就應觸發查單。 */
export function looksLikeOrderNumber(text: string): boolean {
  const normalized = (text || "").trim().replace(/\s+/g, "");
  return normalized.length >= 5 && /[0-9]/.test(normalized) && /^[A-Z0-9\-]+$/i.test(normalized) && !/^[A-Z\-]+$/i.test(normalized);
}
const PRODUCT_CONSULT_PATTERNS = /尺寸|成分|規格|用法|怎麼用|哪款|比較|差異/i;
const PRICE_PATTERNS = /價格|多少錢|優惠|折扣|活動/i;
/** Phase 2：品牌外生活問題，不陪聊；短句收邊界 */
const OFF_TOPIC_PATTERNS = /晚餐吃什麼|吃什麼好|推薦餐廳|今天吃什麼|午餐吃什麼|早餐吃什麼|哪裡好吃|有什麼好吃的|電影推薦|旅遊推薦|天氣怎樣|今天天氣/i;

/** 購買連結／商品頁需求：優先於詐騙防護，不可回防詐模板或切待人工 */
export const LINK_REQUEST_PATTERNS = /請給我連結|有購買的連結嗎|有連結嗎|可以開連結嗎|傳商品頁給我|下單網址|哪裡買|購買頁面|商品連結|請開給我連結|開連結|購買連結|商品頁|下單連結|結帳連結|給我連結|要連結|有.*連結/i;

export function isLinkRequestMessage(text: string): boolean {
  return LINK_REQUEST_PATTERNS.test((text || "").trim());
}

/** 糾正為連結需求（先誤觸防詐後用戶澄清要的是購買連結）→ 可拉回商品詢問 */
export const LINK_REQUEST_CORRECTION_PATTERNS = /我是要購買連結|我要的是連結|要商品連結|請開商品頁|有購買的連結嗎|請給我購買連結/i;

export function isLinkRequestCorrectionMessage(text: string): boolean {
  return LINK_REQUEST_PATTERNS.test((text || "").trim()) || LINK_REQUEST_CORRECTION_PATTERNS.test((text || "").trim());
}

/** 人工排隊中客人要求「重新開始」時的固定回覆（不可清除 needs_human） */
export const HANDOFF_QUEUE_RESET_BLOCK_REPLY =
  "您目前已經在人工協助流程中，專員會盡快回覆您唷～";

/** 客人要求「當全新對話」：人工排隊中不可當成重置許可（見 ai-reply / webhook 硬擋） */
export const CONVERSATION_RESET_REQUEST_PATTERNS =
  /重新開始|當作第一次見面|當成第一次見面|忘記之前對話|忘記先前對話|重新來一次|從頭開始|清零|清除對話/i;

export function isConversationResetRequest(text: string): boolean {
  return CONVERSATION_RESET_REQUEST_PATTERNS.test((text || "").trim());
}

/**
 * 退換貨表單已給之後的常見接續句：應讓 AI 繼續回（與「僅連結可解鎖」並列），避免 needs_human 後完全失聰。
 */
export const RETURN_FORM_FOLLOWUP_PATTERNS =
  /改(成)?換貨|還是改?換貨|換貨好了|想換貨|想改換貨|算了我要換貨|還是換|換別款|不退了|先不退|我先想一下|還在考慮|先考慮|表單填好了|我填好了/i;

export function isReturnFormFollowupMessage(text: string): boolean {
  return RETURN_FORM_FOLLOWUP_PATTERNS.test((text || "").trim());
}

function detectPrimaryIntent(userMessage: string, recentUserMessages: string[], contact: Contact): PrimaryIntent {
  const text = (userMessage || "").trim();
  /** Phase 1 correction override：有糾正語時僅用本輪內容算意圖，不沿用前輪 */
  const useOnlyCurrentMessage = CORRECTION_OVERRIDE_PATTERNS.test(text);
  const combined = useOnlyCurrentMessage ? text : [text, ...recentUserMessages].join(" ");

  if (HUMAN_REQUEST_PATTERNS.test(text) && !PURE_GREETING_OR_VAGUE.test(text)) return "human_request";
  /** link_request 優先於詐騙／高風險：索取商品頁／購買連結時不走防詐模板、不切待人工 */
  if (LINK_REQUEST_PATTERNS.test(text) || LINK_REQUEST_CORRECTION_PATTERNS.test(text)) return "link_request";
  if (HIGH_RISK_PATTERNS.test(combined)) return "complaint";
  if (INSIST_REFUND_PATTERNS.test(text)) return "refund_or_return";
  /** Phase 2：單純查單／出貨進度（如「我買OO怎麼還沒到」）優先於退換貨；像訂單編號的內容（含空格如 DEN 65234）也視為查單 */
  if (ORDER_LOOKUP_PATTERNS.test(combined) || looksLikeOrderNumber(text)) return "order_lookup";
  if (REFUND_RETURN_PATTERNS.test(combined)) return "refund_or_return";
  if (OFF_TOPIC_PATTERNS.test(text)) return "off_topic";
  if (PRODUCT_CONSULT_PATTERNS.test(combined)) return "product_consult";
  if (PRICE_PATTERNS.test(combined)) return "price_purchase";
  if (/^[\s\W]*$/.test(text) || /^(好|嗯|喔|謝謝|感謝|了解)$/.test(text)) return "smalltalk";
  /** 拆除意圖黑洞：未命中正則時直接回傳 unclear，絕不使用字串長度阻擋解析 */
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

/** Phase 1：僅法務/公關為 high_risk；爛、很煩、很慢、不爽等為 frustrated，不升格 high_risk */
function detectEmotion(userMessage: string): CustomerEmotion {
  const t = (userMessage || "").trim();
  if (/消保官|檢舉|詐騙|公開|發文|再不處理|提告|投訴|消保|媒體|爆料/.test(t)) return "high_risk";
  if (/氣死|爛透了|到底|搞什麼|什麼態度/.test(t)) return "angry";
  if (/太久了|不想等了|到底要多久|爛|很煩|很慢|不爽|太扯|離譜/.test(t)) return "frustrated";
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
  /** 本輪為「可由 AI 處理」的意圖時，不沿用前輪 handoff；僅本輪明確要真人或 legal_risk／必須人工權限時才重設 needs_human。 */
  if (AI_HANDLABLE_INTENTS.includes(primary_intent)) {
    needs_human = false;
    human_reason = null;
  }
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
  const product_scope_locked = (contact as any).product_scope_locked ?? null;

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
    product_scope_locked: product_scope_locked || undefined,
  };
}

/** Hotfix：供 routes 在圖片/查單等分支前判斷是否為明確轉人工，避免被圖片模板搶答 */
export function isHumanRequestMessage(text: string): boolean {
  const t = (text || "").trim();
  return HUMAN_REQUEST_PATTERNS.test(t) && !PURE_GREETING_OR_VAGUE.test(t);
}

/** Hotfix：客戶說已給過資料（你拿過了/我就給過了/前面有/我貼過了/你沒看到嗎）→ 需先搜歷史再決定 */
const ALREADY_PROVIDED_PATTERNS = /我給過了|你拿過了|我就給過了|前面有|我貼過了|你沒看到嗎|剛剛有|剛才給|已經給過|已經提供|上面有|剛剛傳了/i;
export function isAlreadyProvidedMessage(text: string): boolean {
  return ALREADY_PROVIDED_PATTERNS.test((text || "").trim());
}
