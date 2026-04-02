# 情境隔離規格

- 四情境：`ORDER_LOOKUP`、`AFTER_SALES`、`PRODUCT_CONSULT`、`GENERAL`。
- 每輪單一主情境（由 router 或 plan 對照決定）。
- `scenario_isolation` 開啟時：`assembleEnrichedSystemPrompt` 依情境裁切 catalog／knowledge／flow／human_hours，並附加 `buildScenarioIsolationBlock`。
- 全域安全與品牌 persona 仍保留。
