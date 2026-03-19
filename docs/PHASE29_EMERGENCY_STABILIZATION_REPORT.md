# Phase 2.9 緊急止血實作報告

## 目標對照

| 項目 | 作法 |
|------|------|
| 一頁商店手機全域漏單 | `lookupOrdersByPhone` 各日期視窗掃描後合併 `byOrderId`，並加 180 天視窗 |
| 索引時間窗過短 | `sync-orders-normalized.ts` 預設 **90 天**；`--backfill` **365 天** |
| phone-only 過激 | `<ORDER_LOOKUP_RULES>` 收緊；多筆不可擅自選一筆 |
| 切換訂單 | `CLEAR_ACTIVE_ORDER_KW` 擴充（查別筆、換一筆等） |
| 單筆→問其他訂單 | `phase29_more_orders_expand`：依 `receiver_phone` 再跑 `unifiedLookupByPhoneGlobal` |
| 商品明細 | `formatProductLinesForCustomer` + `formatOrderOnePage` |
| 官網查無 | `lookup_order_by_phone` + `preferShopline` 時明確「官網查無」文案 |
| 後台效能 | 聯絡人首屏 **80**、載入更多；SSE 可 `VITE_DISABLE_SSE=1`；stats invalidate **15s** 節流 |
| 語氣 | `softHumanize`、follow-up 文案微調 |

## 營運建議

- HTTP/2 環境：前端 build 設 `VITE_DISABLE_SSE=1`，改純輪詢。
- 歷史訂單：`npx tsx server/scripts/sync-orders-normalized.ts --backfill`（可加 `brand_id`）。

## 驗證

```bash
npm run verify:phase29
```
