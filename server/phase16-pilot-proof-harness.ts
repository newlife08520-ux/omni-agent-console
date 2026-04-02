/**
 * Phase 1.6：單品牌 pilot proof — 經 createAiReplyService().autoReplyWithAI 主流程寫入 ai_logs（非 evidence harness 注入 scenario）。
 *
 * 前置：
 *   - 隔離 DATA_DIR（空目錄）
 *   - OPENAI_API_KEY：寫入 settings 並供主流程呼叫 OpenAI（無 key 則無法進入主路徑，腳本會 exit 2）
 *
 * PowerShell 範例：
 *   $d = Join-Path (Get-Location) "_evidence_run\phase16_db"; New-Item -ItemType Directory -Force $d | Out-Null
 *   $env:DATA_DIR = (Resolve-Path $d).Path
 *   $env:OPENAI_API_KEY = "<your-key>"
 *   npx tsx server/phase16-pilot-proof-harness.ts
 */
import fs from "fs";
import path from "path";
import { initDatabase } from "./db";
import { storage } from "./storage";
import { createToolExecutor } from "./services/tool-executor.service";
import { createAiReplyService } from "./services/ai-reply.service";
import { broadcastSSE } from "./services/sse.service";
import { pushLineMessage, sendFBMessage, getLineTokenForContact } from "./services/messaging.service";
import { getTransferUnavailableSystemMessage } from "./transfer-unavailable-message";

const noopBroadcast: typeof broadcastSSE = () => {};

/** 若環境變數未設，嘗試自專案根目錄 `.env` 讀取 OPENAI_API_KEY（不輸出金鑰）。 */
function tryLoadOpenAiKeyFromDotEnv(): void {
  if (process.env.OPENAI_API_KEY?.trim()) return;
  const envPath = path.join(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split(/\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    if (k !== "OPENAI_API_KEY") continue;
    let v = t.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (v) process.env.OPENAI_API_KEY = v;
    return;
  }
}

async function main() {
  tryLoadOpenAiKeyFromDotEnv();
  initDatabase();
  const dataDir = process.env.DATA_DIR || "";
  const apiKey = process.env.OPENAI_API_KEY?.trim() || "";
  if (!apiKey) {
    console.error(
      "[phase16-pilot] 缺少 OPENAI_API_KEY：autoReplyWithAI 在無 key 時會直接 return，無法產生主流程 ai_logs。請 export 金鑰或在專案根目錄建立 .env（含 OPENAI_API_KEY=...）後重跑。",
    );
    process.exit(2);
  }
  storage.setSetting("openai_api_key", apiKey);

  const slug = `pilot16_${Date.now()}`;
  const brand = await storage.createBrand(
    `Pilot16 ${slug.slice(-6)}`,
    slug,
    "",
    "",
    "你是友善的電商客服，回答簡短有禮。",
    "",
    "",
    "https://example.com/returns",
  );
  await storage.updateBrand(brand.id, {
    phase1_agent_ops_json: JSON.stringify({
      enabled: true,
      hybrid_router: true,
      scenario_isolation: true,
      tool_whitelist: true,
      trace_v2: true,
    }),
  });
  const channel = await storage.createChannel(brand.id, "line", "pilot16-line", undefined, "pilot_token", "pilot_secret");

  const toolExecutor = createToolExecutor({
    storage,
    pushLineMessage,
    sendFBMessage,
    broadcastSSE: noopBroadcast,
  });

  const { autoReplyWithAI } = createAiReplyService({
    storage,
    broadcastSSE: noopBroadcast,
    pushLineMessage,
    sendFBMessage,
    toolExecutor,
    getTransferUnavailableSystemMessage: (reason) => getTransferUnavailableSystemMessage(storage, reason),
    getLineTokenForContact,
  });

  const runs: { expectScenario: string; platformUserId: string; userText: string }[] = [
    {
      expectScenario: "ORDER_LOOKUP",
      platformUserId: `p16_order_${Date.now()}`,
      userText: "我要查訂單，單號 KBT58265",
    },
    {
      expectScenario: "AFTER_SALES",
      platformUserId: `p16_after_${Date.now()}`,
      userText: "我要退貨",
    },
    {
      expectScenario: "PRODUCT_CONSULT",
      platformUserId: `p16_prod_${Date.now()}`,
      userText: "這個背包有哪些尺寸可以選",
    },
    {
      expectScenario: "GENERAL",
      platformUserId: `p16_gen_${Date.now()}`,
      userText: "你好，謝謝你",
    },
  ];

  const rows: Record<string, unknown>[] = [];
  for (const run of runs) {
    const contact = storage.getOrCreateContact("line", run.platformUserId, "Pilot16User", brand.id, channel.id);
    storage.createMessage(contact.id, "line", "user", run.userText);
    await autoReplyWithAI(contact, run.userText, null, brand.id, "line");
    const logs = storage.getAiLogs(contact.id);
    const log = logs[0];
    if (!log) {
      console.error("[phase16-pilot] 無 ai_logs：", run.expectScenario, contact.id);
      process.exit(1);
    }
    if (String(log.selected_scenario) !== run.expectScenario) {
      console.error(
        `[phase16-pilot] selected_scenario 與預期不符：預期 ${run.expectScenario} 實際 ${log.selected_scenario}（訊息前綴：${run.userText.slice(0, 40)}）`,
      );
      process.exit(1);
    }
    rows.push({
      pilot_expect_scenario: run.expectScenario,
      user_text_redacted: run.userText.slice(0, 80),
      id: log.id,
      matched_intent: log.matched_intent ?? null,
      selected_scenario: log.selected_scenario ?? null,
      route_source: log.route_source ?? null,
      route_confidence: log.route_confidence ?? null,
      tools_available_json: log.tools_available_json ?? null,
      response_source_trace: log.response_source_trace ?? null,
      tools_called: log.tools_called ?? null,
      reply_source: log.reply_source ?? null,
      plan_mode: log.plan_mode ?? null,
      used_llm: log.used_llm ?? null,
      result_summary_prefix: (log.result_summary || "").slice(0, 120),
    });
  }

  const bad = rows.filter(
    (r) =>
      r.matched_intent === "evidence_harness" ||
      !r.selected_scenario ||
      !r.route_source ||
      !r.tools_available_json ||
      !r.response_source_trace,
  );
  if (bad.length > 0) {
    console.error("[phase16-pilot] 欄位不完整或仍像 harness：", JSON.stringify(bad, null, 2));
    process.exit(1);
  }

  const outDir = path.join(process.cwd(), "_evidence_run", "phase16");
  fs.mkdirSync(outDir, { recursive: true });

  const routeSourceSummary: Record<string, number> = {};
  const selectedScenarioSummary: Record<string, number> = {};
  for (const r of rows) {
    const rs = String(r.route_source ?? "?");
    routeSourceSummary[rs] = (routeSourceSummary[rs] || 0) + 1;
    const sc = String(r.selected_scenario ?? "?");
    selectedScenarioSummary[sc] = (selectedScenarioSummary[sc] || 0) + 1;
  }

  const traceRedacted = rows.map((r) => ({
    ai_log_id: r.id,
    pilot_expect_scenario: r.pilot_expect_scenario,
    matched_intent: r.matched_intent,
    selected_scenario: r.selected_scenario,
    route_source: r.route_source,
    route_confidence: r.route_confidence,
    response_source_trace: r.response_source_trace,
    reply_source: r.reply_source,
    plan_mode: r.plan_mode,
    used_llm: r.used_llm,
    tools_called_present: (() => {
      const tc = String(r.tools_called ?? "");
      return tc.length > 0 && tc !== "[]" && tc !== "null";
    })(),
  }));

  const summary = {
    data_dir: dataDir || "(default getDataDir)",
    data_dir_isolated: Boolean(dataDir.trim()),
    environment: process.env.PHASE16_ENV_LABEL?.trim() || "local",
    openai_api_key_used: true,
    webhook_used: false,
    flow: "createAiReplyService().autoReplyWithAI (ai-reply.service.ts)",
    pilot_brand_id: brand.id,
    channel_id: channel.id,
    route_source_summary: routeSourceSummary,
    selected_scenario_summary: selectedScenarioSummary,
    rows,
    note: "matched_intent 來自 intent-router / plan map，非 evidence_harness；result_summary 僅截取前綴；不含 token／完整客戶原文。",
  };
  fs.writeFileSync(path.join(outDir, "pilot_ai_logs_evidence.json"), JSON.stringify(summary, null, 2), "utf8");
  fs.writeFileSync(
    path.join(outDir, "phase16_trace_summary_redacted.json"),
    JSON.stringify({ trace_rows_redacted: traceRedacted, route_source_summary: routeSourceSummary }, null, 2),
    "utf8",
  );
  console.log("[phase16-pilot-proof] OK wrote", path.join(outDir, "pilot_ai_logs_evidence.json"));
  console.log("[phase16-pilot-proof] OK wrote", path.join(outDir, "phase16_trace_summary_redacted.json"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
