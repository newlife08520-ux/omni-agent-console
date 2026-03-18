# Phase 2.3：自驗與指令

## 必跑

```bash
npm run verify:phase23
```

等同：`check:server` → `verify:hardening` → `stats:order-index`（JSON 統計）。

`verify:hardening` 驗證：cache key 字串、去重鍵、`我要查訂單` → `ask_for_identifier`、off_topic 長句不誤觸 fast path、退貨流程不誤觸手機 fast path。

## 選跑（需憑證／資料）

```bash
npm run sync:orders
npm run stats:order-index
npx tsx server/phase1-verify.ts
```

## 執行證據（範例）

```
[autonomous-hardening-verify] OK — cache keys, dedupe, ask_for_identifier, off_topic skip, return_stage skip
```

`stats:order-index` 會輸出各品牌／全庫筆數；`items_count` 需在訂單經新版 `upsertOrderNormalized` 寫入明細後才會上升（可再跑 `npm run sync:orders`）。

## Shopline 對照

- `mapShoplineOrder` 支援 `subtotal_items`／`subtotal_line_items` 補商品列。
- `prepaid`／`paid_at` 由 `order_payment` 推導。
