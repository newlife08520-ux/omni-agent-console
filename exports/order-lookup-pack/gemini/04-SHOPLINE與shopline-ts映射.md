# 04 — SHOPLINE 與 `shopline.ts` 映射

## 定位

品牌若在後台設定 **Shopline Open API**（`shopline_store_domain` + `shopline_api_token`），查單可走 **Open API**（`open.shopline.io`）。原始 JSON 與一頁商店差異大，核心在 **`order_payment`**、**`order_delivery`**、**`delivery_data`**，而不是頂層 `payment_method`。

## `mapShoplineOrder` 重點（`shopline.ts`）

1. **付款**
   - 優先 **`order_payment.payment_type`**（穩定代碼，如 `tw_711_b2c_pay`）。
   - 次選 **`order_payment.name_translations["zh-hant"]`**（對客最準的中文）。
   - `payment_status_raw` 取自 `order_payment.status`；`paid_at` / `prepaid` 依 API 狀態與時間欄位整理。

2. **配送**
   - 組合 `order_delivery.platform`、`delivery_type`、中文配送名，寫入 `shipping_method` 字串，讓 `displayShippingMethod` 能辨識 `tw_711`、`pickup`、`home_delivery` 等片段。

3. **超商門市**
   - `delivery_data.location_name` / `store_address` → **`store_location`**（並保留 `cvs_store_name` 等）。
   - `getShoplineDeliveryTargetType` 判斷 `cvs` vs `home`。

4. **COD**
   - `isCodPaymentMethod` 在 `source === "shopline"` 時加判 **B2C 取貨付款代碼**、宅配 COD、中文「貨到付款」等（見 `order-payment-utils.ts`）。

## 對客顯示

- `formatOrderOnePage` 在超商情境下會出 **「配送：…」** 與 **「取貨門市：…」**；`store_location` 與 `cvs_*` 併用。
- `displayShippingMethod`（`order-reply-utils.ts`）對 Shopline 代碼有專段，避免只顯示 raw 英文。

## 與 deterministic

手機查單單筆時，**不應因 source 為 shopline 就關閉 deterministic**；條件為 **付款 kind + 摘要長度 + 非 local_only**（見 `tool-executor` 內 `DEBUG_PHONE_DETERMINISTIC` 日誌區塊）。

下一篇：**05** 付款狀態完整邏輯 `order-payment-utils.ts`。
