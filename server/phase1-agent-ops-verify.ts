/**
 * Phase 1 Multi-Brand Agent Ops：Hybrid Router、情境對照、Tool whitelist（純邏輯，無 API）。
 * 執行：npx tsx server/phase1-agent-ops-verify.ts
 */
import { runHybridIntentRouter, mapPlanToPhase1Scenario } from "./services/intent-router.service";
import { filterToolsForScenario, listToolNamesForScenario } from "./services/tool-scenario-filter";
import { parsePhase1BrandFlags, isPhase1Active } from "./services/phase1-brand-config";
import type { Brand } from "@shared/schema";

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

async function main() {
  const r1 = await runHybridIntentRouter({
    userMessage: "KBT58265",
    recentUserTexts: [],
    planMode: "answer_directly",
    primaryIntent: "general",
    issueType: null,
    apiKey: null,
  });
  ok("hard rule: order id -> ORDER_LOOKUP", r1.selected_scenario === "ORDER_LOOKUP" && r1.route_source === "rule");

  const r2 = await runHybridIntentRouter({
    userMessage: "我要退貨",
    recentUserTexts: [],
    planMode: "answer_directly",
    primaryIntent: "general",
    issueType: null,
    apiKey: null,
  });
  ok("hard rule: 退貨 -> AFTER_SALES", r2.selected_scenario === "AFTER_SALES");

  const r3 = await runHybridIntentRouter({
    userMessage: "這個尺寸有哪些",
    recentUserTexts: [],
    planMode: "answer_directly",
    primaryIntent: "general",
    issueType: null,
    apiKey: null,
  });
  ok("hard rule: 尺寸 -> PRODUCT_CONSULT", r3.selected_scenario === "PRODUCT_CONSULT");

  const r4 = await runHybridIntentRouter({
    userMessage: "你好 請問 沒有單號",
    recentUserTexts: [],
    planMode: "order_lookup",
    primaryIntent: "order_lookup",
    issueType: "order_inquiry",
    apiKey: null,
  });
  ok(
    "no rule + no apiKey -> legacy_fallback maps order plan",
    r4.route_source === "legacy_fallback" && r4.selected_scenario === "ORDER_LOOKUP"
  );

  const r5 = mapPlanToPhase1Scenario({
    userMessage: "hi",
    recentUserTexts: [],
    planMode: "answer_directly",
    primaryIntent: "chitchat",
    issueType: "general",
    apiKey: null,
  });
  ok("mapPlan only: GENERAL", r5.selected_scenario === "GENERAL" && r5.route_source === "legacy_plan_map");

  const prodTools = listToolNamesForScenario("PRODUCT_CONSULT", { hasImageAssets: false });
  ok(
    "PRODUCT_CONSULT whitelist excludes order lookup",
    !prodTools.some((n) => n.includes("lookup_order"))
  );

  const orderTools = listToolNamesForScenario("ORDER_LOOKUP", { hasImageAssets: false });
  ok("ORDER_LOOKUP has lookup_order_by_id", orderTools.includes("lookup_order_by_id"));

  const after = filterToolsForScenario("AFTER_SALES", { hasImageAssets: false });
  ok(
    "AFTER_SALES no order tools by default",
    !after.some((t) => t.type === "function" && String(t.function?.name).startsWith("lookup_order"))
  );

  const flagsOff = parsePhase1BrandFlags({} as Brand);
  ok("default flags: not active", !isPhase1Active(flagsOff));

  const flagsOn = parsePhase1BrandFlags({
    id: 1,
    phase1_agent_ops_json: JSON.stringify({
      enabled: true,
      hybrid_router: true,
      scenario_isolation: true,
      tool_whitelist: true,
      trace_v2: true,
    }),
  } as Brand);
  ok("pilot JSON: active", isPhase1Active(flagsOn) && flagsOn.hybrid_router);

  console.log(`\nphase1-agent-ops-verify: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
