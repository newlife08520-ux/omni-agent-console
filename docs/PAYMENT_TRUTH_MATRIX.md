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

## Fixture 對照表（≥5 類，`verify:r1` 與本檔一致）

| # | 案例 | 路徑 | 預期 `kind` | 對客標籤要點 |
|---|------|------|-------------|----------------|
| 1 | LINE Pay `payment_status_raw` 失敗 | 記憶體 `OrderInfo` fixture | `failed` | 付款失敗／訂單未成立 |
| 2 | 一頁 CVS + `pending` + 非預付 | 記憶體 `OrderInfo` | `cod` | 貨到付款（到收／取件時付款） |
| 3 | 信用卡新訂單未付 | 記憶體 `OrderInfo` | `pending` | 待付款或待確認 |
| 4 | 紅叉／中文失敗 raw | 記憶體 `OrderInfo` | `failed` | 勿當 pending |
| 5 | 狀態已取消 | 記憶體 `OrderInfo` | `failed` | 勿當待付款 |
| 6 | **去識別真實結構** `superlanding-esc20981-linepay-fail.fixture.sanitized.json` | `mapSuperlandingOrderFromApiPayload` → `derivePaymentStatus` | `failed`（或依 raw 映射；與 superlanding 映射一致） | 與營運「未成立」語義一致 |

> **Shopline**：本機唯一真相 world 無 API；**不**宣稱已完成 shopline raw fixture；僅 superlanding 走完整 JSON 路徑。

## 驗證

- `npm run verify:r1`：含上表 1–6 相關斷言（含 sanitized JSON 全鏈）。
