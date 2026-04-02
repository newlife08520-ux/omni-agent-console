# Debug metadata 對照

| 欄位 | 來源 |
|------|------|
| matched_intent | Router 或 legacy 對照 |
| route_source | rule / llm / legacy_fallback / legacy_plan_map |
| selected_scenario | 四情境之一 |
| route_confidence | 規則 0.8–0.92；LLM 輸出；legacy ~0.5–0.55 |
| tools_available_json | 當輪送入 OpenAI 的 tool 名稱列表 |
| phase1_config_ref | 靜態版本 v1 + 三個子開關 |
