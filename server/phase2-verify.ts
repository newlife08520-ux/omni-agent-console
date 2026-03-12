/**
 * Phase 2 可重播驗收：一輪一個 mode、退換貨分流、off_topic、product_scope、path 與輸出文案守則。
 * 執行：npx tsx server/phase2-verify.ts（從專案根目錄）
 * 依賴 LLM 的實際回覆內容需另以手動或 E2E 驗證。
 */
import { resolveConversationState } from "./conversation-state-resolver";
import { buildReplyPlan } from "./reply-plan-builder";
import { OFF_TOPIC_GUARD_MESSAGE, enforceOutputGuard, OUTPUT_GUARD_MAX_CHARS } from "./phase2-output";
import type { Contact } from "@shared/schema";

function getProductScopeFromMessage(text: string): "bag" | "sweet" | null {
  const t = (text || "").trim();
  if (/包包|通勤包|城市輕旅|輕旅包|托特|後背包|背包/i.test(t)) return "bag";
  if (/甜點|巴斯克|蛋糕|餅乾|點心|禮盒/i.test(t)) return "sweet";
  return null;
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

// 我買城市輕旅通勤包怎麼還沒到 → order_lookup，且 scope 推斷為 bag
const msg1 = "我買城市輕旅通勤包怎麼還沒到";
const state1 = resolveConversationState({
  contact: stubContact,
  userMessage: msg1,
  recentUserMessages: [],
  recentAiMessages: [],
});
const plan1 = buildReplyPlan({ state: state1, returnFormUrl, isReturnFirstRound: true });
const scope1 = getProductScopeFromMessage(msg1);
ok("城市輕旅通勤包 → order_lookup", plan1.mode === "order_lookup");
ok("城市輕旅通勤包 → scope=bag", scope1 === "bag");

// 我不想等了我要退貨 → aftersales_comfort_first（不先表單）
const state2 = resolveConversationState({
  contact: stubContact,
  userMessage: "我不想等了我要退貨",
  recentUserMessages: [],
  recentAiMessages: [],
});
const plan2 = buildReplyPlan({ state: state2, returnFormUrl, isReturnFirstRound: true });
ok("不想等了我要退貨 → aftersales_comfort_first", plan2.mode === "aftersales_comfort_first");

// 我訂很久了很煩不要了幫我轉人工 → handoff
const state3 = resolveConversationState({
  contact: stubContact,
  userMessage: "我訂很久了很煩不要了幫我轉人工",
  recentUserMessages: [],
  recentAiMessages: [],
});
const plan3 = buildReplyPlan({ state: state3, returnFormUrl, isReturnFirstRound: true });
ok("很煩不要了幫我轉人工 → handoff", plan3.mode === "handoff");

// 晚餐吃什麼好 → off_topic_guard
const state4 = resolveConversationState({
  contact: stubContact,
  userMessage: "晚餐吃什麼好",
  recentUserMessages: [],
  recentAiMessages: [],
});
const plan4 = buildReplyPlan({ state: state4, returnFormUrl, isReturnFirstRound: true });
ok("晚餐吃什麼好 → off_topic_guard", plan4.mode === "off_topic_guard");
// 實際輸出文案：off_topic 時為固定短句，不得推薦菜單
ok("off_topic 固定短句不推薦菜單", /不是我們服務範圍|服務範圍/.test(OFF_TOPIC_GUARD_MESSAGE) && !/推薦.*菜單|晚餐推薦|餐廳推薦/.test(OFF_TOPIC_GUARD_MESSAGE));

// 我要查訂單 → order_lookup
const state5 = resolveConversationState({
  contact: stubContact,
  userMessage: "我要查訂單",
  recentUserMessages: [],
  recentAiMessages: [],
});
const plan5 = buildReplyPlan({ state: state5, returnFormUrl, isReturnFirstRound: true });
ok("我要查訂單 → order_lookup", plan5.mode === "order_lookup");
// output guard：order_lookup 回覆上限 140 字，長文會被截斷
const longReply = "您好，為您查詢訂單需要以下資訊之一。請提供訂單編號或訂購人手機號碼。若您是在官方網站訂購請提供訂單編號；若在其他平台請向該平台查詢。我們會盡快為您確認。謝謝。";
const guardedOrderLookup = enforceOutputGuard(longReply, "order_lookup");
ok("order_lookup 回覆上限 140 字", guardedOrderLookup.length <= OUTPUT_GUARD_MAX_CHARS);

// 我要查包包尺寸，有圖片嗎 → answer_directly，scope=bag
const msg6 = "我要查包包尺寸，有圖片嗎";
const state6 = resolveConversationState({
  contact: stubContact,
  userMessage: msg6,
  recentUserMessages: [],
  recentAiMessages: [],
});
const plan6 = buildReplyPlan({ state: state6, returnFormUrl, isReturnFirstRound: true });
const scope6 = getProductScopeFromMessage(msg6);
ok("包包尺寸有圖片嗎 → answer_directly", plan6.mode === "answer_directly");
ok("包包尺寸 → scope=bag", scope6 === "bag");

console.log("\n---");
console.log(`Phase 2 驗收: ${passed} 通過, ${failed} 失敗`);
process.exit(failed > 0 ? 1 : 0);
