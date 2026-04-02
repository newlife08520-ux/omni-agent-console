# Phase 1.6 Pilot Proof 摘要

## 1. 證據經由哪條主流程產生
- `server/phase16-pilot-proof-harness.ts` 呼叫 **`createAiReplyService({ ... }).autoReplyWithAI(...)`**，與 production 由 queue／`/internal/run-ai-reply` 觸發的同一實作。

## 2. 是否走到真 `ai-reply.service.ts` 主路徑
- **是**。未繞過 `autoReplyWithAI`；含 `buildReplyPlan`、`runHybridIntentRouter`／`mapPlanToPhase1Scenario`、`assembleEnrichedSystemPrompt`、工具白名單分支與（多數情境）OpenAI 呼叫。

## 3. 是否走到真 router 分支
- **是**。`hybrid_router: true` 時執行 `runHybridIntentRouter`；本腳本四則訊息在預設下多為 **硬規則或 legacy 映射**，故 `route_source` 常為 `rule` 或 `legacy_fallback`。若無邊界句實驗，**不一定**出現 `llm`。

## 4. 是否走到真 tool whitelist 分支
- **是**。`tool_whitelist: true` 時於 LLM 路徑對 `filterToolsForScenario` + `applyScenarioToolOverrides`；`tools_available_json` 與之一致。捷徑（如 `return_form_first`、`order_fast_path`）不經完整 tool loop，但仍透過 **`computePhase1TraceLogExtras`** 寫入與白名單一致的可用工具名稱列表。

## 5. 哪些欄位是真實落庫
- `matched_intent`、`selected_scenario`、`route_source`、`route_confidence`（若有）、`tools_available_json`、`response_source_trace`、`phase1_config_ref`；以及既有欄位 `tools_called`、`reply_source`、`plan_mode`、`used_llm`、`result_summary` 等（依該輪實際路徑）。

## 6. 哪些仍是 mock／stub／controlled input
- **受控**：pilot 品牌與渠道為腳本新建；訊息為固定四句；無真 LINE webhook。
- **非偽造**：`ai_logs` 列為 **`storage.createAiLog` 由主流程寫入**，非手寫 SQL 或純 JSON 冒充 DB。
- **Stub**：`broadcastSSE` 為 no-op；`channelToken` 為 null（不發真 LINE）。

## 7. 是否足以支持「單品牌 pilot」但不足以 merge main
- **足以**在「隔離 DATA_DIR + 單品牌 flags on + 主流程可重現」前提下支持 **isolated pilot** 論證。
- **仍不足以**無條件 merge main：多品牌、長尾渠道、線上負載與 LLM router 邊界仍待 staging／production 樣本與運維程序。

## 8. 取證檔與 bundle
- `PHASE1_PILOT_FUNCTIONAL_EVIDENCE.zip`：於具 **`OPENAI_API_KEY`** 之環境執行 `verify:phase16` 後再 `npm run zip:pilot-evidence` 產生（倉庫內可不提交該 zip）。
- `MULTI_BRAND_AGENT_OPS_IMPLEMENTATION_BUNDLE_V3.zip`：`npm run bundle:impl-v3`，內含完整 `verify_logs`（**含 `build.txt`**）與 `manifests/manifest.json` 的 `verify_logs` 清單對照。
