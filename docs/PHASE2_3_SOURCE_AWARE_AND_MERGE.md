# Phase 2.3：Source-aware 本地／快取與雙來源合併

## Cache Key 規格

- `order_id:{brandId}:superlanding:{idNorm}`
- `order_id:{brandId}:shopline:{idNorm}`
- `order_id:{brandId}:any:{idNorm}`
- `phone:{brandId}:superlanding:{phoneNorm}`
- `phone:{brandId}:shopline:{phoneNorm}`
- `phone:{brandId}:any:{phoneNorm}`

## 行為摘要

| 情境 | 本地／快取 | API |
|------|------------|-----|
| 官網提示 + 查單 | 僅 `shopline` scope | 僅 Shopline |
| 一頁提示 + 查單 | 僅 `superlanding` scope | 僅 SuperLanding |
| 未指定來源 + 手機 | `any`：合併 SL+Shopline 去重 | 雙管齊下合併 |
| 未指定來源 + 單號 | 先 SL 本地再 Shopline 本地；API 並行 | 先命中者寫入 |

## 程式位置

- `server/order-index.ts`：`getOrderByOrderId(..., sourceHint)`、`getOrdersByPhone`、`getOrdersByPhoneMerged`、`cacheKey*`
- `server/order-service.ts`：`unifiedLookupById`、`unifiedLookupByPhoneGlobal`
