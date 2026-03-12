/**
 * Phase 1 可重播驗收：高風險拆級、明確真人 handoff、correction override、handoff 強制告知句。
 * 執行：npx tsx server/phase1-verify.ts（從專案根目錄）
 * 不啟動 server，僅驗證 state resolver、reply plan、與高風險關鍵字邏輯。
 */
import { resolveConversationState, isHumanRequestMessage, isAlreadyProvidedMessage } from "./conversation-state-resolver";
import { buildReplyPlan } from "./reply-plan-builder";
import { HANDOFF_MANDATORY_OPENING, buildHandoffReply } from "./phase2-output";
import { runPostGenerationGuard, isModeNoPromo, runOfficialChannelGuard } from "./content-guard";
import { searchOrderInfoInRecentMessages } from "./already-provided-search";
import type { Contact } from "@shared/schema";

const LEGAL_RISK_KEYWORDS = [
  "投訴", "客訴", "消保", "消費者保護", "消基會", "法律", "律師", "告你", "告你們",
  "提告", "訴訟", "報警", "警察", "公平會", "媒體", "爆料", "上新聞", "找記者",
  "詐騙", "騙子", "去死",
];
const FRUSTRATED_ONLY_KEYWORDS = [
  "爛", "很煩", "很慢", "不爽", "靠北", "幹", "他媽", "媽的", "狗屎",
  "垃圾", "廢物", "噁心", "極度不滿", "非常生氣", "太扯", "離譜", "白痴", "智障",
];

function detectHighRisk(text: string): { level: "legal_risk" | "frustrated_only" | "none" } {
  for (const kw of LEGAL_RISK_KEYWORDS) {
    if (text.includes(kw)) return { level: "legal_risk" };
  }
  for (const kw of FRUSTRATED_ONLY_KEYWORDS) {
    if (text.includes(kw)) return { level: "frustrated_only" };
  }
  return { level: "none" };
}

const stubContact = {
  id: 0,
  platform: "line",
  platform_user_id: "test",
  display_name: "Test",
  avatar_url: null,
  needs_human: 0,
  is_pinned: 0,
  status: "pending",
  tags: "[]",
  vip_level: 0,
  order_count: 0,
  total_spent: 0,
  cs_rating: null,
  ai_rating: null,
  last_message_at: null,
  created_at: new Date().toISOString(),
  brand_id: 1,
  channel_id: null,
  issue_type: null,
  order_source: null,
  assigned_agent_id: null,
  assigned_at: null,
} as unknown as Contact;

const returnFormUrl = "https://example.com/returns";
let passed = 0;
let failed = 0;

function ok(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++;
    console.log(`[PASS] ${name}${detail ? ` ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`[FAIL] ${name}${detail ? ` ${detail}` : ""}`);
  }
}

// A: 爛 → 不得 legal_risk（高風險拆級）
const riskA = detectHighRisk("你們東西很爛");
ok("A. 你們東西很爛 不為 legal_risk", riskA.level !== "legal_risk", `level=${riskA.level}`);

// B: 提告/消保 → 必須 legal_risk
const riskB1 = detectHighRisk("我要提告");
const riskB2 = detectHighRisk("我要找消保官");
ok("B1. 我要提告 → legal_risk", riskB1.level === "legal_risk");
ok("B2. 我要找消保官 → legal_risk", riskB2.level === "legal_risk");

// C: 能轉人工嗎 → handoff
const stateC = resolveConversationState({
  contact: stubContact,
  userMessage: "能轉人工嗎",
  recentUserMessages: [],
  recentAiMessages: [],
});
const planC = buildReplyPlan({ state: stateC, returnFormUrl, isReturnFirstRound: true });
ok("C. 能轉人工嗎 → human_request + handoff", stateC.primary_intent === "human_request" && planC.mode === "handoff");

// D: 人呢 → handoff
const stateD = resolveConversationState({
  contact: stubContact,
  userMessage: "人呢",
  recentUserMessages: [],
  recentAiMessages: [],
});
const planD = buildReplyPlan({ state: stateD, returnFormUrl, isReturnFirstRound: true });
ok("D. 人呢 → human_request + handoff", stateD.primary_intent === "human_request" && planD.mode === "handoff");

// E: 說錯，我要查出貨速度（前句退貨）→ 覆蓋為 order_lookup
const stateE = resolveConversationState({
  contact: stubContact,
  userMessage: "說錯，我要查出貨速度",
  recentUserMessages: ["我要退貨"],
  recentAiMessages: [],
});
const planE = buildReplyPlan({ state: stateE, returnFormUrl, isReturnFirstRound: true });
ok("E. correction override → order_lookup", stateE.primary_intent === "order_lookup" && planE.mode === "order_lookup");

// F: 我訂很久了很煩不要了幫我轉人工 → 只走 handoff
const stateF = resolveConversationState({
  contact: stubContact,
  userMessage: "我訂很久了很煩不要了幫我轉人工",
  recentUserMessages: [],
  recentAiMessages: [],
});
const planF = buildReplyPlan({ state: stateF, returnFormUrl, isReturnFirstRound: true });
ok("F. 混句含轉人工 → handoff", stateF.primary_intent === "human_request" && planF.mode === "handoff");

// Handoff 強制告知句：回覆必須明確含「轉接真人專員」或「請稍後」
const handoffReplyOpening = HANDOFF_MANDATORY_OPENING;
ok("G. handoff 固定句含轉接真人專員", /轉接真人專員|真人專員.*處理/.test(handoffReplyOpening));
ok("H. handoff 固定句含請稍後", /請稍後|稍候/.test(handoffReplyOpening));

// 我要找真人客服、我要找主管 → handoff，且 buildHandoffReply 產出含固定語意
const stateG = resolveConversationState({
  contact: stubContact,
  userMessage: "我要找真人客服",
  recentUserMessages: [],
  recentAiMessages: [],
});
const planG = buildReplyPlan({ state: stateG, returnFormUrl, isReturnFirstRound: true });
const stateH = resolveConversationState({
  contact: stubContact,
  userMessage: "我要找主管",
  recentUserMessages: [],
  recentAiMessages: [],
});
const planH = buildReplyPlan({ state: stateH, returnFormUrl, isReturnFirstRound: true });
ok("I. 我要找真人客服 → handoff", stateG.primary_intent === "human_request" && planG.mode === "handoff");
ok("J. 我要找主管 → handoff", stateH.primary_intent === "human_request" && planH.mode === "handoff");
const replyExplicit = buildHandoffReply({ customerEmotion: "neutral", humanReason: "explicit_human_request" });
ok("K. handoff 回覆明確告知（不可模糊）", /轉接真人專員|真人專員.*協助/.test(replyExplicit) && !/已安排處理|會協助您|幫您處理中/.test(replyExplicit));

// --- Hotfix 驗收 A～E ---
// A. 貼圖 + 「可以幫我轉人工嗎」→ 必須 handoff，不可先圖片模板（routes 會因 isHumanRequestMessage 跳過圖片分支）
ok("Hotfix A. 可以幫我轉人工嗎 → isHumanRequestMessage + handoff", isHumanRequestMessage("可以幫我轉人工嗎") && (() => {
  const s = resolveConversationState({ contact: stubContact, userMessage: "可以幫我轉人工嗎", recentUserMessages: [], recentAiMessages: [] });
  const p = buildReplyPlan({ state: s, returnFormUrl, isReturnFirstRound: true });
  return s.primary_intent === "human_request" && p.mode === "handoff";
})());

// B. 「我要取消訂單」+ 近期已給單號 → 不重問（依賴 prompt 官方渠道 guard + already_provided 注入；E2E 驗證）
// C. 「你拿過了」「我就給過了」→ 觸發 already_provided 規則
ok("Hotfix C. 你拿過了 → isAlreadyProvidedMessage", isAlreadyProvidedMessage("你拿過了"));
ok("Hotfix C. 我就給過了 → isAlreadyProvidedMessage", isAlreadyProvidedMessage("我就給過了"));

// D. 「煩死了」+ 轉人工 → handoff 只一則（由 handoff_short_circuit 保證）
const stateD2 = resolveConversationState({
  contact: stubContact,
  userMessage: "煩死了我要轉人工",
  recentUserMessages: [],
  recentAiMessages: [],
});
const planD2 = buildReplyPlan({ state: stateD2, returnFormUrl, isReturnFirstRound: true });
ok("Hotfix D. 煩死了我要轉人工 → handoff", stateD2.primary_intent === "human_request" && planD2.mode === "handoff");

// --- E2E 案例 A～E（本輪 Hotfix 補齊）---
// A. 官方 LINE + 取消訂單：回覆不得出現「是否官方下單」
const e2eA = runOfficialChannelGuard("請問您是否官方下單？若是的話可以幫您取消。");
ok("E2E A. 官方渠道回覆含「是否官方下單」→ 違規清洗", !e2eA.pass && e2eA.reason === "official_channel_forbidden");

// B. 官方 LINE + 查單：回覆不得出現「若是其他平台購買」
const e2eB = runOfficialChannelGuard("若是其他平台購買建議找該平台客服。");
ok("E2E B. 官方渠道回覆含「其他平台」→ 違規清洗", !e2eB.pass);

// C. 貼圖 + 轉人工：以「轉人工」為代表，須走 handoff、不先出其他流程
const stateC2 = resolveConversationState({ contact: stubContact, userMessage: "轉人工", recentUserMessages: [], recentAiMessages: [] });
const planC2 = buildReplyPlan({ state: stateC2, returnFormUrl, isReturnFirstRound: true });
ok("E2E C. 貼圖/轉人工情境 → handoff", stateC2.primary_intent === "human_request" && planC2.mode === "handoff");

// D. 我給過了 + 有單號：三層搜尋 Layer 1 能從近期文字抽到訂單編號
const layer1Found = searchOrderInfoInRecentMessages([
  { sender_type: "user", content: "我給過了" },
  { sender_type: "user", content: "訂單編號是 SL-2024-001" },
]);
ok("E2E D. 我給過了 + 近期文字有單號 → Layer 1 命中", layer1Found.orderId === "SL-2024-001");
// Layer 3（linked order）由 contact_order_links 提供，整合測試需 DB；圖片單號為 Layer 2 vision，已實作

// E. return/cancel 場景不得混入商品知識
const e2eE = runPostGenerationGuard("先填退貨表單。這款高密度泡附著很熱銷，推薦您下次再買。", "return_form_first", null);
ok("E2E E. return 回覆含商品知識/推薦 → 違規", !e2eE.pass && e2eE.reason?.includes("mode_forbidden"));

// --- Knowledge Gating / Post-Generation Guard 驗收（Hotfix 規格 6）---
// A. 清潔用品訂單問出貨 → 回覆不得含甜點較快
const guardA = runPostGenerationGuard("您的訂單甜點較快會出貨喔", "order_lookup", "cleaning");
ok("KG-A. 清潔 scope 回覆含甜點較快 → 違規", !guardA.pass && guardA.reason?.includes("category_mismatch"));

// B/C. 客戶說退貨/取消 → 回覆不得含商品賣點/價格組合/推薦
const guardB = runPostGenerationGuard("先填表單。這款高密度泡附著很熱銷喔", "return_form_first", null);
ok("KG-B. return mode 回覆含賣點/熱銷 → 違規", !guardB.pass && guardB.reason?.includes("mode_forbidden"));

const guardC = runPostGenerationGuard("了解，推薦您先查訂單再取消", "order_lookup", null);
ok("KG-C. order_lookup 回覆含推薦 → 違規", !guardC.pass && guardC.reason?.includes("mode_forbidden"));

// D. 包包客戶 → 回覆不得提甜點
const guardD = runPostGenerationGuard("您的包包訂單約 7–20 工作天；甜點通常比較快", "order_lookup", "bag");
ok("KG-D. bag scope 回覆含甜點 → 違規", !guardD.pass && guardD.reason?.includes("category_mismatch"));

// E. 甜點客戶才允許講甜點較快（非甜點不得出現；甜點出現時 guard 不因品類擋）
const guardE = runPostGenerationGuard("甜點通常較快，約 3 天內出貨", "order_lookup", "sweet");
ok("KG-E. sweet scope 回覆含甜點較快 → 通過", guardE.pass);

// F. return/cancel/handoff/order_lookup 回覆含 promo/upsell → 驗收 fail
ok("KG-F. handoff 屬 no-promo mode", isModeNoPromo("handoff"));
ok("KG-F. return_form_first 屬 no-promo mode", isModeNoPromo("return_form_first"));
ok("KG-F. order_lookup 屬 no-promo mode", isModeNoPromo("order_lookup"));
const guardF = runPostGenerationGuard("這邊幫您備註加急。限時優惠組合價要參考嗎？", "aftersales_comfort_first", null);
ok("KG-F. aftersales 回覆含優惠/組合價 → 違規", !guardF.pass);

console.log("\n---");
console.log(`Phase 1 驗收: ${passed} 通過, ${failed} 失敗`);
process.exit(failed > 0 ? 1 : 0);
