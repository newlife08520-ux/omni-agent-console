# Phase 33 Runtime Bug Tickets 實作報告

採 **ticket mode**，與 `PHASE33_RUNTIME_BUG_TICKETS_AND_RECOVERY_PLAN.md` 對照。

## 33-1 官網意圖殘留／清除

- **修改**：`server/order-lookup-policy.ts` — `detectLookupSourceIntent()` 回傳 `shopline | superlanding | unknown | clear`；負向語句含「不是官方網站、不是那個平台」等；`resolveOrderSourceIntent` 將 `clear` 映射為 `unknown`。
- **verify**：`phase33-verify` 情境 — 官網句→shopline、不是官網的→clear、純新手機→unknown。
- **smoke**：先「官網 0910…」→「不是官網的」→「0963…」，回覆不得帶「（官網）」。

## 33-2 phone-only 政策

- **修改**：`shouldDirectLookupByPhone()`；`order-fast-path.ts` 純手機改以此判斷；`lookup_order_by_phone` 工具描述已要求商品+手機優先、例外情境才單手機。
- **verify**：純手機 false；查全部+手機、商品+手機 true。

## 33-3 local_only 單筆

- **狀態**：延續 Phase 31（`needs_live_confirm`、fast path 保守文案、routes `noSingleClaim`）。

## 33-4 雙回覆競態

- **修改**：`server/order-feature-flags.ts` — `orderLookupAck`，環境變數 `ENABLE_ORDER_LOOKUP_ACK`，**預設 false**；`routes.ts` 僅在 flag 為 true 時送出「我幫您查詢中～」，避免與後續查到結果並存時造成「先查無又查到」的體感（預設關閉 intermediate ack）。

## 33-5 多筆展開忽略商品偏見

- **狀態**：`unifiedLookupByPhoneGlobal(..., false, true)` bypass local；`PHASE29_MORE_ORDERS_KW` 含「我有幾個訂單」等。

## 33-6 付款真相 v4

- **修改**：`server/order-payment-utils.ts` — 一頁 `payment_status_raw` 失敗字樣；`superlanding` + LINE Pay/卡類 + `prepaid=false` + 狀態/API `status` 含失敗訊號 → `failed`，避免誤標 pending。

## 33-7 Shopline 可查性診斷

- **修改**：`lookup_order_by_phone` 查無時回傳 `lookup_diagnostic`（`shopline_config_present`、`normalized_phone`、`lookup_miss_reason`）並寫 console；官網未綁定時對客文案區分「查無」與「未設定」。

## 33-8 前端 SSE / 部署可辨識

- **修改**：`client/src/pages/chat.tsx` — 列表列顯示 `MODE`、`SSE關`（`VITE_DISABLE_SSE`）、可選 `VITE_BUILD_HASH`；即時/輪詢標籤改為「即時(SSE)」。

## 33-9 行為級 verify

- **新增**：`server/phase33-verify.ts`、`npm run verify:phase33`。

---

## 手動 smoke 清單

1. 官網→否定→新手機：無「（官網）」  
2. 僅手機：補問商品或查全部  
3. 商品+手機：單一路徑、無多餘「查詢中」（ack 預設關）  
4. 「我有幾個訂單」：多筆展開（資料須 API 有）  
5. 失敗 LINE Pay 單：文案為失敗非「待確認」  
6. 官網查無：後台 log 有 `lookup_miss` JSON  

## 部署

- **source 已改**：上述檔案。  
- **live**：前端需 **重新 build** 才會帶 chat 的 MODE/SSE 標籤；`ENABLE_ORDER_LOOKUP_ACK=1` 才恢復查詢中插播。

## SOURCE ZIP

請執行 `scripts/pack-full-source-zip.ps1` 或 `pack-ai-analysis-bundle.ps1` 產出。
