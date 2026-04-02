# Prompt 組裝對照

| 情境 | catalog | knowledge | flow | human_hours | 註 |
|------|---------|-----------|------|-------------|-----|
| ORDER_LOOKUP | 否 | 否 | 否 | 否 | 等同原 order diet + 情境標頭 |
| AFTER_SALES | 否 | 是 | 是 | 是 | 聚焦售後 |
| PRODUCT_CONSULT | 是 | 是 | 是 | 是 | 完整諮詢 |
| GENERAL | 否 | 是（較短 24k） | 是 | 是 | 精簡型錄 |

`shippingHintOverride` 優先於甜點/非甜點硬編碼（`buildFlowPrinciplesPrompt`）。
