# Shopline Integration Truth Report

本報告明確回答：**Shopline 到底有沒有成功對接到客服查單系統？**  
依 code evidence 與 runtime evidence 如實填寫，不省略。

---

# 一、先回答最終狀態（只能三選一）

**部分對接**

- **即時查單**：已對接。依訂單號／手機查單時，會呼叫 Shopline API（`lookupShoplineOrderById`、`lookupShoplineOrdersByPhone`），並在成功後寫回 `order_lookup_cache` 與 `orders_normalized`，故「API 查單 + write-back」已落地。
- **批量同步**：未對接。`sync-orders-normalized.ts` 僅使用一頁商店（SuperLanding）的 `fetchOrders`，**完全沒有呼叫任何 Shopline API**，因此 `orders_normalized` 中不會有來自「同步」的 Shopline 訂單。
- **Local-first**：部分成立。查單流程為「先 cache → 再 orders_normalized → 再 API」；但 Shopline 訂單只會經由「曾透過 API 查過並 write-back」進入本地，沒有批量同步，故首次查詢必走 API，之後同一 key 才會 local-first 命中。

---

# 二、分四層回答 Shopline 接到哪裡

每層標示：**already-landed** / **partial** / **not-landed**，並附檔案、函式名、關鍵程式碼片段、實測結果、尚缺什麼。

---

## 1. Shopline API 即時查單

**狀態：already-landed**

| 項目 | 內容 |
|------|------|
| 檔案 | `server/shopline.ts`、`server/order-service.ts` |
| 函式名 | `lookupShoplineOrderById`、`lookupShoplineOrdersByPhone`（shopline.ts）；`unifiedLookupById` 內 `runShopline()`、`unifiedLookupByPhoneGlobal` 內 `runShopline()`（order-service.ts） |
| 關鍵程式碼片段 | **shopline.ts**：`lookupShoplineOrderById(config, orderId)` 使用 `fetchShoplineOrders(config, { order_number: normalizedId })` 與 keyword fallback；`lookupShoplineOrdersByPhone(config, phone)` 使用 `fetchShoplineOrders(config, { keyword: normalizedPhone, per_page: "50" })`。**order-service.ts**：`runShopline()` 內 `getShoplineConfig(brandId)` 取得品牌憑證，成功時回傳 `{ orders, source: "shopline", found: true }`。 |
| 實測結果 | 程式路徑完整：品牌具備 `shopline_store_domain`、`shopline_api_token` 時會打 Shopline API；失敗時 catch 並 log「SHOPLINE 查詢失敗」/「SHOPLINE 手機全域查詢失敗」。本環境未提供 Shopline 憑證，未執行實際 API 呼叫。 |
| 尚缺什麼 | 無。邏輯已完整；若需驗證需在具 Shopline 憑證的環境執行。 |

---

## 2. Shopline 訂單同步進 orders_normalized

**狀態：not-landed**

| 項目 | 內容 |
|------|------|
| 檔案 | `server/scripts/sync-orders-normalized.ts` |
| 函式名 | `main()`；僅使用 `getSuperLandingConfig`、`fetchOrders`（來自 superlanding） |
| 關鍵程式碼片段 | 篩選品牌：`brands.filter((b) => b.superlanding_merchant_no?.trim() && b.superlanding_access_key?.trim())`；迴圈內僅 `fetchOrders(config, { begin_date, end_date, per_page, page })` 與 `upsertOrderNormalized(brand.id, "superlanding", order)`。**沒有任何 `getShoplineConfig`、`fetchShoplineOrders` 或 `upsertOrderNormalized(brand.id, "shopline", ...)` 的呼叫。** |
| 實測結果 | 執行 `npm run sync:orders` 與 `npx tsx server/scripts/sync-orders-normalized.ts 1 1`，終端僅出現「[一頁商店] 正在查詢訂單」與「[Sync] Brand 1 寫入 N 筆」，**無任何 [SHOPLINE] 日誌**。DB 查詢：`orders_normalized` 僅有 `source=superlanding`（例如 20000 筆），**source=shopline 為 0 筆**（見第四節）。 |
| 尚缺什麼 | 需在 sync 腳本中新增：依品牌取得 Shopline 設定、呼叫 `fetchShoplineOrders`（或 SHOPLINE 列表 API）並將結果以 `upsertOrderNormalized(brandId, "shopline", order)` 寫入。 |

---

## 3. Shopline 查單結果寫入 order_lookup_cache

**狀態：already-landed**

| 項目 | 內容 |
|------|------|
| 檔案 | `server/order-service.ts`、`server/order-index.ts` |
| 函式名 | `setOrderLookupCache`（order-index.ts）；`unifiedLookupById`、`unifiedLookupByPhoneGlobal` 在 API 成功後呼叫 |
| 關鍵程式碼片段 | **unifiedLookupById**：`if (result.found && result.orders.length > 0 && idNorm && brandId) { setOrderLookupCache(\`order_id:${brandId}:${idNorm}\`, result); ... upsertOrderNormalized(...); }`。**unifiedLookupByPhoneGlobal**：`if (result.found && result.orders.length > 0 && phoneNorm && brandId) { setOrderLookupCache(\`phone:${brandId}:${phoneNorm}\`, result); for (const o of result.orders) { ... upsertOrderNormalized(...); } }`。result 內含 `source: "shopline"`，故 Shopline 查單成功時會寫入 cache。 |
| 實測結果 | 程式路徑一致：API 回傳 found 且 orders 有資料時必寫 cache 與 orders_normalized。本環境 order_lookup_cache 總筆數為 0（尚未有查單請求寫入）。 |
| 尚缺什麼 | 無。write-back 邏輯已實作；runtime 證據需在具 Shopline 憑證且實際觸發查單後再查 DB。 |

---

## 4. unifiedLookupById / unifiedLookupByPhoneGlobal 對 Shopline 是否真的 local-first 生效

**狀態：partial**

| 項目 | 內容 |
|------|------|
| 檔案 | `server/order-service.ts`、`server/order-index.ts` |
| 函式名 | `unifiedLookupById`、`unifiedLookupByPhoneGlobal`；`getOrderLookupCache`、`getOrderByOrderId`、`getOrdersByPhone` |
| 關鍵程式碼片段 | **先本地**：`getOrderLookupCache(cacheKey)` → 未命中則 `getOrderByOrderId(brandId, idNorm)` / `getOrdersByPhone(brandId, phone)`（查 orders_normalized，不區分 source）。**再 API**：`runShopline()` / `runSuperlanding()`。故若 orders_normalized 或 cache 中已有該 Shopline 訂單（來自先前 API write-back），會 local hit。 |
| 實測結果 | 邏輯為 local-first；但 **orders_normalized 目前無任何 source=shopline 資料**（sync 未跑 Shopline），因此 Shopline 的 local hit 只會發生在「該 key 曾透過 API 查過並寫回」之後。首次查詢必走 API。 |
| 尚缺什麼 | 若要有「大量 Shopline 訂單 local-first」，需補上「Shopline 訂單同步進 orders_normalized」（即第 2 層）。 |

---

# 三、必查檔案

| 檔案 | 結論摘要 |
|------|----------|
| server/order-service.ts | 含 `unifiedLookupById`、`unifiedLookupByPhoneGlobal`；先 cache → orders_normalized → API；`runShopline()` 呼叫 `lookupShoplineOrderById` / `lookupShoplineOrdersByPhone`；成功後 `setOrderLookupCache` 與 `upsertOrderNormalized`，source 為 "shopline"。 |
| server/order-index.ts | `getOrderByOrderId`、`getOrdersByPhone` 僅查 orders_normalized（不區分 source）；`setOrderLookupCache`、`upsertOrderNormalized` 支援 source=shopline。 |
| server/scripts/sync-orders-normalized.ts | 僅使用 `getSuperLandingConfig`、`fetchOrders`（superlanding）；**未使用任何 Shopline 相關函式**，未寫入 source=shopline。 |
| server/shopline.ts | `lookupShoplineOrderById`、`lookupShoplineOrdersByPhone`、`fetchShoplineOrders`、`mapShoplineOrder`；Shopline Open API 請求與 OrderInfo 映射。 |
| server/storage.ts、server/db.ts、server/routes.ts | 品牌含 `shopline_store_domain`、`shopline_api_token`；order-service 透過 `getShoplineConfig(brandId)` 自 storage 取得。 |
| shared/schema.ts | `Brand` 含 `shopline_store_domain`、`shopline_api_token`；`OrderSource` 含 "shopline"；OrderInfo 等型別支援。 |
| docs/PHASE2_IMPLEMENTATION_REPORT.md | 記載 sync 為「一頁商店」、本地 index 優先；「Shopline 同步」列為下一步可選：「若需將 Shopline 訂單也寫入 orders_normalized，可擴充 sync 腳本」。 |

**Shopline 相關 client / adapter**：`server/shopline.ts` 為唯一 Shopline 整合模組（無額外 client 目錄）。`server/scripts/audit-shopline-order-payload.ts` 為審計腳本，依品牌 Shopline 憑證打 API。

---

# 四、必交執行證據

## 1. npm run sync:orders 的完整終端輸出

執行指令：`npm run sync:orders`（等同 `tsx server/scripts/sync-orders-normalized.ts`）。

輸出節錄（僅一頁商店，無 Shopline）：

```
> rest-express@1.0.0 sync:orders
> tsx server/scripts/sync-orders-normalized.ts

[DB Migration] Phase 2 訂單索引表（...）已就緒
[Sync] Brand 1 (私藏生活) 2026-03-10 ~ 2026-03-17 ...
[一頁商店] 正在查詢訂單，請求網址為: https://api.super-landing.com/orders.json?...
[一頁商店] 回傳結果: current_page= 1 total_entries= 21495 orders count= 200
...（重複多頁）
```

結論：**全程僅「一頁商店」API，無 [SHOPLINE] 日誌，無 Shopline 寫入。**

---

## 2. npx tsx server/scripts/sync-orders-normalized.ts [brand_id] [days] 的完整終端輸出

執行：`npx tsx server/scripts/sync-orders-normalized.ts 1 1`（brand_id=1, days=1）。

```
[DB Migration] Phase 2 訂單索引表（orders_normalized, order_items_normalized, product_aliases, order_lookup_cache）已就緒
[Sync] Brand 1 (私藏生活) 2026-03-16 ~ 2026-03-17 ...
[一頁商店] 正在查詢訂單，請求網址為: https://api.super-landing.com/orders.json?merchant_no=QT089002617&access_key=***&begin_date=2026-03-16&end_date=2026-03-17&per_page=200&page=1
[一頁商店] 回傳結果: current_page= 1 total_entries= 5134 orders count= 200
...（共 26 頁，最後一頁 135 筆）
[Sync] Brand 1 寫入 5135 筆
```

結論：**同樣僅一頁商店，寫入 5135 筆皆為 superlanding；無 Shopline。**
（若未來 sync 納入 Shopline，此處應會出現 [SHOPLINE] API 請求與對應寫入筆數。）

---

## 3. 資料庫查詢結果

執行：`npx tsx server/scripts/query-order-index-stats.ts`。

**orders_normalized 各 source 的 count：**

```
=== orders_normalized 各 source 筆數 ===
  source=superlanding  count=20000
```

（無 source=shopline 列，即 **Shopline 筆數 = 0**。）

**order_lookup_cache 各 source 的 count：**

- 表結構無 `source` 欄位，僅有 `cache_key`、`result_payload`、`fetched_at`、`ttl_seconds`。  
- 總筆數：**total: 0**  
- 依 key 前綴：order_id:* count: 0，phone:* count: 0  

（result_payload 內含 JSON，其中 `source` 可為 "shopline"；目前無任何 cache 資料。）

**最近 10 筆 source=shopline 的 orders_normalized：**

```
=== 最近 10 筆 source=shopline 的 orders_normalized ===
  (無 source=shopline 資料)
```

---

## 4. 四組 lookup 測試

| 測試項 | 預期行為（code） | runtime evidence |
|--------|------------------|------------------|
| 訂單號 cache hit | 先 `getOrderLookupCache("order_id:brandId:id")`，命中且 `found` 則直接回傳，不打 API | 本環境 cache 為 0，無法重現；需先有一次 API 查單寫回後再查同一訂單號 |
| 訂單號 normalized hit | 再 `getOrderByOrderId(brandId, idNorm)` 查 orders_normalized；若有該訂單（含曾 write-back 的 Shopline）則回傳並寫入 cache | 目前 orders_normalized 無 shopline，僅 superlanding；若該品牌有 Shopline 訂單且曾經 API 查過並 write-back，此處會 hit |
| 訂單號 API fallback + write-back | cache 與 normalized 皆未命中時呼叫 `runShopline()` → `lookupShoplineOrderById`；成功則 `setOrderLookupCache` 與 `upsertOrderNormalized(..., "shopline", o)` | 需具 Shopline 憑證與真實訂單號；本環境未執行。程式路徑已確認會寫回 |
| 手機 API fallback + write-back | 同上，改為 `runShopline()` → `lookupShoplineOrdersByPhone`；成功則寫入 `phone:brandId:phoneNorm` 及多筆 `upsertOrderNormalized` | 同上，需憑證與真實手機號；本環境未執行。程式路徑已確認會寫回 |

結論：**code evidence 支援四種情境；runtime evidence 僅能證明 sync 與 DB 現狀（無 Shopline 同步、無 cache），實際 API + write-back 需在具 Shopline 憑證環境補測。**

---

# 五、必答問題

1. **sync-orders-normalized.ts 現在到底有沒有跑 Shopline？**  
   **沒有。** 腳本只跑一頁商店（SuperLanding）：`getSuperLandingConfig`、`fetchOrders`，並以 `upsertOrderNormalized(brand.id, "superlanding", order)` 寫入；沒有任何 Shopline API 或 `"shopline"` source 寫入。

2. **如果沒有，為什麼回報不能寫成「Shopline 已成功對接」？**  
   因為「成功對接」若包含「訂單同步進本地索引」，則目前 **Shopline 訂單不會經由 sync 進入 orders_normalized**，僅能透過「單次查單 API 成功後的 write-back」進入；且 DB 實查結果為 source=shopline 筆數 0，故不能說「已完整對接」，只能說「部分對接」（API 查單 + write-back 有，批量同步沒有）。

3. **如果有，請提供實際抓到的 Shopline 訂單數與寫入數。**  
   目前 **sync 沒有跑 Shopline**，故「同步抓到的 Shopline 訂單數」為 0、寫入數 0。經 API 查單 write-back 的筆數本環境未測（無憑證／未觸發）。

4. **unifiedLookupById 對 Shopline 是先查本地還是直接打 API？**  
   **先查本地。** 順序：`getOrderLookupCache` → `getOrderByOrderId(brandId, idNorm)`（查 orders_normalized）→ 未命中才 `runShopline()` / `runSuperlanding()`。因此對 Shopline 也是 local-first；只是目前本地沒有 Shopline 批量同步資料，只有「曾查過並 write-back」的才會命中。

5. **unifiedLookupByPhoneGlobal 對 Shopline 是先查本地還是直接打 API？**  
   **先查本地。** 順序：`getOrderLookupCache(phone:...)` → `getOrdersByPhone(brandId, phone)`（查 orders_normalized）→ 未命中才跑 API。同上，對 Shopline 為 local-first，本地資料僅來自 write-back。

6. **brand settings 裡是否已具備 Shopline 所需憑證與品牌對應？**  
   **Schema 與儲存已具備。** `Brand` 有 `shopline_store_domain`、`shopline_api_token`；`getShoplineConfig(brandId)` 從 `storage.getBrand(brandId)` 讀取，有 token 才回傳 config 並打 API。本環境未確認實際品牌是否填寫憑證；若未填，`runShopline()` 會直接 return null。

7. **查單失敗時是否有正確 fallback 與錯誤訊息？**  
   **有。** `runShopline()` 外層 try/catch，失敗時 log「[UnifiedOrder] SHOPLINE 查詢失敗:」或「SHOPLINE 手機全域查詢失敗:」+ message；然後依 `preferSource` 與預設順序 fallback 到另一來源（例如先 SuperLanding 再 Shopline，或反序），最終可回傳 `{ orders: [], source: "unknown", found: false }`。

---

# 六、總結表

| 項目 | 狀態 | code evidence | runtime evidence | 結論 |
|------|------|---------------|------------------|------|
| Shopline API lookup | already-landed | order-service.ts `runShopline()` 呼叫 `lookupShoplineOrderById` / `lookupShoplineOrdersByPhone`；shopline.ts 實作兩者並打 Open API | 未在具憑證環境執行 API；日誌與錯誤處理路徑已存在 | 已對接，需憑證環境驗證 |
| Shopline sync -> orders_normalized | not-landed | sync-orders-normalized.ts 僅用 getSuperLandingConfig + fetchOrders，無 Shopline 呼叫與 "shopline" 寫入 | npm run sync:orders 與 sync 1 1 僅見一頁商店日誌；DB 查得 source=shopline 筆數 0 | 未對接 |
| Shopline cache write-back | already-landed | unifiedLookupById/ByPhoneGlobal 在 result.found 時呼叫 setOrderLookupCache 與 upsertOrderNormalized，source 來自 result（含 "shopline"） | order_lookup_cache 目前 0 筆（尚未有查單寫入）；程式路徑正確 | 已對接，runtime 需查單後再查 DB |
| Shopline local-first by order id | partial | 先 getOrderLookupCache → getOrderByOrderId → 再 runShopline；getOrderByOrderId 不區分 source，故曾 write-back 的 Shopline 會命中 | orders_normalized 無 shopline 資料，故目前無 Shopline 的 local hit；邏輯為 local-first | 邏輯已 local-first，缺同步故僅 write-back 後才命中 |
| Shopline local-first by phone | partial | 先 getOrderLookupCache(phone:...) → getOrdersByPhone → 再 runShopline；同上 | 同上 | 邏輯已 local-first，缺同步故僅 write-back 後才命中 |

---

**報告產出時間**：依本專案程式與上述執行結果產出。  
**執行證據說明**：sync 與 DB 查詢為實際執行；四組 lookup 與 API write-back 的 runtime 證據需在**具 Shopline 憑證與真實訂單／手機的環境**補測。
