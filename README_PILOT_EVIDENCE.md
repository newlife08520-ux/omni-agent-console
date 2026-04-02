# Phase 1.6 Pilot Functional Evidence

經 `createAiReplyService().autoReplyWithAI` 主流程寫入 `ai_logs`（非 phase15 harness 注入）。

## 誠實標示（請於交付時勾選／填寫實際情況）

| 項目 | 本包預設 |
|------|----------|
| 環境 | **local**（或於 `PHASE16_ENV_LABEL` 自訂 staging 標籤） |
| `DATA_DIR` | **必須隔離**（空目錄）；腳本會寫入 `omnichannel.db` |
| `OPENAI_API_KEY` | **必須為真**（環境變數或專案根目錄 `.env` 之 `OPENAI_API_KEY`，腳本不會把金鑰寫進 JSON） |
| 主流程 | **是**，`ai-reply.service.ts` 之 `autoReplyWithAI` |
| Webhook | **否**（腳本直接呼叫服務，無 LINE／Meta webhook） |
| `tools_called` | **視路徑而定**（LLM／tool 迴圈或捷徑如 `return_form_first` 等；見 JSON 欄位） |
| 遮罩 | `result_summary` 僅前綴；不含 channel token／客戶原文全文 |

## 產出步驟

1. 新建空目錄，設定 **`DATA_DIR`**
2. 設定 **`OPENAI_API_KEY`** 或根目錄 **`.env`**
3. `npm run verify:phase16`
4. `_evidence_run/phase16/pilot_ai_logs_evidence.json` 與 `phase16_trace_summary_redacted.json`
5. `npm run zip:pilot-evidence` → **`PHASE1_PILOT_FUNCTIONAL_EVIDENCE.zip`**

## Zip 內容

- `pilot_ai_logs_evidence.json`（含 `route_source_summary`、`selected_scenario_summary`）
- `README_PILOT_EVIDENCE.md`
- 若成功跑 harness：`phase16_trace_summary_redacted.json`（遮罩後 trace 摘要）

四則情境：ORDER_LOOKUP、AFTER_SALES、PRODUCT_CONSULT、GENERAL。`route_source` 常為 **rule** 或 **legacy_fallback**；**llm** 需邊界句另測。
