# 05 — 付款狀態：`derivePaymentStatus`、COD、等待付款、Fallback Log

## 檔案

`order-payment-utils.ts`

## 判斷順序（概念）

1. **`isCodPaymentMethod(order)`**  
   - 中文／regex 關鍵字、SuperLanding `pending + to_store/to_home` 特例、Shopline `tw_*_b2c_pay` 等。  
   - 若為 COD → **`kind: cod`**，`label: 貨到付款`。

2. **已付訊號**  
   - `prepaid === true` 或 **`paid_at` 非空** → **`kind: success`**，`label: 已付款`。

3. **訂單狀態已取消（中文）**  
   - → **`kind: failed`**，`label: 付款失敗`（與純「付款失敗」共用標籤，理由碼不同）。

4. **明確失敗訊號**  
   - `payment_status_raw` + `gateway_status` 命中授權失敗、void、decline 等 → **`failed`**。

5. **SuperLanding「等待付款」**（見 03）  
   - 已寄信通知付款、raw 含 `type:success` 但無入帳時間 → **`pending`** + **`等待付款確認`**。

6. **其餘**  
   - **`kind: pending`**，`label` 預設為 **`PENDING_FALLBACK_CUSTOMER_LABEL`（「未付款」）**，並在 **去重後** 打 **`[LIVE_PAYMENT_FALLBACK_PENDING]`** warn（5 秒內同一 `global_order_id` 只印一次，Map 超過 100 筆會清舊 key）。

## 與對客文案的銜接

- `payKindForOrder` 只是 `derivePaymentStatus` 的薄封裝，回傳 `kind` + `label`。
- `formatOrderOnePage` 會把 `payment_status_label`（即此 `label`）與 `displayPaymentMethod(payment_method)` 組成 **「付款：…」** 行；COD 與超商組合時可能出 **「貨到付款（取貨時付款）」**。

## 設計注意

- **kind 不變、只改 label**：例如「等待付款確認」仍屬 **pending**，不影響 **deterministic 允許 pending** 的條件。
- **不要**在沒有工具資料時自行發明付款狀態（Persona 與 `content-guard` 亦相關）。

下一篇：**06** `formatOrderOnePage` 與隱碼。
