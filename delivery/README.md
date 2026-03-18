# 交付物說明

## 1. 最新完整專案 ZIP

- **檔名**：`Omni-Agent-Console-3fad49f.zip`（位於上層目錄 `d:\Omni-Agent-Console(自動客服系統)\`）
- **內容**：目前 branch / 最新 HEAD 的完整專案，包含：
  - `server/`（含所有 `server/scripts/*`）
  - `shared/`
  - `docs/`
  - `client/`
  - `package.json`、`package-lock.json`
  - `tsconfig.json`、`tsconfig.server.json`
  - `drizzle.config.ts`
  - 本 `delivery/` 資料夾（驗證報告與證據）
- **排除**：`node_modules/`、`.git/`、`dist/`、`*.db`（SQLite 主檔），以利傳輸。若複製時含 `*.db-shm` / `*.db-wal`，可手動刪除後再壓縮。

## 2. 驗證報告

- **VERIFICATION_REPORT.md**：哪些檔案/函式新增、API 變更、驗收通過與未通過、實際執行輸出對照。

## 3. 證據文字輸出（evidence/）

| 檔案 | 內容 |
|------|------|
| git-rev.txt | `git rev-parse --short HEAD` → 3fad49f |
| check-server.txt | `npm run check:server` 完整輸出 |
| sync-output.txt | `npx tsx server/scripts/sync-orders-normalized.ts 1 1` 完整輸出 |
| query-order-index-stats.txt | `npx tsx server/scripts/query-order-index-stats.ts` 完整輸出 |
| phase2-verify.txt | `npx tsx server/phase2-verify.ts` 完整輸出（10 通過、0 失敗） |

**若有 SHOPLINE 憑證環境**，請再補：
- 一次用訂單號查 SHOPLINE 的終端輸出
- 一次用手機查 SHOPLINE 的終端輸出
- 查完後再跑一次 `npx tsx server/scripts/query-order-index-stats.ts`，證明 order_lookup_cache / orders_normalized 有 write-back（source=shopline 筆數增加）。

## 4. 使用方式

1. 解壓 `Omni-Agent-Console-3fad49f.zip`。
2. 在解壓目錄執行 `npm install`。
3. 執行 `npm run check:server`、`npm run sync:orders` 或 `npx tsx server/scripts/sync-orders-normalized.ts [brand_id] [days]`、`npx tsx server/scripts/query-order-index-stats.ts`、`npx tsx server/phase2-verify.ts` 可重現報告內結果。
