# 03 — SuperLanding（一頁商店）與 `superlanding.ts`

## 定位

SuperLanding 為台灣常見 **一頁式商店** 後台。本專案透過 **merchantNo + accessKey** 向官方 API 拉單、拉商品頁對照（`ProductPageMapping`），並將回傳 JSON **映射** 為 `OrderInfo`（`source` 通常設為 `superlanding`）。

## `superlanding.ts` 常見能力（概念）

- **分頁／列表**：依條件抓取訂單列表（實作細節見檔內 `fetchOrders`、`lookupOrderById` 等）。
- **手機／商品查詢**：與 `order-index` 本地索引搭配，可做 **先本地後 API** 或 **bypass 本地**（見 `order-lookup-policy`）。
- **欄位映射**：將 API 的 `payment_method`（有時為 `pending`）、`shipping_method`（`to_store` / `to_home` 等）轉成 `OrderInfo`，供 **COD 推斷**（`isSuperLandingCvsCod` / `isSuperLandingHomeCod` 在 `order-payment-utils.ts`）。

## SuperLanding 特殊付款語意（重要）

實務上曾出現 **`payment_method` 為中文描述**（例如「已寄信通知客戶付款!」），且 raw 字串含 `type:success` 但 **無 `paid_at`**。這在商業上代表 **已通知客人付款、尚未實際入帳**。

`derivePaymentStatus`（`order-payment-utils.ts`）針對 `source === "superlanding"`：

- 以 regex 匹配「已寄信…付款」「等待付款」等 → `kind: pending`、`label: 「等待付款確認」`（避免客人看到籠統「未付款」困惑）。
- `payRaw` 含 `type:success` 且無 `paid_at`／非 prepaid → 同樣 **pending + 等待付款確認**（理由碼不同）。

## 與查單回覆的關係

- 一頁商店訂單編號常帶品牌前綴（如 `ESC…`），與 Shopline 長數字不同；`tool-executor` 的 `classifyOrderNumber` 會區分金流號／物流號等。
- **Deterministic**：單筆查詢在付款 kind 為 `success` | `cod` | `pending` 且 `one_page_summary` 長度足夠時，可 `deterministic_skip_llm`；**pending（含等待付款確認）仍屬允許 kind**，與 failed 不同。

下一篇：**04** Shopline 與 `shopline.ts` 映射。
