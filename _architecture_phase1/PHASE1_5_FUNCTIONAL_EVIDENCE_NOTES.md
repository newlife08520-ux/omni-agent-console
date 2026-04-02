# Phase 1.5 Functional Evidence 說明

## 取得方式
1. 建立空目錄，設定 `DATA_DIR`。
2. 執行 `npx tsx server/phase15-evidence-harness.ts`。
3. 讀取 `_evidence_run/phase15/phase15_ai_logs_evidence.json`。

## 證明內容
- 四情境各一筆 `ai_logs`，**非空**欄位：`selected_scenario`、`route_source`、`matched_intent`、`tools_available_json`、`response_source_trace`、`tools_called`。
- 寫入經 **`buildPhase1AiLogExtras`**，與線上 ai-reply 同形。

## 限制
- 本輪為 **可重現的正式 storage 路徑**；LLM router 真呼叫需另備 key 與 staging（未強制列入 zip）。

## storage 修正
- 發現 `createAiLog` INSERT 曾多一個 `?` 占位符，已修正；**新庫**若曾失敗請拉取修正後程式重跑。
