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
 * 緊急止血：改為「真正重複兩次以上」才升級。討同一種資料的句型需出現至少 3 次才轉人工。
 * 放寬：僅看「最近 5 則 AI 回覆」，不跨時段翻舊帳。
 */
function sameDataAskedTwice(recentMessages: MessageLike[]): boolean {
  const recentAi = recentMessages
    .filter((m) => m.sender_type === "ai" && m.content)
    .map((m) => (m.content || "").trim())
    .filter(Boolean)
    .slice(-5);
  const askCount = recentAi.filter((c) => ASK_ORDER_PHONE_PATTERNS.test(c)).length;
  return askCount >= 3;
}

/**
 * 檢查最近兩則 AI 回覆是否高度相似（同一種模板重複）。
 * 放寬：刪除 slice(0,50) 比對，僅「字數夠長且完全一模一樣」才算重複，避免禮貌開場白被誤殺。
 */
function sameTemplateRepeatedTwice(recentMessages: MessageLike[]): boolean {
  const aiContents = recentMessages
    .filter((m) => m.sender_type === "ai" && m.content)
    .map((m) => (m.content || "").trim())
    .filter(Boolean)
    .slice(-5);
  if (aiContents.length < 2) return false;
  const last = normalizeForCompare(aiContents[aiContents.length - 1]);
  const prev = normalizeForCompare(aiContents[aiContents.length - 2]);
  if (last.length < 20 || prev.length < 20) return false;
  return last === prev;
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

/** 用戶明確要求轉人工的關鍵字（此類不禁用） */
const HANDOFF_EXPLICIT = /轉人工|找真人|不要機器人|找主管|要真人|人工客服/i;

/**
 * 白名單：查單情境下用戶僅回覆短句（如商品名「天鷹包」）視為正在補齊參數，不判為尷尬／重複。
 */
function isShortNounReplyInOrderLookup(userMessage: string, primaryIntentOrderLookup: boolean): boolean {
  const trimmed = (userMessage || "").trim();
  if (trimmed.length > 20) return false;
  if (primaryIntentOrderLookup !== true) return false;
  if (ALREADY_GAVE_OR_CONFUSED.test(trimmed)) return false;
  if (HANDOFF_EXPLICIT.test(trimmed)) return false;
  return true;
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
 * 緊急止血：不因一次尷尬或一次「我給過了」就轉人工。只保留真正重複兩次以上或高風險才升級。
 * 放寬：查單時用戶單純回覆幾個字（如商品名稱「天鷹包」）不判為尷尬／重複，加入 bypass 白名單。
 */
export function shouldHandoffDueToAwkwardOrRepeat(input: AwkwardRepeatInput): AwkwardRepeatResult {
  const { userMessage, recentMessages, primaryIntentOrderLookup } = input;
  const recent = Array.isArray(recentMessages) ? recentMessages : [];

  if (isShortNounReplyInOrderLookup(userMessage || "", primaryIntentOrderLookup === true)) {
    return { shouldHandoff: false };
  }

  if (sameDataAskedTwice(recent)) {
    return { shouldHandoff: true, reason: "same_data_asked_twice" };
  }
  if (sameTemplateRepeatedTwice(recent)) {
    return { shouldHandoff: true, reason: "same_template_twice" };
  }
  /* 移除：單次「我給過了」不單獨觸發轉人工，避免過度升級 */
  if (intentMismatchLastRound(recent, primaryIntentOrderLookup === true)) {
    return { shouldHandoff: true, reason: "intent_mismatch" };
  }

  return { shouldHandoff: false };
}
