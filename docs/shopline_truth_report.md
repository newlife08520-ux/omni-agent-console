# SHOPLINE_TRUTH_REPORT（R1-3）

## 一句話結論（唯一真相 world：本機已量測 DB）

**官網（SHOPLINE）即時 API 查詢：目前不可用。**  
依據：`shopline_configured = 0`（無品牌同時具備有效 `shopline_api_token` + `shopline_store_domain`）。  
**系統已降級**：官網意圖時不 fallback 一頁、不冒充官網結果；未設定 API 時對客說明無法代查（`order-fast-path.ts` / `unifiedLookup*`）。

---

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

## 若未來某環境 `shopline_configured >= 1`（預期行為）

- `diagnose-review-bundle-db.ts` 之 `shopline_configured` 會 **≥ 1**。  
- 程式允許走 Shopline live；**仍不會**在「客戶明講官網」時回落一頁冒充官網。  
- 真實成功 case 須以 **遮罩後** 單號／手機在該環境對話驗收（**禁止**以 demo payload 冒充 live proof）。
