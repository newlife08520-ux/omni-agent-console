/**
 * Phase 1.5 取證：走 storage.createAiLog + buildPhase1AiLogExtras 正式路徑。
 * PowerShell:
 *   $d = Join-Path (Get-Location) "_evidence_run\phase15_db"; New-Item -ItemType Directory -Force $d | Out-Null
 *   $env:DATA_DIR = (Resolve-Path $d).Path
 *   npx tsx server/phase15-evidence-harness.ts
 */
import fs from "fs";
import path from "path";
import { initDatabase } from "./db";
import { storage } from "./storage";
import { buildPhase1AiLogExtras } from "./services/phase1-trace-extras";
import { parsePhase1BrandFlags } from "./services/phase1-brand-config";
import type { AgentScenario, HybridRouteResult } from "./services/phase1-types";
import type { Brand } from "@shared/schema";

const SCENARIOS: AgentScenario[] = ["ORDER_LOOKUP", "AFTER_SALES", "PRODUCT_CONSULT", "GENERAL"];

async function main() {
  initDatabase();
  const dataDir = process.env.DATA_DIR || "";
  const outDir = path.join(process.cwd(), "_evidence_run", "phase15");
  fs.mkdirSync(outDir, { recursive: true });

  const flags = parsePhase1BrandFlags({
    id: 1,
    phase1_agent_ops_json: JSON.stringify({
      enabled: true,
      hybrid_router: true,
      scenario_isolation: true,
      tool_whitelist: true,
      trace_v2: true,
    }),
  } as Brand);

  const contact = storage.getOrCreateContact("line", `phase15_evidence_${Date.now()}`, "Phase15Evidence", 1, undefined);

  const written: Record<string, unknown>[] = [];
  for (const sc of SCENARIOS) {
    const route: HybridRouteResult = {
      selected_scenario: sc,
      matched_intent: "evidence_harness",
      route_source: "rule",
      confidence: 0.88,
      used_llm_router: false,
    };
    const toolsAvailable =
      sc === "ORDER_LOOKUP" ? ["lookup_order_by_id", "transfer_to_human"] : ["transfer_to_human"];
    const row = storage.createAiLog({
      contact_id: contact.id,
      brand_id: 1,
      prompt_summary: `phase15_evidence:${sc}`,
      knowledge_hits: [],
      tools_called: ["evidence_harness"],
      transfer_triggered: false,
      result_summary: `masked_ok scenario=${sc}`,
      token_usage: 0,
      model: "phase15_evidence",
      response_time_ms: 2,
      reply_source: "evidence_harness",
      used_llm: 0,
      plan_mode: "answer_directly",
      reason_if_bypassed: null,
      ...buildPhase1AiLogExtras({
        phase1Flags: flags,
        phase1Route: route,
        channelId: contact.channel_id,
        toolsAvailableNames: toolsAvailable,
        replySource: "evidence_harness",
      }),
    });
    written.push({
      id: row.id,
      selected_scenario: row.selected_scenario,
      route_source: row.route_source,
      matched_intent: row.matched_intent,
      tools_available_json: row.tools_available_json,
      response_source_trace: row.response_source_trace,
      tools_called: row.tools_called,
    });
  }

  const summary = {
    data_dir: dataDir || "(default getDataDir)",
    contact_id: contact.id,
    rows: written,
    note: "PII-free; result_summary masked_ok",
  };
  fs.writeFileSync(path.join(outDir, "phase15_ai_logs_evidence.json"), JSON.stringify(summary, null, 2), "utf8");
  console.log("[phase15-evidence-harness] wrote", path.join(outDir, "phase15_ai_logs_evidence.json"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
