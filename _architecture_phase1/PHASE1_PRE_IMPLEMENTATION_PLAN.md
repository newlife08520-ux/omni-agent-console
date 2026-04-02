# Phase 1 實作前計畫（快照）

## 目標
後端限定：Hybrid Router、情境隔離、Tool whitelist、可觀測性、品牌級 feature flags；不動 Lite Admin、畫布、多 Agent、webhook／worker 主幹。

## 策略
- 設定承載：`brands.phase1_agent_ops_json`（避免新表過度設計）。
- 追蹤承載：`ai_logs` 專用欄位（可 NULL，flags 關閉時不寫入語意化資料）。
- Router：硬規則 → LLM（可設定模型）→ legacy plan／state fallback。
- Prompt：`assembleEnrichedSystemPrompt` 在 `scenarioIsolationEnabled` 時依情境裁切區塊並加情境標頭。

## 試點
僅對 1 個品牌設 `enabled: true`；其餘維持舊行為。
