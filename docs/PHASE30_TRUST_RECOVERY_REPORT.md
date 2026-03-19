# Phase 30 信任恢復實作報告

## 目標

把「查單信任」救回來：資料完整性不足時不單筆定案、視窗不漏單、官網/一頁不混答、前端可觀測。

## 已修改檔案

| 檔案 | 變更 |
|------|------|
| `server/superlanding.ts` | `lookupOrdersByPageAndPhone` 多日期視窗改為合併 `byOrderId`，不再第一個視窗命中就 return |
| `server/order-service.ts` | `UnifiedOrderResult` 新增 `data_coverage?: DataCoverage`；local 回傳設 `local_only`，API 回傳設 `api_only`，合併為 `merged_local_api` |
| `server/order-feature-flags.ts` | 新增 `conservativeSingleOrder`（預設 true）：local_only 單筆時不直接定案，回覆帶「僅已同步資料」說明 |
| `server/routes.ts` | `lookup_order_by_phone` 單筆時若 `data_coverage === 'local_only'` 且 `conservativeSingleOrder`，回覆前加說明並在 payload 帶 `data_coverage` |
| `client/src/pages/chat.tsx` | 聯絡人列上方顯示連線狀態：「即時」或「輪詢」，便於辨識 SSE 是否生效 |
| `server/phase30-verify.ts` | 新增 Phase 30 靜態與行為檢查 |
| `package.json` | 新增 `verify:phase30`（依賴 verify:phase29 + phase30-verify） |

## Root cause 對應

- **視窗早退**：`lookupOrdersByPageAndPhone` 與 P29 的 `lookupOrdersByPhone` 一致，改為多視窗掃完合併去重。
- **Partial local hit**：`unifiedLookupByPhoneGlobal` 從 local 回傳時帶 `data_coverage: 'local_only'`，呼叫端可拒絕單筆定案。
- **Phone-only 規則**：P29 已收緊 ORDER_LOOKUP_RULES；P30 再以 `conservativeSingleOrder` + local_only 單筆時強制帶說明。
- **單筆問其他訂單**：P29 已做 phase29_more_orders_expand 優先執行。
- **商品明細**：P29 已統一 `formatProductLinesForCustomer`。
- **前端 SSE/輪詢可觀測**：左側聯絡人區顯示「即時」/「輪詢」，`/api/events` 出錯時既有橫幅＋狀態標示可辨識。

## 驗證

```bash
npm run verify:phase30
```

## 營運建議

- 若仍出現「只看到一筆」：確認 sync 已跑 90 天或 `--backfill`，並檢查日誌是否有多視窗合併筆數。
- 若希望單筆一律直接回、不帶說明：設 `CONSERVATIVE_SINGLE_ORDER=false`（不建議）。
