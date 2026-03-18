# Phase 1 驗收案例與可重播步驟

## 驗收案例 A～F（定義）

| 案例 | 輸入 | 預期 |
|------|------|------|
| **A** | 你們東西很爛 | **不得** high_risk_short_circuit（應走 llm 或一般路徑，可標記 frustrated） |
| **B** | 我要提告 / 我要找消保官 | **必須** legal_risk → handoff（reply_source=high_risk_short_circuit 或後續 handoff） |
| **C** | 能轉人工嗎 | 直接 handoff，不再多問「您是想找真人嗎」 |
| **D** | 人呢 | **不** handoff（止血規則：招呼／曖昧語不單獨觸發轉人工；僅「明確要真人」如「能轉人工嗎」才 handoff） |
| **E** | 第一句：我要退貨 → 第二句：說錯，我要查出貨速度 | 第二句覆蓋第一句，意圖為 order_lookup，不再沿用退貨流程 |
| **F** | 我訂很久了很煩不要了幫我轉人工 | 最終只走真人（handoff），不可查單/表單/安撫搶答 |

---

## 驗收方式

### A、B：高風險拆級（單句）

用 **sandbox prompt-preview** 看模擬回覆來源：

```bash
# A：爛 → 不應為 high_risk_short_circuit
curl -s -H "Cookie: ..." "http://localhost:5000/api/sandbox/prompt-preview?brand_id=1&message=你們東西很爛" | jq '.simulated_reply_source, .would_use_llm'
# 預期：simulated_reply_source 為 "llm" 或 "handoff"（非 high_risk_short_circuit），would_use_llm 為 true

# B：提告/消保 → 應為 high_risk_short_circuit
curl -s -H "Cookie: ..." "http://localhost:5000/api/sandbox/prompt-preview?brand_id=1&message=我要提告" | jq '.simulated_reply_source'
# 預期：simulated_reply_source 為 "high_risk_short_circuit"
curl -s -H "Cookie: ..." "http://localhost:5000/api/sandbox/prompt-preview?brand_id=1&message=我要找消保官" | jq '.simulated_reply_source'
# 預期：simulated_reply_source 為 "high_risk_short_circuit"
```

或實際發一則「你們東西很爛」從 webhook，看該則 ai_log：`reply_source` 不應為 `high_risk_short_circuit`。

### C、D：明確要真人（單句）

```bash
# C
curl -s -H "Cookie: ..." "http://localhost:5000/api/sandbox/prompt-preview?brand_id=1&message=能轉人工嗎" | jq '.simulated_reply_source'
# 預期：handoff

# D（止血：人呢 不 handoff）
curl -s -H "Cookie: ..." "http://localhost:5000/api/sandbox/prompt-preview?brand_id=1&message=人呢" | jq '.simulated_reply_source'
# 預期：非 handoff（answer_directly 或類似），單獨「人呢」不觸發轉人工
```

實際對話：發「能轉人工嗎」預期直接安排接手、不出現「您是想找真人嗎」。發「人呢」預期不轉人工（止血規則）。

### E：Correction override（兩句）

用專案內腳本（見下）或實際兩輪對話：

- 第一輪：「我要退貨」→ 可為退貨相關 mode。
- 第二輪：「說錯，我要查出貨速度」→ 意圖必須為 order_lookup，plan.mode 為 order_lookup，不得沿用 return 流程。

### F：混句只走真人

實際發一則：「我訂很久了很煩不要了幫我轉人工」。預期：reply_source 為 handoff（或 high_risk 僅在 legal 時），回覆以轉人工為主，不應先查單/先表單/長安撫再轉。

---

## 可重播腳本（state + plan，不啟動 server）

在專案根目錄執行（需可 resolve server 模組）：

```bash
npx tsx server/phase1-verify.ts
```

腳本會驗證：

- 高風險：`爛` → 不觸發 legal_risk（由 routes 的 detectHighRisk 決定，腳本只驗 state/plan）。
- 明確真人：`能轉人工嗎` → primary_intent=human_request，plan.mode=handoff；`人呢` → **不** handoff（止血）。
- Correction override：`說錯，我要查出貨速度` + recentUserMessages=`["我要退貨"]` → primary_intent=order_lookup。
- 混句：`我訂很久了很煩不要了幫我轉人工` → primary_intent=human_request，plan.mode=handoff。

輸出為通過/失敗與簡短說明。
