# 設定模型

## `brands.phase1_agent_ops_json`
```json
{
  "enabled": true,
  "hybrid_router": true,
  "scenario_isolation": true,
  "tool_whitelist": true,
  "trace_v2": true,
  "allow_after_sales_order_verify": false,
  "logistics_hint_override": "（選填）品牌自訂物流說明一句"
}
```

- **未建立** `agent_scenarios` 表：第一輪以單一 JSON 降低 JOIN 與遷移成本；情境內容以程式內建區塊 + 品牌 override 為主。
