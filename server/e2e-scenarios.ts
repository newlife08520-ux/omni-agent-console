/**
 * 多輪 E2E 壓測：6 組情境，每組 2～3 輪，驗證 guard 與流程。
 * 使用 mock 回覆 + 真實 state/plan/guard 管線，不依賴真實 LLM。
 * 執行：npx tsx server/e2e-scenarios.ts
 */
import type { Contact } from "@shared/schema";
import { resolveConversationState } from "./conversation-state-resolver";
import { buildReplyPlan } from "./reply-plan-builder";
import { runPostGenerationGuard, runOfficialChannelGuard } from "./content-guard";
import { buildHandoffReply } from "./phase2-output";
import { searchOrderInfoThreeLayers } from "./already-provided-search";
import { resetGuardStats, getGuardStats, recordGuardHit } from "./content-guard-stats";

const returnFormUrl = "https://example.com/returns";

function stubContact(
  overrides: Partial<Contact> & { product_scope_locked?: string | null; channel_id?: number | null } = {}
): Contact {
  return {
    id: 1,
    platform: "line",
    platform_user_id: "e2e-test",
    display_name: "E2E",
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
    ...overrides,
  } as Contact;
}

type Turn = { userMessage: string; mockRawReply: string };
type Scenario = {
  id: string;
  name: string;
  contact: Contact;
  turns: Turn[];
  /** 最終回覆不得包含（任一命中即 FAIL） */
  mustNotContain?: string[];
  /** 最終回覆須包含（可選） */
  mustContain?: string[];
  /** 預期 plan.mode（最後一輪） */
  expectMode?: string;
  /** 預期為 handoff 固定句（不比較內容，只檢查開頭） */
  expectHandoff?: boolean;
  /** 我給過了：預期三層搜尋有找到，不轉真人 */
  expectAlreadyProvidedFound?: boolean;
};

function runGuards(
  reply: string,
  planMode: string,
  productScope: string | null,
  hasOfficialChannel: boolean
): string {
  let text = reply || "";
  const r1 = runPostGenerationGuard(text, planMode as any, productScope);
  if (!r1.pass) {
    const useCleaned = !!(r1.cleaned && r1.cleaned.trim());
    text = useCleaned ? r1.cleaned : "了解，這邊幫您記錄，稍後由專人為您處理。";
    const outcome = useCleaned ? "cleaned" : "fallback";
    for (const r of (r1.reason || "").split(";").filter(Boolean)) {
      recordGuardHit(r as import("./content-guard-stats").GuardRuleId, outcome);
    }
  }
  if (hasOfficialChannel) {
    const r2 = runOfficialChannelGuard(text);
    if (!r2.pass) {
      const useCleaned = !!(r2.cleaned && r2.cleaned.trim());
      text = useCleaned ? r2.cleaned : "了解，這邊幫您處理，請稍候。";
      recordGuardHit("official_channel_forbidden", useCleaned ? "cleaned" : "fallback");
    }
  }
  return text;
}

async function runScenario(s: Scenario): Promise<{ pass: boolean; detail: string; finalReply: string; planMode: string }> {
  const recentUserMessages: string[] = [];
  const recentAiMessages: string[] = [];
  let lastReply = "";
  let lastPlanMode = "";

  for (let i = 0; i < s.turns.length; i++) {
    const turn = s.turns[i];
    const state = resolveConversationState({
      contact: s.contact,
      userMessage: turn.userMessage,
      recentUserMessages,
      recentAiMessages,
    });
    const plan = buildReplyPlan({ state, returnFormUrl, isReturnFirstRound: i === 0 });
    lastPlanMode = plan.mode;

    if (plan.mode === "handoff") {
      lastReply = buildHandoffReply({ customerEmotion: state.customer_emotion, humanReason: state.human_reason ?? undefined });
    } else {
      const productScope = s.contact.product_scope_locked ?? null;
      lastReply = runGuards(turn.mockRawReply, plan.mode, productScope, !!s.contact.channel_id);
    }
    recentUserMessages.push(turn.userMessage);
    recentAiMessages.push(lastReply);
  }

  // 特殊：我給過了 + 有單號
  if (s.expectAlreadyProvidedFound !== undefined) {
    const lastTurn = s.turns[s.turns.length - 1];
    const recentMessages = recentUserMessages.map((u, i) => ({
      sender_type: "user" as const,
      content: u,
      message_type: "text" as const,
      image_url: null as string | null,
    }));
    // 在「我給過了」前加一則有單號的訊息
    const withOrder = [
      ...recentMessages.slice(0, -1),
      { sender_type: "user" as const, content: "訂單號 SL-E2E-001", message_type: "text" as const, image_url: null as string | null },
      { sender_type: "user" as const, content: lastTurn.userMessage, message_type: "text" as const, image_url: null as string | null },
    ];
    const found = await searchOrderInfoThreeLayers(s.contact.id, withOrder, {
      imageFileToDataUri: async () => null,
      openai: null,
    });
    const foundOk = s.expectAlreadyProvidedFound ? (found != null && (found.orderId || found.phone)) : (found == null || (!found.orderId && !found.phone));
    if (!foundOk) {
      return {
        pass: false,
        detail: `expectAlreadyProvidedFound=${s.expectAlreadyProvidedFound} but found=${found ? JSON.stringify(found) : "null"}`,
        finalReply: lastReply,
        planMode: lastPlanMode,
      };
    }
  }

  if (s.expectHandoff) {
    const ok = /轉接真人專員|真人專員.*處理|請稍後/.test(lastReply) && lastReply.length < 200;
    return { pass: ok, detail: ok ? "handoff 單則" : `handoff 句不符或過長: ${lastReply.slice(0, 80)}`, finalReply: lastReply, planMode: lastPlanMode };
  }
  if (s.expectMode && lastPlanMode !== s.expectMode) {
    return { pass: false, detail: `expectMode=${s.expectMode} got ${lastPlanMode}`, finalReply: lastReply, planMode: lastPlanMode };
  }
  if (s.mustNotContain?.length) {
    for (const phrase of s.mustNotContain) {
      if (lastReply.includes(phrase)) {
        return { pass: false, detail: `回覆不得含「${phrase}」`, finalReply: lastReply, planMode: lastPlanMode };
      }
    }
  }
  if (s.mustContain?.length) {
    for (const phrase of s.mustContain) {
      if (!lastReply.includes(phrase)) {
        return { pass: false, detail: `回覆須含「${phrase}」`, finalReply: lastReply, planMode: lastPlanMode };
      }
    }
  }
  return { pass: true, detail: "OK", finalReply: lastReply, planMode: lastPlanMode };
}

const SCENARIOS: Scenario[] = [
  {
    id: "1",
    name: "清潔用品查出貨（不得出現甜點話術）",
    contact: stubContact({ product_scope_locked: "cleaning" }),
    turns: [
      { userMessage: "我買了清潔用品，什麼時候出貨？", mockRawReply: "您的訂單約 3 天內出貨，甜點通常比較快喔，清潔類約 7–20 工作天。" },
    ],
    mustNotContain: ["甜點", "甜點較快", "甜點通常", "3 天內出貨"],
  },
  {
    id: "2a",
    name: "我要退貨（不得混入產品賣點/價格組合）",
    contact: stubContact(),
    turns: [
      { userMessage: "我要退貨", mockRawReply: "先填寫退貨表單。這款高密度泡附著很熱銷，推薦您下次再買；規格組合不同價格可以參考官網。" },
    ],
    mustNotContain: ["高密度", "熱銷", "推薦", "規格組合", "不同價格"],
  },
  {
    id: "2b",
    name: "我要取消（不得混入賣點/推薦）",
    contact: stubContact(),
    turns: [
      { userMessage: "我要取消訂單", mockRawReply: "了解，幫您處理取消。這款限時優惠組合價很超值，要考慮留下嗎？" },
    ],
    mustNotContain: ["限時優惠", "組合價", "超值", "考慮留下"],
  },
  {
    id: "3",
    name: "圖片 + 我給過了（三層搜尋有單號則不重問）",
    contact: stubContact(),
    turns: [
      { userMessage: "我給過了", mockRawReply: "好的，已收到。" },
    ],
    expectAlreadyProvidedFound: true,
  },
  {
    id: "4a",
    name: "官方 LINE 查單（不得問是否官方/其他平台）",
    contact: stubContact({ channel_id: 1 }),
    turns: [
      { userMessage: "幫我查訂單", mockRawReply: "請問您是否官方下單？若是其他平台購買建議找該平台客服。" },
    ],
    mustNotContain: ["是否官方下單", "其他平台購買", "該平台客服"],
  },
  {
    id: "4b",
    name: "官方 LINE 取消（不得問官方通路）",
    contact: stubContact({ channel_id: 1 }),
    turns: [
      { userMessage: "我要取消", mockRawReply: "若您是透過官方通路下單可以幫您取消；若非官方請找該平台。" },
    ],
    mustNotContain: ["官方通路", "若非官方", "該平台"],
  },
  {
    id: "5",
    name: "轉人工 + 情緒差（只出一則轉真人句）",
    contact: stubContact(),
    turns: [
      { userMessage: "煩死了我要轉人工", mockRawReply: "" },
    ],
    expectHandoff: true,
    expectMode: "handoff",
  },
  {
    id: "6",
    name: "甜點客人問出貨（允許甜點較快）",
    contact: stubContact({ product_scope_locked: "sweet" }),
    turns: [
      { userMessage: "甜點什麼時候出貨？", mockRawReply: "甜點通常較快，約 3 天內出貨；若有現貨會盡快安排。" },
    ],
    mustContain: ["甜點"], // 甜點場景允許甜點話術，guard 不應洗掉
  },
];

async function main() {
  resetGuardStats();
  console.log("===== 多輪 E2E 壓測（6 組情境）=====\n");

  let passed = 0;
  let failed = 0;
  const results: { id: string; name: string; pass: boolean; detail: string }[] = [];

  for (const s of SCENARIOS) {
    const { pass, detail } = await runScenario(s);
    results.push({ id: s.id, name: s.name, pass, detail });
    if (pass) {
      passed++;
      console.log(`[PASS] ${s.id}. ${s.name}`);
    } else {
      failed++;
      console.log(`[FAIL] ${s.id}. ${s.name} — ${detail}`);
    }
  }

  console.log("\n----- E2E 案例逐筆 -----");
  results.forEach((r) => console.log(`${r.pass ? "PASS" : "FAIL"} ${r.id} ${r.name} ${r.detail}`));
  console.log(`\n合計: ${passed} 通過, ${failed} 失敗`);

  const stats = getGuardStats();
  console.log("\n----- Content-Guard 命中統計（本輪 E2E 觸發）-----");
  console.log("totalHits:", stats.totalHits);
  console.log("byRule:", JSON.stringify(stats.byRule, null, 2));
  console.log("byOutcome:", stats.byOutcome);
  console.log("samplePeriod:", stats.samplePeriod);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
