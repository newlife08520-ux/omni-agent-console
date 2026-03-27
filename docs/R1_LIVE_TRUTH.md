# R1 唯一真相（Live / Staging / 本機）

> 產生方式：同一套程式（`server/data-dir.ts` + `server/db.ts`）＋環境變數；以下 **實際指令與輸出** 取自本機工作區一次完整執行。

## 1. Live server 實際 DB 檔案

- **程式邏輯**：`path.join(getDataDir(), "omnichannel.db")`（見 `server/db.ts`）。
- **`getDataDir()`**：`DATA_DIR` 有值則 `path.resolve(DATA_DIR)`；否則 production 預設 `/data`，development 預設 `process.cwd()`（見 `server/data-dir.ts`）。
- **本倉庫無法替你登入雲端主機**：請在 **live** 主機上執行與下方相同的診斷指令，將輸出貼回即為該環境唯一 path。

## 2. Staging server 實際 DB 檔案

- 規則與 live **相同**，差別僅在部署設定的 `DATA_DIR` / `cwd` / `NODE_ENV`。
- 請在 **staging** 主機執行：`npx tsx server/scripts/diagnose-review-bundle-db.ts`。

## 3. Review bundle / export 使用的 DB

- `server/scripts/export-effective-prompt-masked.ts` 與 `diagnose-review-bundle-db.ts` 皆透過 `getDataDir()` 解析 DB。
- **必須與你要審查的環境使用同一 `DATA_DIR` 與工作目錄**，否則匯出與線上不一致。

## 4. DATA_DIR / cwd / db_path（本機實測）

**指令：**

```bash
cd Omni-Agent-Console
npm run diagnose:review-db
# 等同：npx tsx server/scripts/diagnose-review-bundle-db.ts
```

**實際輸出（範例快照，請以你機器為準）：**

```json
{
  "node_env": null,
  "data_dir_env": null,
  "resolved_data_dir": "D:\\Omni-Agent-Console(自動客服系統)\\Omni-Agent-Console",
  "cwd": "D:\\Omni-Agent-Console(自動客服系統)\\Omni-Agent-Console",
  "db_path": "D:\\Omni-Agent-Console(自動客服系統)\\Omni-Agent-Console\\omnichannel.db",
  "db_exists": true
}
```

- **DATA_DIR（環境變數）**：此快照為 `null` → 未設定。
- **resolved_data_dir**：等於當次行程的 `getDataDir()`。
- **cwd**：`process.cwd()`（執行 npm/tsx 時的目錄）。
- **db_path**：`resolved_data_dir` + `\omnichannel.db`。

## 5. 本輪「唯一真相來源」環境

- **開發／驗證**：以 **本機** 上列 `db_path` 與 `diagnose` 輸出為準。
- **上線驗收**：以 **staging 與 live 各自主機** 上執行 `diagnose-review-bundle-db.ts` 的 JSON 為準（同一套程式碼，不同 `DATA_DIR` 即不同檔案）。

## 6. `shopline_configured = 0` 發生在哪個環境

- **定義**（診斷腳本）：`brands` 表中 `shopline_api_token`、`shopline_store_domain` 皆非空白筆數。
- **本機實測輸出**：`"shopline_configured": 0` → **本機 DB** 內無完整 Shopline API 品牌設定。

## 7. `orders_normalized.shopline = 0` 發生在哪個環境

- **本機實測輸出**：`orders_normalized_by_source` 僅有 `"superlanding": 25151`，**無 `shopline` 鍵** → 等同 shopline 來源筆數為 0，發生在 **本機此顆 DB**。

## 8. `ai_logs = 0` / `order_lookup_cache = 0` / `active_order_context = 0`

| 表 | 本機計數 | 解讀 |
|---|----------|------|
| `ai_logs` | 0 | 此 DB **尚未累積** AI 記錄，或功能未寫入此表；**非**「接錯庫」的充分證據。 |
| `order_lookup_cache` | 0 | 查單快取 **尚未被填入**（冷啟動或查詢未觸發寫入）。 |
| `contact_active_order` | 0 | 無持久化的 active order 列（與記憶體／流程有關，需對照 `storage` 實作）。 |

**是否接錯庫**：以 `db_path` 與 `resolved_data_dir` 與線上 `diagnose` 是否一致判斷；本快照顯示匯出腳本與伺服器若同目錄執行則 **同一顆檔案**。

**是否寫入被關閉**：需另查是否有 feature flag／worker 未跑；本文件僅記錄 **實際計數**。

**export 腳本是否用錯 world**：若 `export-effective-prompt-masked.ts` 的 `cwd`/`DATA_DIR` 與線上不同，即錯 world — 請對照本檔第 3 節。

---

## 9. R1 交付物索引（本倉庫）

| 檔案 | 說明 |
|------|------|
| `docs/R1_LIVE_TRUTH.md` | 本檔 |
| `docs/RUNTIME_PARITY_REPORT.md` | R1-7 執行期／匯出對齊 |
| `docs/SHOPLINE_TRUTH_REPORT.md` | R1-3 官網真實性 |
| `docs/PERSONA_SINGLE_SOURCE_OF_TRUTH.md` | R1-6 人格單一來源 |
| `docs/PAYMENT_TRUTH_MATRIX.md` | R1-4 付款矩陣 |
| `docs/R1_MASKED_CASES.md` | 遮罩案例修前／修後 |
| `verify_output/verify_r1.txt` | `verify:r1` 摘要輸出（完整請本機重跑） |
| `server/r1-verify.ts` | R1-8 驗證實作（無 skip） |
