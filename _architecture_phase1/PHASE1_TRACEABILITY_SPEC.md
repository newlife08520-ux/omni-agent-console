# 可觀測性（Trace v2）

寫入條件：`enabled && trace_v2 && phase1Route != null`（主 LLM 路徑成功／handoff／error 時一併嘗試附加）。

欄位：
- `matched_intent`、`route_source`、`selected_scenario`、`route_confidence`
- `tools_available_json`
- `response_source_trace`（與 `reply_source` 對齊）
- `channel_id`
- `phase1_config_ref`（flags 子集 JSON）

flags 關閉：不寫入上述語意（INSERT 仍送 NULL，不破壞舊 reader）。
