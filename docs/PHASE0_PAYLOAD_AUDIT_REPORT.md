# Phase 0：Payload 盤點報告（C 章 + Q 章 Phase 0）

依 **CURSOR_ORDER_CX_WORLDCLASS_PLAN.md** 從 Q 章 Phase 0 開始，不跳步。本階段完成 C 章「欄位真相盤點」。

---

## 1. 已完成項目

| 項目 | 說明 |
|------|------|
| 新增 audit scripts | `server/scripts/audit-superlanding-order-payload.ts`、`server/scripts/audit-shopline-order-payload.ts`、共用 `audit-utils.ts` |
| 執行 SuperLanding audit | `npm run audit:superlanding`，產出 `docs/runtime-audit/superlanding-order-sample.sanitized.json`、`superlanding-order-keys.md` |
| 執行 SHOPLINE audit | `npm run audit:shopline`，產出 `docs/runtime-audit/shopline-order-sample.sanitized.json`、`shopline-order-keys.md` |
| 遮罩規則 | 姓名首字、手機後 3 碼、email 前 2+domain、地址前 3 字+*** |
| check:server | 已通過 `npm run check:server` |

---

## 2. 產出位置

- `docs/runtime-audit/superlanding-order-sample.sanitized.json` — 一頁商店最近 5 筆訂單（遮罩後）
- `docs/runtime-audit/superlanding-order-keys.md` — 一頁商店欄位 key 盤點、product_list/address 型態、tracking_codes 內 key
- `docs/runtime-audit/shopline-order-sample.sanitized.json` — SHOPLINE 最近 5 筆訂單（遮罩後）
- `docs/runtime-audit/shopline-order-keys.md` — SHOPLINE 欄位盤點、order_payment / order_delivery / delivery_address / delivery_data / subtotal_items / customer_info / invoice 之 nested keys

---

## 3. 人工確認欄位（C 章驗收）

**這一步必須由人工依實際產出確認，完成前不得在 Phase 2 寫死大量推測 mapping。**

請對照 `superlanding-order-keys.md` 與 `superlanding-order-sample.sanitized.json` 確認：

- [ ] SuperLanding 是否有更完整的付款欄位（例如 prepaid、paid_at、payment_transaction_id 等）
- [ ] SuperLanding 是否有門市代碼／門市名／地址分開欄位（例如 convenient_store 是否為一字串或可拆）
- [ ] address 在實際 payload 為 string 或 JSON string，mapOrder 是否需依型態分支

請對照 `shopline-order-keys.md` 與 `shopline-order-sample.sanitized.json` 確認：

- [ ] `order_payment.status`、`paid_at`、`order_delivery.*`、`delivery_data.location_code`、`location_name`、`store_address` 是否皆可取用
- [ ] `subtotal_items` 是否足以產出完整商品明細（name/sku/quantity/price）

---

## 4. 與現行 mapOrder / mapShoplineOrder 之差異摘要

- **SuperLanding**：目前 `mapOrder` 使用 `recipient`→buyer_name、`mobile`→buyer_phone、`email`、`created_date`/`order_created_at`、`tracking_codes`、`product_list`（array→JSON string）、`address`（string 或 JSON 拆 state/city/addr1/addr2）。真實 payload 尚有 `convenient_store`、`payment_transaction_id`、`invoice`、`system_note` 等，後續 Phase 2 依盤點結果擴充。
- **SHOPLINE**：目前 `mapShoplineOrder` 僅用表層欄位；真實 API 有 `order_payment`（status、paid_at、name_translations）、`order_delivery`、`delivery_address`、`delivery_data`（location_code、location_name、store_address、tracking_number）、`subtotal_items` 等，Phase 2 依盤點結果擴充。

---

## 5. 修改檔案清單

| 檔案 | 變更 |
|------|------|
| `server/scripts/audit-utils.ts` | 新增：遮罩與 key 收集 |
| `server/scripts/audit-superlanding-order-payload.ts` | 新增：一頁商店稽核 |
| `server/scripts/audit-shopline-order-payload.ts` | 新增：SHOPLINE 稽核 |
| `package.json` | 新增 script：audit:superlanding、audit:shopline、audit:payloads |
| `docs/runtime-audit/*` | 上述產出（可重複執行覆寫） |

---

## 6. P0 驗收劇本（必須跑完再進 Phase 1）

依計劃書：每做完一個 phase 就照 P 章驗收劇本跑完再進下一階段。

- **P0 驗收表**：`docs/P0_BASELINE_ACCEPTANCE.md`
- **作法**：在目前系統（未改 Phase 1）下，對 AI 客服依序發送表中 8 則問句，記錄「是否查到、花多久、是否誤判、是否亂講」。
- **何時可進 Phase 1**：跑完 P0 並填寫完 `P0_BASELINE_ACCEPTANCE.md` 後，再開始 Phase 1（止血）。

## 7. 下一步

- 完成「人工確認欄位」（上表打勾）＋ **P0 baseline 跑完並填表** 後，再進入 **Phase 1（止血）**。
