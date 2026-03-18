# Phase 2.3：order_items_normalized、別名、本地商品+手機

## DB

- `order_items_normalized.product_name_normalized`（migration `migratePhase23OrderItemsAndAliases`）
- `product_aliases.alias_normalized`

## upsert

`upsertOrderNormalized` 會刪除舊明細後依 `product_list` JSON 重寫 `order_items_normalized`。

## 查詢主線

`lookup_order_by_product_and_phone` 在具 `brandId` + `product_name` 時，先跑：

`lookupOrdersByProductAliasAndPhoneLocal(brandId, phone, productName)`

- 明細 `product_name_normalized LIKE %query%`
- 或 `page_id` 落在別名表命中之 `page_id`

官網語境下若本地僅有一頁商店命中，仍會改走 API（過濾 `source=shopline` 無命中則 fall through）。

## 指令

```bash
npm run derive:aliases [brand_id]
npm run stats:order-index [brand_id]
npm run sync:orders
```
