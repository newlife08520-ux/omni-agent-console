# 執行期 DB 與 review bundle 匯出一致性

> 目的：說明 **為何 masked export 可能是 0 列**，與 **實際上線 DB 是否為同一檔**。

## SQLite 實際路徑怎麼決定？

- 與 `server/data-dir.ts`／`server/db.ts` 一致：**`path.join(getDataDir(), "omnichannel.db")`**。
- `getDataDir()` 規則（摘要）：
  - 環境變數 **`DATA_DIR`** 若設定 → 使用該目錄。
  - 生產模式等條件下可能指向 **`/data`**（依專案實作）。
  - 開發預設常為 **Node 行程的 `process.cwd()`** 底下。

## 為什麼 pack／export 與「正在跑的伺服器」看到的表可能是兩個世界？

1. **不同 `DATA_DIR`**：伺服器用 A 目錄的 `omnichannel.db`，打包腳本在專案根用 B 目錄 → **`ai_logs`、`contact_active_order`、`order_lookup_cache` 全為 0** 仍可能「正常」。
2. **表本來就沒流量**：未寫入 `ai_logs`、未建立 active context、未查單 cache → export 合理為空。
3. **索引未同步**：`orders_normalized` 無列 ≠ API 不能查，但 **bundle 內統計會呈現 0**。

## 建議驗證方式

- 對 **同一台／同一行程** 解析 `getDataDir()` 與 db 路徑後再跑 export。
- 可執行 **`npm run diagnose:review-db`**（同 `npx tsx server/scripts/diagnose-review-bundle-db.ts`；與伺服器同 `DATA_DIR`／`cwd`）輸出 JSON：實際 `db_path`、關鍵表列數、`orders_normalized` 依 `source` 分組、品牌 Shopline 是否已設定（僅計數，不含 token）。
- **`npm run pack:review-bundle`** 會將上述輸出寫入 bundle 內 **`verify_output/diagnose_review_bundle_db.txt`**，便於與 `db_export_masked` 對照。
- 比對：**伺服器行程** 與 **`scripts/export-review-db-masked.mjs`** 的 **`DATA_DIR`／`NODE_ENV`／cwd**（export 腳本預設資料目錄在 dev 為 **專案根**，伺服器 `getDataDir()` 在 dev 為 **`process.cwd()`** — 兩者通常相同，但若從子目錄啟動伺服器則可能不同）。

## 相關檔案

- `server/data-dir.ts`、`server/db.ts`
- `scripts/export-review-db-masked.mjs`
- `server/scripts/diagnose-review-bundle-db.ts`
