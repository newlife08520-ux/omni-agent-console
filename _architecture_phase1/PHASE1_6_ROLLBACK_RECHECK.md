# Phase 1.6 Rollback 再確認

## flags 關閉與舊流程
- 將試點品牌 **`phase1_agent_ops_json`** 設 **`enabled: false`** 或清空 JSON，解析結果為 **Phase1 未啟用**：`isPhase1Active` 為 false，`phase1Route` 不參與 whitelist／iso／trace 寫入，**與 Phase1 前之行為一致**（仍保留既有訂單／手動流程邏輯）。

## 非 pilot 品牌
- 未寫入 `phase1_agent_ops_json` 或 `enabled: false` 之品牌 **不受** Phase1 路由／白名單／trace 影響。

## 資料庫
- `ai_logs` 新欄位可為 NULL；舊讀取端應忽略未知欄位。

## 本輪程式變更
- `computePhase1TraceLogExtras` 僅在 **Phase1 trace_v2 開且具 phase1Route** 時附加欄位；flags 關閉時 **不變更**既有非 Phase1 之 `createAiLog` 形狀。

## 建議演練
1. 選一測試品牌關閉 Phase1。
2. 跑 `verify:phase15` 中「flags off trace extras 空」與 `verify:phase1-ops`。
3. 手動抽一筆對話確認無 `selected_scenario` 寫入或為 null。
