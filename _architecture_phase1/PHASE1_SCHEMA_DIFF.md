# Schema Diff（SQLite）

## `brands`
- 新增 `phase1_agent_ops_json TEXT`（可 NULL）

## `ai_logs`
- `channel_id INTEGER`
- `matched_intent TEXT`
- `route_source TEXT`
- `selected_scenario TEXT`
- `route_confidence REAL`
- `tools_available_json TEXT`（JSON 陣列字串）
- `response_source_trace TEXT`
- `phase1_config_ref TEXT`（JSON 設定快照）

既有欄位未刪除；預設 NULL。
