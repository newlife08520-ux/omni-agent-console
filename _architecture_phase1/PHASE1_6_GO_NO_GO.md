# Phase 1.6 Go / No-Go

## 判斷：**GO for isolated pilot**（**HOLD** for merge main）

### GO 的範圍（僅限）
- **本機或 staging、隔離 `DATA_DIR`** 下，對 **單一 pilot 品牌** 開啟 `phase1_agent_ops_json` 全套 flags。
- 已具 **主流程 `autoReplyWithAI` + 真 OpenAI key** 之 `ai_logs` 取證（見 `PHASE1_PILOT_FUNCTIONAL_EVIDENCE.zip` 與 `pilot_ai_logs_evidence.json`）。
- 營運上視為 **實驗／沙盒**，不視為全站預設。

### HOLD（尚未可當 production 預設／不建議 merge main）
- 尚缺：**多品牌矩陣**、**真 webhook 長鏈**、**足量 `route_source: llm` 線上樣本**、**SLO／告警與回滾演練**。
- 需補：至少一輪 **staging 真渠道** 重跑同四句（或等價情境）並存 log。

### 若評為 NOT READY 的條件（本輪未選）
- 最大 blocker 會是：**無法取得合法 API key** 或 **主流程無法完成寫 log**（例如環境無法跑 `autoReplyWithAI`）。解法：先解鎖 key 與隔離 DB，再跑 `phase16-pilot-proof-harness.ts`。
