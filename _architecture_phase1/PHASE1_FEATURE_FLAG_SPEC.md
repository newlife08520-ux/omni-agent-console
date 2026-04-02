# Feature flags

- **enabled**：總開關；false 則整段 Phase1 邏輯不生效。
- **hybrid_router**：是否跑硬規則與 LLM；false 則只用 plan 對照情境。
- **scenario_isolation**：是否裁切 prompt。
- **tool_whitelist**：是否過濾 tools。
- **trace_v2**：是否寫入延伸 ai_logs。
- **allow_after_sales_order_verify**：預留，預設 false。
- **logistics_hint_override**：覆寫流程區塊物流句。
