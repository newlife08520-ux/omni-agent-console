# COD 付款狀態 Hotfix 報告

## 目標

到收／取件時付款（貨到付款，COD）不再被誤判為「付款失敗」；全系統使用同一套付款判斷；deterministic 追問對 COD 固定回「此筆為貨到付款（到收／取件時付款），不是付款失敗」；多筆統計時 COD 獨立計算、不併入 failed；並以驗證案例鎖住行為。

---

## 修改檔案清單

| 檔案 | 變更摘要 |
|------|----------|
| `server/order-payment-utils.ts` | **新增**。`isCodPaymentMethod(order)`、`derivePaymentStatus(order, statusLabel, source)`，先判 COD 再判 success/failed/pending。一頁商店特例：source=superlanding + payment_method=pending + 超商/to_store + prepaid=false + paid_at=null → COD。 |
| `shared/schema.ts` | `ActiveOrderContext.payment_status` 型別新增 `"cod"`：`"success" \| "pending" \| "failed" \| "cod" \| "unknown"`。 |
| `server/order-active-context.ts` | 僅依賴 `derivePaymentStatus` 產出 `payment_status`；COD 時不再將 fulfillment 設為「付款失敗」或「待付款」，維持原訂單狀態（如待出貨）。 |
| `server/order-reply-utils.ts` | `payKindForOrder` 改為呼叫 `derivePaymentStatus`，COD 對外 label 為「貨到付款（到收／取件時付款）」。 |
| `server/routes.ts` | `buildDeterministicFollowUpReply`：`ctx.payment_status === "cod"` 時固定回「此筆為貨到付款（到收／取件時付款），不是付款失敗」並接訂單狀態與門市／地址。`buildActiveOrderContext` 改為委派 `buildActiveOrderContextFromOrder`，刪除本地重複付款邏輯。工具內一律使用 `payKindForOrder`（order-reply-utils）。 |
| `server/order-fast-path.ts` | 已使用 `payKindForOrder` 與 `buildActiveOrderContextFromOrder`；多筆統計 `codn` 獨立，聚合文案含「N 筆貨到付款」。 |
| `server/autonomous-hardening-verify.ts` | 新增 5 個 COD 驗證案例（見下）。 |

---

## 修前誤判原因

- **order-active-context** 未先判斷 COD，僅依 `prepaid`、`paid_at`、status 關鍵字判斷，導致「到收／取件時付款」在 prepaid=false、paid_at=null 時被標成 `payment_status=failed`，fulfillment 被改成「付款失敗」。
- **order-reply-utils** 的舊 `payKindForOrder` 未涵蓋「到收」「取件時付款」及一頁商店 pending+to_store 特例。
- **routes** 內另有本地 `buildActiveOrderContext` 與付款關鍵字邏輯，未先判 COD，與 order-active-context 重複且不一致。
- deterministic follow-up 依 `ctx.payment_status` 顯示文案，COD 被存成 failed 時就會回「付款未成功，請重新下單或聯繫客服」。

---

## 修後規則摘要

1. **單一真相**：所有付款狀態皆經 `order-payment-utils.derivePaymentStatus`（或對外介面 `payKindForOrder`）。
2. **先判 COD**：`isCodPaymentMethod(order)` 為 true 時一律回傳 `kind: "cod"`，label「貨到付款（到收／取件時付款）」。
3. **COD 判定涵蓋**：  
   - 明確字串：貨到付款、到收、取件時付款、取貨付款、到店付款、cash_on_delivery、COD 等。  
   - 一頁商店特例：source=superlanding、payment_method=pending、超商/to_store/cvs、prepaid=false、paid_at=null。
4. **不再把 COD 存成 failed**：order-active-context 與 routes 皆透過 `buildActiveOrderContextFromOrder`，內部使用 `derivePaymentStatus`，COD 不會再寫入 failed。
5. **Deterministic 追問**：`payment_status === "cod"` 時回覆「此筆為貨到付款（到收／取件時付款），不是付款失敗」+ 目前訂單狀態 + 門市／地址。
6. **多筆統計**：COD 獨立計數（如「N 筆貨到付款」），不併入 failed。

---

## 驗證結果（5 個 COD 案例）

| 案例 | 情境 | 預期 | 結果 |
|------|------|------|------|
| 1a | SuperLanding 超商到收（pending + to_store + cvs + prepaid=false + paid_at=null） | `isCodPaymentMethod` 為 true | ✅ |
| 1b | 同上 | `derivePaymentStatus` → kind= cod、label 含「貨到付款」 | ✅ |
| 1c | routes 內 deterministic 分支 | 程式碼含「此筆為貨到付款（到收／取件時付款），不是付款失敗」且 `payment_status === "cod"` | ✅ |
| 2 | payment_method = "到收" | kind = cod | ✅ |
| 3 | payment_method = "取件時付款" | kind = cod | ✅ |
| 4 | 信用卡未付款（credit_card、prepaid=false、paid_at=null） | kind ≠ cod（failed 或 pending） | ✅ |
| 5 | 多筆混合（success / failed / cod 各一） | 聚合摘要含「1 筆付款成功」「1 筆未成立／失敗」「1 筆貨到付款」 | ✅ |

驗證執行：`npx tsx server/autonomous-hardening-verify.ts`（含上述 5 個 COD 案例）。

---

## 預期回覆範例

- **修前（誤）**：付款未成功，請重新下單或聯繫客服  
- **修後（正確）**：訂單編號 AQX13705。此筆為貨到付款（到收／取件時付款），不是付款失敗。目前訂單狀態：待出貨。取貨門市：全家 全家烏日新成員店，門市地址：台中市烏日區學田路732號。

---

## 備註

- 若日後新增付款方式或來源，應在 `order-payment-utils.ts` 擴充 `isCodPaymentMethod` / `derivePaymentStatus`，勿在 order-active-context、routes、order-reply-utils 重寫判斷邏輯。
- 回歸時請執行 `npm run check:server` 與 `npm run verify:hardening`（或直接執行 `npx tsx server/autonomous-hardening-verify.ts`）以確認 COD 案例仍通過。
