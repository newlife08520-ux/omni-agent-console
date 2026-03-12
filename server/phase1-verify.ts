/**
 * Phase 1 可重播驗收：高風險拆級、明確真人 handoff、correction override。
 * 執行：npx tsx server/phase1-verify.ts（從專案根目錄）
 * 不啟動 server，僅驗證 state resolver、reply plan、與高風險關鍵字邏輯。
 */
import { resolveConversationState } from "./conversation-state-resolver";
import { buildReplyPlan } from "./reply-plan-builder";
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

console.log("\n---");
console.log(`Phase 1 驗收: ${passed} 通過, ${failed} 失敗`);
process.exit(failed > 0 ? 1 : 0);
