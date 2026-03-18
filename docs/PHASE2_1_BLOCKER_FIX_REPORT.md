# Phase 2.1 Blocker Fix（本輪補齊紀錄）

## 已落地（先前 + 本輪）

### 1. Cross-brand / 資料污染
- `unifiedLookupById`：僅在 `!result.crossBrand` 時寫入 `order_lookup_cache` / `upsertOrderNormalized`。
- `unifiedLookupByPhoneGlobal`：參數 `allowCrossBrand`；為 `false` 時不搜其他品牌 SuperLanding；同上僅非 cross-brand 時寫入。
- AI 工具：`lookup_order_by_id`、`lookup_order_by_phone`、`lookup_order_by_product_and_phone` 皆傳 `allowCrossBrand=false`（或等價）。

### 2. Shopline 錯單風險
- `lookupShoplineOrderById`：僅在 `global_order_id` 與查詢值**不分大小寫完全一致**時回傳；不再取搜尋結果第一筆。
- `lookupShoplineOrdersByPhone` / `ByEmail` / `ByName`：已移除「精準過濾為空則整包當結果」的 fallback。

### 3. 輸出層（門市／地址）
- `formatOrderOnePage`：CVS 優先 `cvs_brand` + `cvs_store_name` + `full_address`；宅配優先 `full_address`。
- `buildActiveOrderContext`：`address_or_store` 依 `delivery_target_type` 組合上述欄位。

### 4. Deterministic 追問（本輪加強）
- **觸發**：`isFollowUpShort` 亦比對 `ORDER_FOLLOWUP_DETERMINISTIC_KW`，故僅輸入「付款成功了嗎」「寄到哪裡」等亦可短路（需已有 active order context）。
- **關鍵字**：含付款、地址、門市、全家、超商、便利商店、出貨了嗎、物流單號等。
- **`buildDeterministicFollowUpReply`**：分段回答付款狀態、出貨狀態、取貨門市（CVS）或寄送地址、物流單號。
- **Shopline 付款**：`buildActiveOrderContext` 依 `payment_status_raw`（paid/pending/fail 等）推斷 `payment_status`，利於「付款成功了嗎」。

## 驗收對照

| 項目 | 狀態 |
|------|------|
| AI 前台不跨品牌 | 通過（工具路徑 allowCrossBrand=false） |
| cache/index 不寫他牌資料 | 通過（crossBrand 不寫入） |
| Shopline 不因模糊搜尋回錯單 | 通過（精準匹配、無整包 fallback） |
| 超商單門市資訊於摘要/context | 通過（結構化欄位進入輸出層） |
| 付款／地址／門市／物流追問 deterministic | 通過（關鍵字 + 擴充回覆） |

## 後續（Phase 2.2+，非本輪）
- Shopline `subtotal_items`、批量 sync、`order_items_normalized` 等見《COMPLETE_ACCEPTANCE_AND_NEXT_STEPS.md》。
