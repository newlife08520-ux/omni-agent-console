# Hard Rule 收斂（Phase 1.5）

## 原則
- 廢除單獨寬鬆的僅 regex 訂單號匹配與「純數字 5 位以上即查單」。
- 沿用 classifyOrderNumber、extractOrderIdFromMixedSentence。
- 優先序：AFTERSALES_KW，其次優惠碼語境（無查單語境），其次 PRODUCT_KW（無查單語境、無混合單號），其次 LOGISTICS_KW，最後單欄位單號、手機、長數字加查單語境。

## 測試矩陣
- 見 phase15-verify：真單號 KBT58265；SKU 無語境 MODEL-XS-99 不強制 ORDER_LOOKUP；優惠碼 SAVE20 走向 PRODUCT_CONSULT；物流與退貨並列時售後優先。
