# Runtime／Export Parity 真相

## 同一個 DB 世界要對齊什麼？

以下程式在 **未另外設 `DATA_DIR`** 時，預設都指向 **`getDataDir()`**（見 `server/data-dir.ts`）底下的 **`omnichannel.db`**：

| 動作 | 實際讀檔方式 |
|------|----------------|
| 跑 `npm` 的 diagnose／stats／export（cwd = 專案根） | `path.join(getDataDir(), "omnichannel.db")` |
| 本機 `tsx server/index.ts`（cwd = 專案根） | 同上 |

**會變成兩個世界的情況**（常見、且會讓 bundle「全 0」）：

1. **伺服器** 以 `DATA_DIR=E:\data` 啟動，**打包**在專案根沒設 `DATA_DIR` → 讀到 **兩顆不同檔**。  
2. **伺服器** 從子目錄啟動，`getDataDir()` 落在不同 cwd（若實作依 `process.cwd()`）。  

## 為什麼 bundle 裡表都是 0？

若已確認 **打包與測試同一顆檔**，則 **0 = 這顆檔裡就是沒有列**（見 `shopline_truth_live.md`、`product_phone_truth.md`）。  
若 **無法確認同一顆檔**，則 **0 無法用來否定或肯定線上行為**——只能先對齊 `verify_output/runtime_db_identity.txt` 與伺服器啟動參數。

## 打包時會寫的 parity 產物

- `verify_output/diagnose_review_bundle_db.txt`：診斷 JSON（與手動 `diagnose:review-db` 相同邏輯）  
- `verify_output/diagnose_review_bundle_db_live.txt`／`stats_order_index_live.txt`：由 `emit:runtime-parity` 寫入，**與上一者應一致**（同一機、同一輪打包）  
- `verify_output/runtime_db_identity.txt`：`cwd`、`DATA_DIR`、`resolved_data_dir`、`db_path`  

## 可重現的「寫入後再匯出」檢查（人工）

1. 確認伺服器與 export 使用 **相同 `DATA_DIR`**。  
2. 走一輪會寫 `ai_logs`／`contact_active_order`／`order_lookup_cache` 的查單或 AI 流程。  
3. 立刻在同一環境執行 `npm run diagnose:review-db` 與 `npm run export:review-db-masked`。  
4. 若仍全 0 → 代表 **寫入路徑不是這顆 DB** 或 **流程未寫表**（需對 log／code path 查）。
