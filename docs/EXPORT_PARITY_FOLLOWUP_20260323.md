# Export／Bundle Parity 說明（2026-03-23 跟進）

## 同一個 DB 世界

以下檔案在 **同一打包流程、同一工作目錄**下產生時，應指向 **同一顆** `omnichannel.db`（路徑見 `diagnose_review_bundle_db.txt` 的 `resolved_data_dir` + `db_path`）：

| 產物 | 如何讀 DB |
|------|-----------|
| `verify_output/diagnose_review_bundle_db.txt` | `getDataDir()`（`server/data-dir.ts`） |
| `verify_output/stats_order_index.txt` | 同上（經 `order-index`） |
| `db_export_masked/*.masked.json` | `scripts/export-review-db-masked.mjs` 的 `getDataDir()`（與 export-ai-bundle-context 對齊） |

若 **伺服器行程** 以不同 `DATA_DIR` 或從**子目錄**啟動導致 `cwd` 不同，則 **診斷／匯出** 與 **線上** 會是兩個世界 — 出現「全 0」仍可能線上有資料。

**建議**：打包前在與目標環境相同的 shell 下執行：

```bash
npm run diagnose:review-db
```

並與實際跑 `node`／`tsx` 的 **`process.cwd()`**、`DATA_DIR` 核對。

---

## 為什麼 `verify_phase24.txt`～`verify_phase34.txt` 會是 `skipped`？

當環境變數 **`REVIEW_BUNDLE_SKIP_LONG_VERIFY=1`** 時（例如執行 **`npm run pack:review-bundle:quick`**），腳本**刻意**不跑：

- `npm run verify:phase34`（整鏈含 phase24～34）
- 各 phase 的**單獨** `npx tsx server/phaseXX-verify.ts`

並寫入 stub：`skipped: REVIEW_BUNDLE_SKIP_LONG_VERIFY=1`。

**完整輸出**請使用：

```bash
npm run pack:review-bundle
```

**不要**設定 `REVIEW_BUNDLE_SKIP_LONG_VERIFY`（或設為 `0`）。產物內 `verify_output/verify_phase34.txt` 等即為完整日誌。

---

## system_prompt 遮罩匯出

打包流程會產生 **`verify_output/system_prompt_effective.md`**（由 `npm run export:review-prompt-masked` 寫入 staging），內容包含：

1. DB `settings.system_prompt`（全域）
2. 各品牌 `brands.system_prompt`（品牌語氣）
3. `assembleEnrichedSystemPrompt` 範例組裝（一般對答、`order_lookup`、查單後追問）

**注意**：匯出腳本會設 `REVIEW_PROMPT_EXPORT_SKIP_CATALOG=1`，**不**呼叫一頁商店銷售頁 API，故「一般對答」快照可能**無** `--- CATALOG ---`（與線上已載入快取時不同）。

與 **`docs/persona`** 的關係：**檔案是人看的規格／備份；runtime 以 DB + prompt-builder 為準** — 詳見 `shopline_truth_report.md`。

---

## 官網可查證據與 demo

- **真實證據**：後台 Shopline 綁定 + `sync:orders` + 實際對話／工具結果（可再放進 `sanitized_cases`）。
- **僅結構／回歸用**：`npm run seed:review-bundle-shopline-demo` + bundle 內 `docs/review-bundle/*demo*`（明確標示 DEMO）。
