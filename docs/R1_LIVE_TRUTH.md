# R1 唯一真相（Locked：程式規格 + 本機已量測）

> **本文件不請讀者「自己去主機查」**。Live／Staging 的**實體路徑**由部署時的 `DATA_DIR`、`NODE_ENV`、`process.cwd()` 依 `server/data-dir.ts` **唯一決定**；下方 **Production 約定** 為從原始碼推出的結論。  
> **本輪程式與 `verify:r1` 鎖定的資料庫 world**：**本機工作區**（見 §4 真實 `diagnose` JSON）。

---

## 1. Live（Production）DB 路徑 — 程式規格結論

| 條件 | `getDataDir()` | `db_path` |
|------|----------------|-----------|
| 設 `DATA_DIR=/path` | `path.resolve(DATA_DIR)` | `{DATA_DIR}/omnichannel.db` |
| 未設 `DATA_DIR` 且 `NODE_ENV=production` | **`/data`**（固定） | **`/data/omnichannel.db`** |
| 未設 `DATA_DIR` 且非 production | `process.cwd()` | `{cwd}/omnichannel.db` |

**程式依據**：`server/data-dir.ts`（`getDataDirRaw`）。

**結論**：標準 production 部署（常見 Volume 掛 `/data`、未另外設 `DATA_DIR`）時，**Live 預期單一檔案**為 **`/data/omnichannel.db`**。若營運另設 `DATA_DIR`，則以該目錄為準（仍為**同一套**解析式，非第二套邏輯）。

---

## 2. Staging DB 路徑 — 程式規格結論

- **與 Live 相同程式碼**：規則同 §1。  
- **Staging 與 Live 是否同一顆檔**：**否** — 除非人為將兩環境的 `DATA_DIR`／`cwd` 設成完全相同（一般不建議）。  
- **典型差異**：Staging 可能 `DATA_DIR=/data/staging` 或不同主機掛載點 → **路徑不同，但公式相同**。

---

## 3. Export bundle / `export-effective-prompt-masked` / `diagnose-review-bundle-db` 使用的 DB

- **解析式**：與執行期相同 — `getDataDir()` + `omnichannel.db`（`server/scripts/diagnose-review-bundle-db.ts` 第 22–23 行）。  
- **Export DB path**：**等於**執行該腳本時行程的 `getDataDir()` + `omnichannel.db`。  
- **與 Live 是否一致**：**僅當** export 行程的 `DATA_DIR`／`cwd`／`NODE_ENV` 與目標環境伺服器**相同**時才一致；否則即 **不同 world**（非「腳本接錯程式」，而是**環境變數不同**）。

---

## 4. 本機已量測：`cwd` / `DATA_DIR` / `db_path`（真實輸出）

**指令（已於本倉庫執行過）：**

```bash
cd Omni-Agent-Console
npm run diagnose:review-db
```

**快照（結構同上；路徑隨機器而變）：**

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

**本輪 `verify:r1` 內嵌 parity 列印**與上表同一解析式（見 `server/r1-verify.ts`「RUNTIME / EXPORT PARITY」段）。

---

## 5. 三者是否一致 & 本輪鎖定的「唯一真相」環境

| 對照 | 結論 |
|------|------|
| 本機 dev vs production 預設 `/data/...` | **不一致**（dev 用 `cwd`，prod 用 `/data`）— **預期行為**。 |
| 本機 export 與本機伺服器 | **若**同目錄、同 `DATA_DIR` 啟動 → **一致**。 |
| **本輪 R1 驗證與 fixture** | 鎖定 **本機** `db_path`（§4）為**唯一已量測 truth world**。 |

---

## 6. `shopline_configured = 0` 發生在哪

- **定義**：`diagnose-review-bundle-db.ts` 統計 `brands` 同時具備非空 `shopline_api_token` 與 `shopline_store_domain`。  
- **本機此顆 DB**：`shopline_configured: 0`（見最近一次 `diagnose` / `verify:r1` 輸出）。

---

## 7. `orders_normalized` 無 `shopline` 列

- **本機此顆 DB**：`orders_normalized_by_source` 僅見 `superlanding` 等；**無 shopline 筆數**即視為 shopline 來源 **0**。

---

## 8. `ai_logs` / `order_lookup_cache` / `contact_active_order` 為 0 — **排除式結論**

（與 `RUNTIME_PARITY_REPORT.md` 對齊；以下為**本機該顆 DB**之結論。）

| 表 | 計數=0 的**確定原因**（已對照程式碼） |
|----|--------------------------------------|
| **`ai_logs`** | 表存在且 **`storage.createAiLog`** 會寫入（`storage.ts`）；本顆 DB **尚未累積**通過 `routes.ts`／webhook 等路徑的列。**不是**「表不存在」；**不是**「程式碼全域關閉寫入」（無此等 flag）。 |
| **`order_lookup_cache`** | **`setOrderLookupCache`**（`order-index.ts`）在查單命中快取路徑時寫入；**0 = 自開庫以來尚未寫入列**（冷啟／未觸發該路徑）。 |
| **`contact_active_order`** | **`setActiveOrderContext`**（`storage.ts`）會 UPSERT；**0 = 尚未有聯絡人持久化 active context**。 |

**接錯庫？** 若 `db_path` 與預期環境一致，則計數反映**該檔**真實狀態，而非「寫到別顆」。  
**Export 匯錯？** 若 export 與伺服器 `DATA_DIR`/`cwd` 不同 → 讀到**另一檔** — 屬設定問題，非表邏輯錯誤。

---

## 9. 交付索引

| 檔案 | 說明 |
|------|------|
| `docs/RUNTIME_PARITY_REPORT.md` | 與 §8 擴寫一致 |
| `docs/SHOPLINE_TRUTH_REPORT.md` | 官網可查與否（本 world） |
| `docs/PERSONA_SINGLE_SOURCE_OF_TRUTH.md` | 人格決策 + 保留/遷移/刪除 |
| `docs/PAYMENT_TRUTH_MATRIX.md` | 付款 fixture 對照 |
| `docs/R1_MASKED_CASES.md` | 修前/修後 |
| `docs/R1_EXECUTION_SUMMARY.md` | 票務完成度摘要 |
| `verify_output/verify_r1.txt` | `npm run verify:r1:log` |
| `server/r1-verify.ts` | R1-8 實作 |
