/**
 * AI 尷尬／重複兩次以上 → 正式轉人工條件（程式層硬規則）。
 * 符合任一條即應直接轉人工，不再讓 AI 硬聊。
 *
 * 條件至少包含：
 * - 同一種資料重問兩次（如訂單編號、手機）
 * - 同一種模板重複兩次（AI 回覆內容高度相似）
 * - 客人已說「我給過了/你沒看前面嗎/你在講什麼」且前一輪 AI 確實在討同一類資訊
 * - 類別跳錯後仍未修正（如用戶要查單但 AI 回表單）
 */

export type MessageLike = { sender_type: string; content?: string | null };

/** 同一種「討資料」句型：訂單編號、手機、商品名稱等 */
const ASK_ORDER_PHONE_PATTERNS = /請提供訂單編號|訂單編號|請提供.*手機|請.*手機號碼|請提供.*商品|商品名稱|下單手機|收件人|請提供.*資訊/i;

/** 用戶表示「已給過／你沒看／你在講什麼」 */
const ALREADY_GAVE_OR_CONFUSED = /我給過了|你沒看|前面有|你在講什麼|剛剛就說|不是說了|已經給|上面有|你沒看到嗎|沒在看嗎/i;

/** 查單相關意圖關鍵字 */
const ORDER_LOOKUP_HINT = /訂單|查單|出貨|物流|單號|編號|還沒到|何時出貨/i;

/** 表單／退換貨類回覆（非查單） */
const RETURN_FORM_HINT = /退換貨表單|填寫表單|表單連結|申請退|申請換/i;

/** 從近期訊息中抽取訂單編號（至少一英文字）或手機的簡易正則 */
const ORDER_ID_IN_TEXT = /\b[A-Za-z][A-Z0-9\-]{4,24}\b/;
const PHONE_IN_TEXT = /\b09\d{8}\b/;

function normalizeForCompare(s: string): string {
  return (s || "").trim().replace(/\s+/g, " ").slice(0, 80);
}

/**
 * 檢查近期 AI 回覆中是否有「討同一種資料」的句型出現至少 2 次。
 */
function sameDataAskedTwice(recentMessages: MessageLike[]): boolean {
  const aiContents = recentMessages
    .filter((m) => m.sender_type === "ai" && m.content)
    .map((m) => (m.content || "").trim())
    .filter(Boolean);
  const askCount = aiContents.filter((c) => ASK_ORDER_PHONE_PATTERNS.test(c)).length;
  return askCount >= 2;
}

/**
 * 檢查最近兩則 AI 回覆是否高度相似（同一種模板重複）。
 */
function sameTemplateRepeatedTwice(recentMessages: MessageLike[]): boolean {
  const aiContents = recentMessages
    .filter((m) => m.sender_type === "ai" && m.content)
    .map((m) => (m.content || "").trim())
    .filter(Boolean);
  if (aiContents.length < 2) return false;
  const last = normalizeForCompare(aiContents[aiContents.length - 1]);
  const prev = normalizeForCompare(aiContents[aiContents.length - 2]);
  if (last.length < 20 || prev.length < 20) return false;
  if (last === prev) return true;
  if (last.slice(0, 50) === prev.slice(0, 50)) return true;
  return false;
}

/**
 * 用戶說「我給過了」等且前一則 AI 在討訂單/手機，且更早的用戶訊息裡其實有訂單或手機 → 視為 AI 答錯，應轉人工。
 */
function userSaidAlreadyGaveAndLastAiAskedAgain(
  userMessage: string,
  recentMessages: MessageLike[]
): boolean {
  if (!ALREADY_GAVE_OR_CONFUSED.test((userMessage || "").trim())) return false;
  const list = recentMessages.filter((m) => m.content && m.content !== "[圖片訊息]");
  const lastAi = [...list].reverse().find((m) => m.sender_type === "ai");
  if (!lastAi?.content || !ASK_ORDER_PHONE_PATTERNS.test(lastAi.content)) return false;
  const userTextsBeforeLastAi = list
    .slice(0, list.findIndex((m) => m === lastAi))
    .filter((m) => m.sender_type === "user")
    .map((m) => (m.content || "").trim())
    .join(" ");
  const hasOrderOrPhone = ORDER_ID_IN_TEXT.test(userTextsBeforeLastAi) || PHONE_IN_TEXT.test(userTextsBeforeLastAi);
  return hasOrderOrPhone;
}

/**
 * 類別跳錯：用戶上一輪明顯是查單意圖，但上一則 AI 回覆是表單／退換貨且沒在處理查單。
 */
function intentMismatchLastRound(
  recentMessages: MessageLike[],
  currentUserIntentIsOrderLookup: boolean
): boolean {
  if (!currentUserIntentIsOrderLookup) return false;
  const list = recentMessages.filter((m) => m.content && m.content !== "[圖片訊息]");
  const lastUser = [...list].reverse().find((m) => m.sender_type === "user");
  const lastAi = [...list].reverse().find((m) => m.sender_type === "ai");
  if (!lastUser?.content || !lastAi?.content) return false;
  const userHadOrderLookup = ORDER_LOOKUP_HINT.test(lastUser.content);
  if (!userHadOrderLookup) return false;
  const aiGaveReturnForm = RETURN_FORM_HINT.test(lastAi.content) && !ORDER_LOOKUP_HINT.test(lastAi.content);
  return aiGaveReturnForm;
}

export interface AwkwardRepeatInput {
  userMessage: string;
  recentMessages: MessageLike[];
  /** 本輪解析出的 primary_intent 是否為 order_lookup */
  primaryIntentOrderLookup?: boolean;
}

export interface AwkwardRepeatResult {
  shouldHandoff: boolean;
  reason?: "same_data_asked_twice" | "same_template_twice" | "user_said_already_gave_ai_wrong" | "intent_mismatch";
}

/**
 * 判斷是否應因「尷尬／重複」直接轉人工。任一條件成立即回傳 shouldHandoff: true。
 */
export function shouldHandoffDueToAwkwardOrRepeat(input: AwkwardRepeatInput): AwkwardRepeatResult {
  const { userMessage, recentMessages, primaryIntentOrderLookup } = input;
  const recent = Array.isArray(recentMessages) ? recentMessages : [];

  if (sameDataAskedTwice(recent)) {
    return { shouldHandoff: true, reason: "same_data_asked_twice" };
  }
  if (sameTemplateRepeatedTwice(recent)) {
    return { shouldHandoff: true, reason: "same_template_twice" };
  }
  if (userSaidAlreadyGaveAndLastAiAskedAgain(userMessage, recent)) {
    return { shouldHandoff: true, reason: "user_said_already_gave_ai_wrong" };
  }
  if (intentMismatchLastRound(recent, primaryIntentOrderLookup === true)) {
    return { shouldHandoff: true, reason: "intent_mismatch" };
  }

  return { shouldHandoff: false };
}
