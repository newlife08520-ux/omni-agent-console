# Phase 2 實作報告（Step 1：Schema / Migration）

依 **CURSOR_PHASE2_EXECUTION_PROMPT** 進入 Phase 2，先完成 schema 與 migration、basic verification，再進行 sync job 與查單決策引擎。

---

## 1. 已完成（Step 1）

### 1.1 Schema 與 Migration

| 項目 | 說明 |
|------|------|
| **orders_normalized** | 本地正規化訂單表：brand_id, source (superlanding\|shopline), global_order_id, buyer_phone_normalized, page_id, status, payload (JSON), synced_at。索引：brand+phone、brand+order_id、唯一 (brand, source, global_order_id)。 |
| **order_items_normalized** | 訂單明細：order_normalized_id FK, product_name, sku, quantity, price_cents。索引：order_normalized_id。 |
| **product_aliases** | 商品別名：brand_id, page_id, canonical_name, alias。供「商品名＋手機」語意匹配用。索引：brand_id、(brand_id, alias)。 |
| **order_lookup_cache** | 查單快取：cache_key (PK), result_payload, fetched_at, ttl_seconds。key 範例：phone:0922123456、order_id:ABC123。 |

### 1.2 型別（shared/schema.ts）

- `OrderNormalized`
- `OrderItemNormalized`
- `ProductAlias`
- `OrderLookupCacheRow`

### 1.3 修改檔案

| 檔案 | 變更 |
|------|------|
| server/db.ts | 新增 `migratePhase2OrderIndex()`，於 `initDatabase()` 內呼叫。 |
| shared/schema.ts | 新增上述四個 interface。 |

---

## 2. 驗收結果

- **編譯**：`npm run check:server` 通過。
- **Migration**：`initDatabase()` 會建立上述四張表與索引；於 server 或任一載入 `server/storage` 之腳本啟動時執行。
- **Phase 2 驗收腳本**：`npx tsx server/phase2-verify.ts` — 10 通過、0 失敗。

---

## 3. 已完成（Step D：Sync + 本地 index 優先）

### 3.1 手動同步腳本

| 項目 | 說明 |
|------|------|
| **script** | `server/scripts/sync-orders-normalized.ts` |
| **指令** | `npm run sync:orders` 或 `npx tsx server/scripts/sync-orders-normalized.ts [brand_id] [days]` |
| **行為** | 對所有具一頁商店設定的品牌（或指定 brand_id）拉取最近 N 天（預設 7，最多 90）訂單，寫入 `orders_normalized`。 |

### 3.2 本地 index 優先查單

| 項目 | 說明 |
|------|------|
| **order-index.ts** | `getOrderByOrderId`、`getOrdersByPhone`、`getOrderLookupCache`、`setOrderLookupCache`、`upsertOrderNormalized`、`normalizePhone`。 |
| **unifiedLookupById** | 有 brandId 時先查 cache（order_id:brandId:id）、再查 orders_normalized；未命中再走 API；API 成功後寫回 cache 並 upsert 一筆至 orders_normalized。 |
| **unifiedLookupByPhoneGlobal** | 有 brandId 時先查 cache（phone:brandId:normalizedPhone）、再查 orders_normalized；未命中再走 API；API 成功後寫回 cache 並 upsert 所有結果至 orders_normalized。 |

### 3.3 修改檔案（Step D）

| 檔案 | 變更 |
|------|------|
| server/order-index.ts | 新增：正規化訂單讀寫、快取 get/set、upsertOrderNormalized。 |
| server/order-service.ts | unifiedLookupById / unifiedLookupByPhoneGlobal 加入「先本地、再 API、成功後寫回」邏輯。 |
| server/scripts/sync-orders-normalized.ts | 新增：依日期範圍拉取一頁商店訂單並 upsert。 |
| package.json | 已有 `sync:orders`。 |

---

## 4. 下一步（可選）

- **商品名＋手機**：以 `product_aliases` 解析商品名 → page_id，再依 page_id + phone 查 orders_normalized 或既有 `lookupOrdersByPageAndPhone`（需先有 product_aliases 資料來源，例如從銷售頁 API 同步）。
- **Shopline 同步**：若需將 Shopline 訂單也寫入 orders_normalized，可擴充 sync 腳本（需 SHOPLINE 列表訂單 API 支援）。
