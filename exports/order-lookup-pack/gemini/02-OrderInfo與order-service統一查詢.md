# 02 — OrderInfo 與 `order-service` 統一查詢

## `OrderInfo`（`schema.ts`）

後端對「一筆訂單」的標準結構，欄位包含（節錄）：

- **識別**：`global_order_id`、`status`、`source`（`superlanding` | `shopline` | `unknown`）
- **金額與商品**：`final_total_order_amount`、`product_list`、`items_structured`（常為 JSON 字串）
- **買家**：`buyer_name`、`buyer_phone`、`buyer_email`
- **物流**：`shipping_method`、`delivery_target_type`（`home` | `cvs` | `unknown`）、`cvs_brand`、`cvs_store_name`、`full_address`、`tracking_number`、`shipped_at`
- **付款**：`payment_method`、`prepaid`、`paid_at`、`payment_status_raw` 等
- **Shopline 延伸**：`store_location`（超商門市顯示用）

所有查詢路徑最終應能把外部 API 結果 **正規化** 成 `OrderInfo`，後續 `derivePaymentStatus`、`formatOrderOnePage` 才一致。

## `order-service.ts` 職責

- **統一查單**：`unifiedLookupById`、`unifiedLookupByPhoneGlobal`、`unifiedLookupByProductAndPhone`、`unifiedLookupByDateAndContact` 等。
- **來源偏好**：依對話關鍵字／政策（`order-lookup-policy.ts`）決定先查 Shopline 或 SuperLanding。
- **資料覆蓋**：`data_coverage` 如 `local_only`（僅本地索引）、`api_only`、`merged_local_api` — 影響是否允許 **單筆 deterministic**（本地-only 時常只給候選摘要，不當最終定案）。
- **跨品牌**：部分函式在允許時會掃其他品牌的 SuperLanding 憑證（需小心與品牌隔離需求）。

## 與工具層的銜接

`tool-executor.service.ts` 呼叫上述 unified 函式取得 `orders[]`，再對每筆算：

- `getUnifiedStatusLabel(status, source)`
- `payKindForOrder` → 內部用 `derivePaymentStatus`
- `formatOrderOnePage(...)` 產生 `one_page_summary` 或 `one_page_full`

## 讀碼建議

1. 搜尋 `export async function unifiedLookup` 看進入點與錯誤處理。  
2. 搜 `DataCoverage` / `local_only` 理解何時 **不應** 對客人講死訂單細節。  
3. 對照 `order-index.ts` 了解本地 `orders_normalized` 快取如何加速手機／單號查詢。

下一篇：**03** 專讲 SuperLanding 與 `superlanding.ts`。
