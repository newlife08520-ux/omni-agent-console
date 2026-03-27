# SHOPLINE_TRUTH_REPORT（R1-3）

## 本環境可用性（實測）

**指令：**

```bash
cd Omni-Agent-Console
npx tsx server/scripts/diagnose-review-bundle-db.ts
```

**與 Shopline 相關欄位（本機快照）：**

- `brands.shopline_configured`: **0**
- `orders_normalized_by_source`: 僅 **superlanding**，無 shopline 列

**結論（本機）**：**無**可用 Shopline brand config（token+domain 未齊），**無法**提供「非 demo 的 masked 官網 API 成功 case」；執行期改為 **明確降級**（見 `order-fast-path.ts`：官網意圖但未設定 API 時直接說明無法代查官網）。

## 程式層行為（R1-1 / R1-3）

- `preferSource === "shopline"` 時：`unifiedLookupById` / `unifiedLookupByProductAndPhone` / `unifiedLookupByDateAndContact` **不再回落**一頁商店，避免假官網結果。
- `isShoplineLookupConfiguredForBrand(brandId)`：用於 fast path **未設定即降級**，避免假裝可查 live 官網。

## 有 Shopline 設定的環境要如何驗

1. 在該環境跑 `diagnose-review-bundle-db.ts`，確認 `shopline_configured >= 1`。
2. 以 **遮罩後** 真實單號／手機在測試對話驗證（勿將 demo 當 live proof）。
