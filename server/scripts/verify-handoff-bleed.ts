/**
 * 止血 5 題線上驗證：使用與 webhook 相同的 DB 設定與邏輯，跑完後輸出每題是否會 handoff 及來源。
 * 執行：從專案根目錄 npx tsx server/scripts/verify-handoff-bleed.ts
 * 需與 running instance 使用相同 DATA_DIR（或同一台機器的預設 DB）。
 */
import { storage } from "../storage";
import { resolveConversationState } from "../conversation-state-resolver";
import { buildReplyPlan } from "../reply-plan-builder";
import { shouldHandoffDueToAwkwardOrRepeat } from "../awkward-repeat-handoff";
import type { Contact } from "@shared/schema";

const PHRASES = ["在嗎", "人呢", "太誇張了", "很煩", "你有沒有看"];

const stubContact: Contact = {
  id: 0,
  platform: "line",
  platform_user_id: "verify-bleed",
  display_name: "Verify",
  avatar_url: null,
  needs_human: 1,
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

function main() {
  const raw = storage.getSetting("human_transfer_keywords");
  const HUMAN_KEYWORDS = raw
    ? raw.split(",").map((k) => k.trim()).filter(Boolean)
    : ["我要轉人工", "轉人工", "找真人客服", "找主管"];
  console.log("[verify-handoff-bleed] human_transfer_keywords 目前:", HUMAN_KEYWORDS.join(" | "));
  console.log("");

  const returnFormUrl = "https://example.com/returns";
  const results: { phrase: string; keywordHit: boolean; intent: string; needsHuman: boolean; awkward: boolean; planMode: string; source: string }[] = [];

  for (const phrase of PHRASES) {
    const keywordHit = HUMAN_KEYWORDS.some((kw) => phrase.includes(kw) || kw.includes(phrase));
    const state = resolveConversationState({
      contact: stubContact,
      userMessage: phrase,
      recentUserMessages: [],
      recentAiMessages: [],
    });
    const awkward = shouldHandoffDueToAwkwardOrRepeat({
      userMessage: phrase,
      recentMessages: [],
      primaryIntentOrderLookup: state.primary_intent === "order_lookup",
    });
    const plan = buildReplyPlan({ state, returnFormUrl, isReturnFirstRound: true });

    let source = "none";
    if (keywordHit) source = "webhook_keyword";
    else if (awkward.shouldHandoff) source = "awkward_repeat";
    else if (state.needs_human) source = "state_resolver";
    // 若本輪為 AI 可處理意圖，state 會清掉 needs_human，來源即 none

    results.push({
      phrase,
      keywordHit,
      intent: state.primary_intent,
      needsHuman: state.needs_human,
      awkward: awkward.shouldHandoff,
      planMode: plan.mode,
      source,
    });
  }

  console.log("止血 5 題結果（預期：皆不 handoff、不靜音、不送轉真人句）");
  console.log("─".repeat(100));
  const header = "句子\t關鍵字命中\t意圖\tneeds_human\tawkward\tplan.mode\t來源";
  console.log(header);
  for (const r of results) {
    const handoff = r.planMode === "handoff" || r.needsHuman;
    const line = `${r.phrase}\t${r.keywordHit}\t${r.intent}\t${r.needsHuman}\t${r.awkward}\t${r.planMode}\t${r.source}`;
    console.log(handoff ? line + "  ← 不應發生" : line);
  }
  console.log("─".repeat(100));

  const anyHandoff = results.some((r) => r.planMode === "handoff" || r.needsHuman);
  if (anyHandoff) {
    console.log("\n[FAIL] 至少一題會觸發 handoff/needs_human，請查上表「來源」欄位確認是哪一層設入。");
    process.exit(1);
  }
  console.log("\n[PASS] 五題皆未觸發 handoff，符合止血預期。");
  process.exit(0);
}

main();
