# Phase 2.2 實作報告（接受度稽核對應）

## A. Shopline 手機／Email／姓名查詢

| 項目 | 實作 |
|------|------|
| 分頁搜尋 | `fetchShoplineSearchAllPages()` 翻頁 `/orders/search`，最多 30 頁 |
| 手機精準 | `lookupShoplineOrdersByPhoneExact`：僅保留 `normalizeShoplinePhoneDigits(buyer_phone) === 查詢數字` |
| Email 精準 | `lookupShoplineOrdersByEmailExact`：email 小寫完全一致 |
| 姓名精準 | `lookupShoplineOrdersByNameExact`：姓名去空白小寫完全一致 |
| 危險 fallback | 已移除「無匹配則整包回傳」 |
| 訂單號 | `lookupShoplineOrderById`：分頁搜尋後 `rawOrderIdExactMatch`（order_number / system_order_number / name / id 等）精準命中才回傳 |

## B. 多筆手機查單 → Server deterministic

- `lookup_order_by_phone`：`total > 1` 時組固定格式（總筆數、成功/失敗/待付/貨到付款統計、最近 3 筆明細、請回覆編號）。
- 回傳 `deterministic_skip_llm: true` + `deterministic_customer_reply`。
- Webhook 第二輪 **不呼叫 LLM**，直接送出該段文字；log：`renderer=deterministic skip_second_llm`。
- 單筆手機查單亦改為 deterministic 直接回（略去第二輪 LLM）。

## C. MultiOrderContext（schema）

`ActiveOrderContext` 新增：

- `active_order_candidates[]`（order_id、payment_status、payment_status_label、fulfillment_status、order_time）
- `candidate_count`、`selected_order_id`、`last_lookup_source`、`aggregate_payment_summary`

多筆查單後寫入，供追問路由使用。

## D. 付款狀態對外

- `payKindForOrder()`：Shopline `payment_status_raw`、一頁商店 prepaid/paid_at、貨到付款判斷。
- `formatOrderOnePage` 增加 **付款狀態：** 行。
- 多筆摘要含成功/失敗筆數（server 計數，非 LLM）。

## E. 多筆追問路由（不進 LLM）

觸發詞（需已有多筆 candidates）：

- 只看成功／哪筆成功／付款成功 → 列出付款成功訂單編號
- 還有其他訂單／另外幾筆／全部訂單 → 重播上次多筆摘要

## F. 更多訂單拆來源

- `lookup_more_orders`：標明【一頁商店】。
- 新增 `lookup_more_orders_shopline`：先 `getOrdersByPhone` + `source=shopline`，無則 `lookupShoplineOrdersByPhoneExact`；可選 `page_id`。

## G. Shopline 納入 sync

- `sync-orders-normalized.ts`：品牌有 `shopline_api_token` 時呼叫 `fetchShoplineOrdersListPaginated`，依 `created_at` 過濾最近 N 天寫入 `orders_normalized`。

## H. 溫度與第二輪 LLM

- 查單模式第一輪 LLM：`temperature: 0.28`。
- 含 order lookup tool 之第二輪（若仍進入）：`temperature: 0.2`。

## 驗收提示（runtime）

1. 同一手機多筆官網單：應看到 log `renderer=deterministic`，回覆含成功/失敗筆數。
2. `npx tsx server/scripts/query-order-index-stats.ts`：執行 sync 後應出現 `source=shopline` 筆數。
3. 「只看成功的」：在多筆上下文後應直接列出成功編號。
