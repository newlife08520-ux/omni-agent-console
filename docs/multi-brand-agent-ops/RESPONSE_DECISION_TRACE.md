# Response Decision Trace（決策鏈）

說明從 **訊息進來** 到 **回覆出去** 的決策鏈，供 log 與 UI 同構展示。

---

## 1. 決策鏈節點（有序）

1. **Inbound** — platform, channel_id, brand_id, contact_id  
2. **Safety / Mute gates** — ai_muted, needs_human, status gate（現有邏輯）  
3. **Short circuits** — high_risk, safe_confirm_template  
4. **Router** — intent, confidence, source (rule/llm)  
5. **Scenario** — ORDER_LOOKUP / …  
6. **Reply plan** — ReplyPlanMode（子狀態）  
7. **Prompt build** — sections 列表與字數  
8. **Tool pick** — available 列表  
9. **LLM or deterministic** — 是否呼叫 OpenAI、溫度  
10. **Tool execution** — 每個 tool 結果摘要（found, error code）  
11. **Post guards** — content-guard, shipping SOP, output guard  
12. **Outbound** — 管道發送結果  

---

## 2. UI 對應

- **摺疊面板**：每節點一區塊；失敗節點紅色。  
- **時間線**：queue_wait_ms、first_token、total（沿用現有 latency 欄位若可）。

---

## 3. 匯出

- JSON Lines：一則 AI 回覆一行 `trace_json`。  
- CSV：扁平化欄位（僅摘要，供營運 Excel）。

---

## 4. 與現有 `createAiLog` 對齊

| 既有欄位 | 對應 trace 區段 |
|-----------|-----------------|
| plan_mode | 節點 6 |
| reply_source | 節點 11–12 結果 |
| tools_called | 節點 10 |
| prompt_profile | 節點 7 摘要 |
