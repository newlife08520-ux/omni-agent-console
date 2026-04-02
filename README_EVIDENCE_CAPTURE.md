# Phase 1.5 Functional Evidence 取證說明

與 `_evidence_run/phase15/README_EVIDENCE_CAPTURE.md` 相同；便于在 repo 根目錄發現。

## 性質
- **類型 B**：`storage.createAiLog` + `buildPhase1AiLogExtras` 正式寫入路徑；情境路由物件為取證腳本注入（非手寫旁路 JSON 檔充當 DB）。
- **隔離 DB**：請先設定 `DATA_DIR` 指向空目錄，再執行 `npx tsx server/phase15-evidence-harness.ts`，避免污染主庫。

## 產物
- `PHASE1_FUNCTIONAL_EVIDENCE.zip`：內含 `phase15_ai_logs_evidence.json` 與說明（自 `_evidence_run/phase15` 打包；可 `node scripts/zip-functional-evidence.mjs` 重建）。
- `phase15_ai_logs_evidence.json`：四情境各一筆，欄位含 `selected_scenario`、`route_source`、`tools_available_json`、`response_source_trace`、`tools_called`。
- 本機範例曾使用目錄：`_evidence_run/phase15_db2`（可依實際路徑調整）。

## 遮罩
- `result_summary` 固定前綴 `masked_ok`，不含客戶原文。

## 可選：真 LLM Router
- 若有 API key，可另對 pilot brand 跑實際 webhook／staging；本包以可重現的 DB 寫入為主。
