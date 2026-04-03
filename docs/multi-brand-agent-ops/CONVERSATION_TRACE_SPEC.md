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
