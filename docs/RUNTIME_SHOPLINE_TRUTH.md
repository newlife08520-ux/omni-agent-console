# Shopline 執行期真相（審計用）

> 目的：解釋 **stats／review bundle 裡 `shopline = 0` 或無資料** 時，代表的是 **索引／DB 狀態**，不是「程式沒寫 Shopline」。

## `stats:order-index` 的 `shopline` 計數是什麼？

- 統計的是 **`orders_normalized` 表中 `source = 'shopline'` 的列數**（見 `getOrderIndexStats()`／`order-index`）。
- **若為 0**：表示目前 **沒有任何已正規化寫入的官網訂單列**，典型原因包括：
  1. **從未成功跑過** `npm run sync:orders`（或對應的 `server/scripts/sync-orders-normalized.ts`）。
  2. 品牌 **未設定** 可用的 `shopline_api_token`（及商店網域等），導致同步或 live API 無法取數。
  3. Shopline 端 **該區間／條件下確實無訂單**，或 API 錯誤被略過。

## 與「對話裡查官網訂單」的關係

- 對話查單可走 **live Shopline API**（與索引列數無必然關係）；但若僅依 **本地索引早退**，在索引不完整時會 **漏單或誤判**。
- **Phase 34 review**：當使用者語意為 **「全部／其他／幾筆訂單」** 或 **官網／SHOPLINE**，`unifiedLookupByPhoneGlobal` 會 **`bypassLocalIndex = true`**，跳過本地索引／cache 早退，強制走 **live API 合併路徑**（`order-lookup-policy.shouldBypassLocalPhoneIndex`、`routes`／`order-fast-path`）。

## 相關程式入口

- 索引／統計：`server/order-index.ts`
- 同步：`server/scripts/sync-orders-normalized.ts`
- 手機全域查：`server/order-service.ts` → `unifiedLookupByPhoneGlobal`
- 政策：`server/order-lookup-policy.ts`
