# Tool Whitelist 規格

| 情境 | 允許 |
|------|------|
| ORDER_LOOKUP | 全部 lookup tools + handoff +（若有圖資）image |
| AFTER_SALES | handoff + image；**不**含 order lookup（除非 `allow_after_sales_order_verify`） |
| PRODUCT_CONSULT | handoff + image；**不**含 order lookup |
| GENERAL | 僅 handoff |

實作：`server/services/tool-scenario-filter.ts`。
