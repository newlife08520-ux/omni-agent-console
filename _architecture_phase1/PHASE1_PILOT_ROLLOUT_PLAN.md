# Pilot 展開

1. 選定 1 個品牌 `id`（例如最小 id 之測試品牌）。
2. 執行 SQL：
```sql
UPDATE brands SET phase1_agent_ops_json = '{
  "enabled": true,
  "hybrid_router": true,
  "scenario_isolation": true,
  "tool_whitelist": true,
  "trace_v2": true,
  "allow_after_sales_order_verify": false
}' WHERE id = ?;
```
3. 其餘品牌維持 NULL／enabled false。
4. 觀察 `ai_logs` 新欄位與客诉率；再決定擴張。
