# 合併來源：`CONVERSATION_TRACE_SPEC.md` + `RESPONSE_DECISION_TRACE.md` + `DEBUG_VIEW_REQUIREMENTS.md`（全文）

---

# 第一部分：`CONVERSATION_TRACE_SPEC.md`

# Phase 3 — Conversation Trace（後端結構）

---

## 1. 目標

每次 AI 回覆（含 template/shortcut）寫入 **可序列化** trace，供除錯與匯出。

---

## 2. 建議載體

**優先**：擴充 `ai_logs` 單一 JSON 欄位 `trace_json`（TEXT），避免 SQLite 多表 join；體積大時改 **截斷 + 外存**（Phase 3.1）。

**欄位保留**：既有 `reply_source`、`plan_mode`、`tools_called`、`prompt_profile`、`token_usage` 等 **不刪**。

---

## 3. `trace_json` 草案

```json
{
  "v": 1,
  "brand_id": 1,
  "channel": "line",
  "matched_intent": "ORDER_LOOKUP",
  "route_source": "rule",
  "selected_scenario": "ORDER_LOOKUP",
  "reply_plan_mode": "order_lookup",
  "prompt_sections_used": [
    { "key": "GLOBAL_POLICY", "chars": 1200 },
    { "key": "BRAND_PERSONA", "chars": 400 }
  ],
  "knowledge_sources_used": [
    { "file_id": 4, "name": "masked.csv", "chars": 800 }
  ],
  "tools_available": ["lookup_order_by_id", "transfer_to_human"],
  "tools_called": ["lookup_order_by_id"],
  "response_source": "llm",
  "handoff_triggered": false,
  "policy_hits": [
    { "type": "order_lookup_policy", "detail": "order_id_direct" }
  ],
  "risk_hits": [],
  "config_version_id": 12,
  "scenario_switch": null
}
```

**對應需求**（使用者清單）：

- brand_id, channel, matched_intent, route_source, selected_scenario  
- prompt_sections_used, knowledge_sources_used, tools_available, tools_called  
- response_source（對齊 `reply_source` 或可細分）  
- handoff_triggered, policy/risk hits  
- version_id / published config id  

---

## 4. 非 LLM 路徑

- `gate_skip`、`safe_confirm_template`、`deterministic_tool`：**仍寫** trace，`tools_available` 可為 `[]` 或單一。

---

## 5. PII

- trace 內 **禁止** 原始電話／姓名；僅 hash 或末碼 mask。

---

## 6. API

- `GET /api/contacts/:id/ai-logs` 擴充回傳 `trace_json`（權限：內部客服）。

---

# 第二部分：`RESPONSE_DECISION_TRACE.md`

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

---

# 第三部分：`DEBUG_VIEW_REQUIREMENTS.md`

# Debug View 需求（對話頁）

**目標讀者**：內部客服／營運／工程。**非**終端消費者。

---

## 1. 入口

- 在 `chat.tsx`（或側欄）新增 **「本則 AI 除錯」** 抽屜，僅具權限使用者可見（可先 `super_admin` / `marketing_manager`）。

---

## 2. 必顯欄位（MVP）

| 欄位 | 說明 |
|------|------|
| 時間 | 該則 AI 訊息 `created_at` |
| Scenario | ORDER_LOOKUP / … |
| Router | rule vs llm + confidence |
| Plan mode | `ReplyPlanMode` |
| Tools available | 列表 |
| Tools called | 列表 + 每個簡短結果（found / error） |
| Reply source | template / tool / llm / handoff |
| Handoff | 是否觸發 + reason |
| Config version | id + published_at |
| Prompt sections | 標題 + 字數（不預設展開全文） |

---

## 3. 次級（Phase 3.1）

- Policy hits（查單政策哪條命中）  
- Risk hits  
- Scenario 切換歷史（本對話最近 5 次）

---

## 4. 非目標

- 不在此頁做 **編輯** Agent 設定（導向 Publish Center）。  
- 不顯示完整 OpenAI request（太大）；提供「下載 masked 摘要」即可。

---

## 5. 技術

- 資料來自 `GET` messages 附帶 `ai_log_id` 或獨立 `GET /api/ai-logs?message_id=`。  
- 若 `trace_json` 為空（舊資料）：顯示「僅舊版欄位」fallback。
