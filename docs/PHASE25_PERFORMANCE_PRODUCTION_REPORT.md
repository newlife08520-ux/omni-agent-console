# Phase 2.5 性能與上線收斂報告

## 修改摘要

1. **Prompt Slimming**（`server/services/prompt-builder.ts`）  
   - `order_lookup_lite`：無 CATALOG / KNOWLEDGE / IMAGE  
   - `order_followup_lite`：更短（已有 active order 追問輪）  
   - `image_lookup_full`：使用者傳圖時仍帶完整 catalog/knowledge/image  
   - `answer_directly_full`：其餘模式維持整包  

2. **routes 觀測**  
   - `prompt_profile=`、`prompt_chars=`、`catalog_included=`、`knowledge_included=`、`image_included=`、`prompt_sections=`、`first_visible_reply_ms=`  

3. **多筆 deterministic**（`server/order-multi-renderer.ts`）  
   - 商品+手機 API 多筆、`lookup_order_by_date_and_contact` 多筆、`lookup_more_orders`、`lookup_more_orders_shopline` 多筆 → `deterministic_skip_llm` + multi active context  

4. **日期**（`server/order-service.ts`）  
   - `filterOrdersByDateRange` + Shopline 日期查詢後硬濾區間  

5. **Payment Truth v2**（`server/order-payment-utils.ts`）  
   - 信用卡/LinePay 未付 + 新訂單 → **pending** 非 failed  
   - 轉帳/ATM 未入帳 → pending  
   - 已取消 → failed  
   - `reason` / `confidence` 供除錯  

6. **驗證**  
   - `npm run verify:phase25` = check + hardening + phase24 + **phase25** + stats  

## 仍受外部限制

- 無 Shopline 憑證時無法實測官網 API 日期／多筆路徑。  
- verify 刻意不跑 `answer_directly_full` 整包 catalog（避免拉銷售頁 API 過久）。  
