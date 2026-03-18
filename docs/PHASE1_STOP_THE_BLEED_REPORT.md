# Phase 1：止血與下一步 — 實作報告

依 **CURSOR_PHASE1_EXECUTION_PROMPT.txt** 與 **CURSOR_PHASE1_STOP_THE_BLEED_AND_NEXT_STEPS.md** 執行 Phase 1，不跳步驟。

---

## 1. 已完成項目（Step 1～9）

| Step | 項目 | 說明 |
|------|------|------|
| **1** | Schema 擴充 | `shared/schema.ts`：`OrderInfo` 新增 `page_id`, `page_title`, `payment_status_raw`, `delivery_status_raw`, `delivery_target_type`, `cvs_brand`, `cvs_store_code`, `cvs_store_name`, `full_address`, `address_raw`, `payment_transaction_id`, `items_structured`；`ActiveOrderContext` 新增 `page_id`, `page_title`, `delivery_target_type`, `cvs_*`, `full_address`, `address_raw`, `source_channel_hint`；新增型別 `DeliveryTargetType` |
| **2** | SuperLanding 結構化 | `server/superlanding.ts`：`parseConvenienceStore()`、`deriveDeliveryTargetType()`；`mapOrder()` 填滿上述 OrderInfo 欄位（convenient_store 解析、address_raw、items_structured） |
| **3** | Shopline 巢狀與 strict | `server/shopline.ts`：`getShoplinePaymentStatusRaw()`、`getShoplineDeliveryStatusRaw()`、`getShoplineDeliveryTargetType()`；`mapShoplineOrder()` 改為依 `order_payment`/`order_delivery`/`delivery_address`/`delivery_data` 嚴格讀取，金額用 `o.total?.dollars` 或 `orderPayment?.total?.dollars`，移除危險 fallback |
| **4** | 依手機全域查單 | `server/superlanding.ts`：匯出 `lookup_order_by_phone_global`（別名）；`server/order-service.ts`：`unifiedLookupByPhoneGlobal()`，合併一頁商店（不限定 page）+ SHOPLINE 依 phone |
| **5** | lookup_more_orders + page_id 保存 | `server/routes.ts`：`buildActiveOrderContext()` 寫入 `page_id`, `page_title`, `delivery_target_type`, `cvs_*`, `full_address`, `address_raw`, `source_channel_hint`；新增 tool `lookup_more_orders`（phone 必填，page_id 可省略、取自 active_order） |
| **6** | Active Order 追問確定性 | `server/routes.ts`：`ORDER_FOLLOWUP_DETERMINISTIC_KW`、`buildDeterministicFollowUpReply()`；追問且命中關鍵字時以 active context 產出固定回覆，`reply_source=active_order_short_circuit`，不進 LLM |
| **7** | 宅配/超商分離 | `server/routes.ts`：已有 `HOME_SHIPPING_KEYWORDS` 與 `CVS_SHIPPING_KEYWORDS`；顯示門市/地址時改為優先使用 `order.delivery_target_type === "cvs"`，再 fallback 關鍵字 |
| **8** | 前台查單不跨品牌 | `server/order-service.ts`：`unifiedLookupById(..., allowCrossBrand)`，預設 `true`；`GET /api/orders/lookup` 改為呼叫 `unifiedLookupById(..., false)` |
| **9** | 查單先送「我幫您查詢中」 | `server/routes.ts`：Tool 迴圈中若任一 tool 為 order lookup，先送出一則「我幫您查詢中～」再執行查單 |

---

## 2. 修改檔案清單

| 檔案 | 變更摘要 |
|------|----------|
| `shared/schema.ts` | OrderInfo / ActiveOrderContext 欄位擴充；DeliveryTargetType |
| `server/superlanding.ts` | parseConvenienceStore、deriveDeliveryTargetType、mapOrder 擴充、lookup_order_by_phone_global |
| `server/shopline.ts` | getShoplinePaymentStatusRaw、getShoplineDeliveryStatusRaw、getShoplineDeliveryTargetType、mapShoplineOrder 巢狀與 strict |
| `server/order-service.ts` | unifiedLookupByPhoneGlobal、unifiedLookupById(allowCrossBrand) |
| `server/routes.ts` | buildActiveOrderContext 擴充、lookup_more_orders tool、deterministic 追問短路、宅配/超商顯示、/api/orders/lookup 使用 unified 且 allowCrossBrand=false、查單前送「我幫您查詢中」 |

---

## 3. 驗收

- **編譯**：`npm run check:server` 已通過。
- **Phase 1 驗收案例**：見 `docs/Phase1-驗收案例與步驟.md`（A～F）與 `docs/PHASE1_ACCEPTANCE_RESULTS.md`（逐條記錄）。
- **可重播腳本**：`npx tsx server/phase1-verify.ts`（state/plan 與 handoff 等）。

---

## 4. 下一步

- 依計劃書執行 Phase 1 驗收劇本（A～F 及 E1～E5 若有定義），將結果填入 `PHASE1_ACCEPTANCE_RESULTS.md`。
- 完成後可進入 Phase 2（依同一計劃書）。
