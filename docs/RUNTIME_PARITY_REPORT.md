# RUNTIME_PARITY_REPORT（R1-7）

## DB 路徑對照

| 角色 | 解析方式 | 本機快照（見 `R1_LIVE_TRUTH.md`） |
|------|-----------|-----------------------------------|
| 執行期伺服器 | `getDataDir()` + `omnichannel.db` | `...\Omni-Agent-Console\omnichannel.db` |
| diagnose / export | 同上 | 同上（同目錄執行時） |

## `ai_logs` / `order_lookup_cache` / `contact_active_order` 為 0

- **本機 diagnose 實測**：三表計數皆為 0（`ai_logs`、`order_lookup_cache`、`contact_active_order`）。
- **可能原因**（並存）：
  1. **尚未產生資料**：查單快取與 AI log 僅在對應流程觸發後寫入。
  2. **非接錯庫**：`db_path` 與專案根一致時，與「寫入關閉」無直接等號。
  3. **export 腳本**：若在不同 `cwd` 或 `DATA_DIR` 執行，會讀到**另一顆**檔案，造成「線上有資料、匯出為 0」的假像。

## Shopline 與訂單來源

- `orders_normalized` 本機僅 `superlanding`，`shopline_configured: 0` → **本機 world 無 Shopline API 與 shopline 正規化列**，與 `SHOPLINE_TRUTH_REPORT.md` 一致。

## 驗證

- `npm run verify:r1`（倉庫根可 `npm run verify:r1` 轉發至內層 `Omni-Agent-Console`）。
- `npm run verify:r1:log`：重跑驗證並將**完整 UTF-8 主控台輸出**寫入 `verify_output/verify_r1.txt`（Windows 請優先用此，避免 PowerShell `>` 重導向亂碼）。
- `verify_output/verify_r1.txt`：最近一次 `verify:r1:log` 產物，含 `tsc`、migration 日誌與各檢核項。
