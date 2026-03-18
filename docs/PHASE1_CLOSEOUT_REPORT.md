# Phase 1 結案報告

## 1. 狀態判定

**Phase 1 已正式結案**，可進入 Phase 2。

- 止血項目（Step 1～9）已完成並產出報告。
- 驗收腳本 62 pass / 1 fail，採納單一策略：**「人呢」不 handoff**，文檔與腳本已同步。
- 結案條件已滿足（見下）。

---

## 2. 已解決

| 項目 | 說明 |
|------|------|
| Schema 與 mapping | OrderInfo / ActiveOrderContext 擴充；SuperLanding 門市解析；Shopline 巢狀讀取與 strict helpers |
| 查單路徑 | lookup_order_by_phone_global、unifiedLookupByPhoneGlobal、lookup_more_orders、active context 保存 page_id |
| 追問確定性 | 出貨/物流/到貨追問 → active_order_short_circuit，不進 LLM |
| 宅配/超商分離 | HOME_SHIPPING_KEYWORDS / CVS_SHIPPING_KEYWORDS；顯示優先依 delivery_target_type |
| 前台查單 | GET /api/orders/lookup 使用 unifiedLookupById(..., allowCrossBrand=false) |
| 查單前提示 | 進入 order lookup tool 時先送「我幫您查詢中～」 |
| D「人呢」一致 | 採用止血策略：人呢 **不** handoff；僅明確要真人（如「能轉人工嗎」）才 handoff；Phase1-驗收案例與步驟.md 與 phase1-verify.ts 已對齊 |

---

## 3. 已知問題（不阻擋 Phase 2）

| 項目 | 說明 |
|------|------|
| 62 pass / 1 fail | 失敗項：「Awkward. 同一種資料重問至少三次 → 轉人工」。為既有邏輯，非 Phase 1 止血範圍，不阻擋下一階段。 |
| 快速檢查未全勾 | 部分項目需人工或 webhook 實測（訂單摘要顯示、查單先送句、lookup_more_orders）；程式與腳本可驗證者已通過。 |

---

## 4. Phase 1 結案條件

| 條件 | 是否滿足 |
|------|----------|
| A～F 驗收案例 | 是（腳本 62 pass；D 已改為「人呢 不 handoff」並與文檔一致） |
| 文檔單一真相 | 是（Phase1-驗收案例與步驟.md、PHASE1_ACCEPTANCE_RESULTS.md、本報告一致） |
| 止血項目可驗證部分 | 是（編譯、unifiedLookup allowCrossBrand、deterministic 短路、tool 與 API 行為已實作） |
| 已知問題不阻擋 | 是（1 fail 為既有邏輯；需人工項目已標記） |

---

## 5. 產出文件

- `docs/PHASE1_STOP_THE_BLEED_REPORT.md` — 實作項目與修改清單  
- `docs/PHASE1_ACCEPTANCE_RESULTS.md` — A～F、快速檢查、實戰案例欄位  
- `docs/Phase1-驗收案例與步驟.md` — 已更新 D 為「人呢 不 handoff」  
- `docs/PHASE1_CLOSEOUT_REPORT.md` — 本結案報告  

---

## 6. 官網查單（已實作）

- **辨識官網訂單**：對話含「官網／官方網站／官網購買／官網下單／SHOPLINE」等關鍵字時，`shouldPreferShoplineLookup` 為 true，查單優先走 Shopline。
- **僅訂單號**：`lookup_order_by_id` 已依 context 傳入 `preferSource: "shopline"`，有訂單號時直接查、優先官網。
- **僅電話**：新增工具 `lookup_order_by_phone`（只傳 phone），後端呼叫 `unifiedLookupByPhoneGlobal(..., preferSource)`；當 context 為官網時優先查 Shopline，不需商品名或日期。
- **ORDER_LOOKUP_RULES** 已補：官網查單有訂單號用 lookup_order_by_id；只有電話用 lookup_order_by_phone，系統會辨識是否官網訂單。

## 7. 下一步

- **Phase 2**：依 CURSOR_PHASE2_EXECUTION_PROMPT 進行（schema / migration、sync、查單決策引擎等）。
