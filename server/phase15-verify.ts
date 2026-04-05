/**
 * Phase 1.5 驗證：router（含 mock LLM）、prompt 純度、tool、plan bridge、trace extras。
 * npx tsx server/phase15-verify.ts
 */
import { runHybridIntentRouter, computePhase15HardRoute, parseLlmIntentForTests } from "./services/intent-router.service";
import { buildReplyPlan, type PlanBuilderInput } from "./reply-plan-builder";
import { buildScenarioFlowBlock, buildFlowPrinciplesPrompt } from "./services/prompt-builder";
import { listToolNamesForScenario } from "./services/tool-scenario-filter";
import { buildPhase1AiLogExtras } from "./services/phase1-trace-extras";
import { parsePhase1BrandFlags, isPhase1Active } from "./services/phase1-brand-config";
import type { Brand } from "@shared/schema";
import type { ConversationState } from "./conversation-state-resolver";

let passed = 0;
let failed = 0;

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`[PASS] ${name}`);
  } else {
    failed++;
    console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function stubState(partial: Partial<ConversationState> & { primary_intent: string }): ConversationState {
  return {
    primary_intent: partial.primary_intent,
    return_reason_type: partial.return_reason_type ?? null,
    needs_human: partial.needs_human ?? false,
    human_reason: partial.human_reason ?? null,
    return_stage: partial.return_stage ?? null,
    customer_emotion: partial.customer_emotion ?? "neutral",
    product_scope_locked: partial.product_scope_locked ?? null,
  } as ConversationState;
}

async function main() {
  ok("SKU 無查單語境 不當成單號", computePhase15HardRoute("MODEL-XS-99")?.selected_scenario !== "ORDER_LOOKUP");

  ok("優惠碼語境 -> PRODUCT", computePhase15HardRoute("優惠碼 SAVE20")?.selected_scenario === "PRODUCT_CONSULT");

  ok("真單號 KBT", computePhase15HardRoute("KBT58265")?.selected_scenario === "ORDER_LOOKUP");

  ok("物流+退貨 售後優先", computePhase15HardRoute("物流還沒到我要退貨")?.selected_scenario === "AFTER_SALES");

  const llmOk = await runHybridIntentRouter({
    userMessage: "任意",
    recentUserTexts: [],
    planMode: "answer_directly",
    primaryIntent: "general",
    issueType: null,
    apiKey: null,
    mockLlmRawResponse: '{"intent":"PRODUCT_CONSULT","confidence":0.9}',
  });
  ok("mock LLM success", llmOk.route_source === "llm" && llmOk.selected_scenario === "PRODUCT_CONSULT");

  const llmBad = await runHybridIntentRouter({
    userMessage: "你好 請問 沒有單號",
    recentUserTexts: [],
    planMode: "order_lookup",
    primaryIntent: "order_lookup",
    issueType: "order_inquiry",
    apiKey: null,
    mockLlmRawResponse: "not json {{{",
  });
  ok("mock LLM parse fail -> legacy_fallback", llmBad.route_source === "legacy_fallback");

  ok("parseLlmIntentForTests ok", parseLlmIntentForTests('{"intent":"GENERAL","confidence":0.5}')?.intent === "GENERAL");

  const afterFlow = buildScenarioFlowBlock("AFTER_SALES", { returnFormUrl: "https://x.example/ret" });
  ok("AFTER_SALES iso flow 不含「有單號直接查」", !afterFlow.includes("有單號直接查"));
  const legacyFlow = buildFlowPrinciplesPrompt({ returnFormUrl: "https://x.example/ret" });
  ok("legacy flow 仍含查單／工具約束（flags off 路徑）", legacyFlow.includes("查單／售後") && legacyFlow.includes("transfer_to_human"));

  const genFlow = buildScenarioFlowBlock("GENERAL", {});
  ok("GENERAL flow 不含全系統查單步驟", !genFlow.includes("有單號直接查"));

  const prod = listToolNamesForScenario("PRODUCT_CONSULT", { hasImageAssets: false });
  ok("PRODUCT 無 lookup_order", !prod.some((n) => n.includes("lookup_order")));

  const bridgeInput: PlanBuilderInput = {
    state: stubState({ primary_intent: "product_consult" }),
    returnFormUrl: "https://x.example/r",
    latestUserMessage: "KBT99999",
    phase1PreRoute: {
      selected_scenario: "ORDER_LOOKUP",
      confidence: 0.9,
      matched_intent: "x",
      route_source: "rule",
    },
  };
  const bridged = buildReplyPlan(bridgeInput);
  ok("plan bridge: product_consult + 硬路由查單 -> order_lookup", bridged.mode === "order_lookup");

  const noBridge = buildReplyPlan({
    state: stubState({ primary_intent: "product_consult" }),
    returnFormUrl: "https://x.example/r",
    latestUserMessage: "MODEL-ABC",
    phase1PreRoute: {
      selected_scenario: "ORDER_LOOKUP",
      confidence: 0.9,
      matched_intent: "x",
      route_source: "rule",
    },
  });
  ok("plan bridge: 無單號信號 維持 answer_directly", noBridge.mode === "answer_directly");

  const flagsOff = parsePhase1BrandFlags({} as Brand);
  const extrasOff = buildPhase1AiLogExtras({
    phase1Flags: flagsOff,
    phase1Route: { selected_scenario: "ORDER_LOOKUP", matched_intent: "x", route_source: "rule", confidence: 1, used_llm_router: false },
    channelId: 1,
    toolsAvailableNames: ["a"],
    replySource: "x",
  });
  ok("flags off trace extras 空", Object.keys(extrasOff).length === 0);

  const flagsOn = parsePhase1BrandFlags({
    id: 1,
    phase1_agent_ops_json: JSON.stringify({
      enabled: true,
      trace_v2: true,
      hybrid_router: false,
      scenario_isolation: false,
      tool_whitelist: false,
    }),
  } as Brand);
  ok("trace_v2 on 有欄位", isPhase1Active(flagsOn) && "selected_scenario" in buildPhase1AiLogExtras({
    phase1Flags: flagsOn,
    phase1Route: { selected_scenario: "GENERAL", matched_intent: "g", route_source: "rule", confidence: 0.5, used_llm_router: false },
    channelId: null,
    toolsAvailableNames: ["transfer_to_human"],
    replySource: "llm",
  }));

  const ov = parsePhase1BrandFlags({
    id: 1,
    phase1_agent_ops_json: JSON.stringify({
      enabled: true,
      scenario_overrides: {
        ORDER_LOOKUP: { knowledge_mode: "none", prompt_append: "覆寫測試" },
      },
    }),
  } as Brand);
  ok("scenario_overrides 解析", ov.scenario_overrides?.ORDER_LOOKUP?.prompt_append === "覆寫測試");

  console.log(`\nphase15-verify: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
