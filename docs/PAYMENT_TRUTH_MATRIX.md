# PAYMENT_TRUTH_MATRIX.md（R1-4）

> 單一實作來源：`server/order-payment-utils.ts` 之 `derivePaymentStatus`。對客標籤見同檔 `labels` 與 `order-reply-utils` 之 `displayPaymentMethod`。

## 判斷順序（摘要）

1. **COD**（`isCodPaymentMethod`）：含「貨到付款／到收／取件時付款」、及一頁超商 `pending`+`to_store`/cvs+非預付+無 `paid_at` 等 **→ `cod`**  
   - **對客**：`貨到付款（到收／取件時付款）` — **不可**說成線上付款失敗。

2. **Shopline `payment_status_raw`**（若有）：`paid/complete/...` → success；`pending/unpaid/...` → pending；`fail/void/...` → failed。

3. **Superlanding `payment_status_raw`**：含 fail/紅叉/未成立/中文失敗訊號 → **failed**（避免誤當 pending）。

4. **狀態關鍵字**：失敗類 → failed；取消 → failed；`prepaid` 或 `paid_at` → success；成功狀態關鍵字 → success（含特例與卡類 pending）。

5. **LINE Pay / 信用卡**：未付且具失敗訊號 → failed；僅未付 → pending（見 `superlanding_linepay_card_fail_signal` 等分支）。

6. **ATM／虛擬帳戶等**：常為 **pending**（待繳／待確認）。

## 語意矩陣（對客）

| 內部 kind | 客戶可讀標籤（預設） | 禁止 |
|-----------|----------------------|------|
| `cod` | 貨到付款（到收／取件時付款） | 說成付款失敗 |
| `failed` | 付款失敗／訂單未成立 | 說成「待付款」 |
| `pending` | 待付款或待確認 | 把明確失敗說成僅待確認 |
| `success` | 付款成功 | 與 COD 混淆 |
| `unknown` | 付款狀態未明 | 硬掰具體金流結果 |

## Raw 訊號來源

| 來源 | 欄位 / 訊號 |
|------|-------------|
| Superlanding | `payment_status_raw`、`status`、`payment_method`、`prepaid`、`paid_at`、`shipping_method`、`delivery_target_type` |
| Shopline | `payment_status_raw`（優先於純推測） |

## 驗證

- `npm run verify:r1` 內含：LINE Pay fail → failed、CVS pending → cod、卡類新訂單 → pending。
