# Tool 隔離測試結果

**狀態**：尚未執行。

| 日期 | Scenario | 預期禁用 tool 被呼叫次數 | 結果 |
|------|-----------|---------------------------|------|
| — | ORDER_LOOKUP | 0（售後專用） | — |
| — | AFTER_SALES | 0（查單工具除非例外旗標） | — |
| — | PRODUCT_CONSULT | 0（查單工具） | — |
| — | GENERAL | 0（查單工具） | — |

**資料來源**：`ai_logs.trace_json.tools_called` vs `tools_available`（Phase 3 後）。
