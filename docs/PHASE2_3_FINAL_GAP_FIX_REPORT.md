# Phase 2.3 Final Gap Fix 報告

**日期**：2026-03-16  
**依據**：`LATEST_ZIP_REVIEW_FINDINGS.md`、`CURSOR_PHASE23_FINAL_GAP_FIX_PROMPT.txt`

---

## 一、已修復項目

### A. Shopline 商品名 + 手機過濾
- **檔案**：`server/order-product-filter.ts`（`filterOrdersByProductQuery`、`orderMatchesProductQuery`）
- **檔案**：`server/order-service.ts` — `unifiedLookupByProductAndPhone` 之 `runShopline()` 在電話查詢後依 `productQueryForShoplineFilter`／`matchedPages` 商品名過濾；過濾後 0 筆則 `found: false`，**不**回傳同手機全部訂單。
- **路由**：`lookup_order_by_product_and_phone` 呼叫時傳入 `productName` 作為第七參數。

### B. 圖片／視覺查單
- **檔案**：`server/routes.ts` — `handleImageVisionFirst`
- `unifiedLookupById(..., undefined, false)` **禁止 cross-brand**
- 輸出改為 **`formatOrderOnePage`** + **`buildActiveOrderContextFromOrder`**（門市／宅配與主查單一致）

### C. 商品 + 手機本地多筆 deterministic
- **檔案**：`server/routes.ts` — `localHits.length > 1` 時比照手機多筆：
  - `deterministic_skip_llm: true`、`deterministic_customer_reply`
  - `active_order_candidates`、`aggregate_payment_summary`、`candidate_source_summary`、成功／失敗／待付／貨到付 id 列表
  - 後續仍可走「只看成功／失敗／第 N 筆／全部訂單」等 multi_order_router

### D. 自動驗證擴充
- **檔案**：`server/autonomous-hardening-verify.ts`（≥10 項）
  1. cacheKeyOrderId / cacheKeyPhone 各 scope  
  2. 跨 source 去重鍵  
  3. ask_for_identifier  
  4. off_topic 不誤觸  
  5. return 流程不誤觸  
  6. Shopline 商品過濾（同手機兩筆不同商品）  
  7. 多筆付款狀態統計  
  8. product+phone payload 鍵名  
  9. routes 圖片路徑 `allowCrossBrand=false` + `buildActiveOrderContextFromOrder`  
  10. formatOrderOnePage CVS / home  

---

## 二、驗證輸出（範例）

```bash
npm run check:server
npm run verify:hardening
```

成功時最後一行類似：

```
[autonomous-hardening-verify] OK — 10 checks + cache/dedupe/fast-path + shopline filter + stats + image + format
```

---

## 三、仍需人工最終驗收（建議 8 題）

1. **官網 + 商品名 + 手機**：同手機多筆不同商品，僅應列出與關鍵字相符之 Shopline 訂單。  
2. **官網 + 商品名 + 手機**：關鍵字與任一票都不符時，應查無／勿整包回傳。  
3. **截圖／圖片訂單號**：辨識成功後僅查當前品牌，勿出現他牌訂單。  
4. **圖片查單摘要**：超商單應顯示門市相關欄位；宅配應顯示地址（與文字查單一致）。  
5. **本地商品+手機多筆**：應直接出簡表＋統計，第二輪勿再由 LLM 改寫（可看 `deterministic_skip_llm` / log）。  
6. **多筆後追問**：「只看成功」「只看失敗」「第二筆」「全部訂單」行為與純手機多筆一致。  
7. **純手機合併**：一頁 + 官網同手機多筆，簡表含來源標籤。  
8. **Fast path 純單號**：`reply_source=order_fast_path`、`used_llm=0`。

---

## 四、ZIP

與專案同層：`Omni-Agent-Console-PHASE23-LATEST.zip`（打包前請再執行一次打包指令以含本報告）。
