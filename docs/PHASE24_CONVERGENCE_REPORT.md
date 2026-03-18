# Phase 2.4 收斂報告

## 實際修改檔案

| 檔案 | 說明 |
|------|------|
| `server/db.ts` | `migratePhase24OrderCreatedAt`：`orders_normalized.order_created_at` + payload backfill |
| `server/order-index.ts` | 手機／商品查詢排序改 `order_created_at`；`upsertOrderNormalized` 寫入該欄；`getOrderIndexStats` 擴充缺失數與 min/max |
| `server/order-service.ts` | `getPaymentInterpretationForAI(order, status, source)` 改為 **derivePaymentStatus** 薄封裝 |
| `server/order-reply-utils.ts` | `buildDeterministicFollowUpReply`、`PHASE24_BANNED_DETERMINISTIC_PHRASES`、語氣精簡 |
| `server/order-multi-selector.ts` | **新增**：排序、最新／最早、日期、來源篩選 |
| `server/order-fast-path.ts` | 混合句單號、`order_followup` fast path、候選帶 `source` |
| `server/routes.ts` | 多筆選擇擴充（官網／一頁單筆自動帶明細、最新／最早／日期、第 N 筆依時間排序）；移除重複 `formatOrderOnePage`／本地 `buildDeterministicFollowUpReply` |
| `server/phase24-verify.ts` | **新增**：10 項自驗 |
| `package.json` | `verify:phase24` |
| `server/scripts/query-order-index-stats.ts` | 輸出 Phase24 order_created_at 摘要 |
| `shared/schema.ts` | `active_order_candidates[].source` |

## 已收斂／已刪除的舊邏輯

- `routes` 內本地 `formatOrderOnePage`、`buildDeterministicFollowUpReply`（改唯一 import）。
- `getPaymentInterpretationForAI` 舊版依 `payment_method` 字串分支（改與 **derivePaymentStatus** 一致）。

## 指令

```bash
npm run verify:phase24   # check:server + verify:hardening + phase24-verify + stats:order-index
```

## Blocker

- 無憑證時無法在本機驗 `sync:orders`／Shopline 全量；本地索引統計依現有 DB。

## 建議人工複測

見 `PHASE24_FINAL_MANUAL_TEST_CHECKLIST.md`（或 `PHASE24_ACCEPTANCE_REPORT.md` 精簡 12 題）。
