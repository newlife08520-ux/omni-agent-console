# RUNTIME_PARITY_REPORT（R1-7）— 排除式結論

> 與 `R1_LIVE_TRUTH.md` §8 **同一結論**；本檔為審查用擴寫。

## DB 路徑對齊

| 角色 | 解析 |
|------|------|
| 伺服器 | `getDataDir()` + `omnichannel.db` |
| `diagnose-review-bundle-db` | 同上 |
| `export-effective-prompt-masked.ts` | 同上（`storage` → 同 DB） |

**Live 預設（未設 `DATA_DIR`、production）**：`/data/omnichannel.db`（見 `server/data-dir.ts`）。  
**本機已量測**：見 `R1_LIVE_TRUTH.md` §4 與 `verify:r1`「PARITY」輸出。

---

## `ai_logs = 0` — 真正原因（本機此顆 DB）

1. **寫入點存在**：`SQLiteStorage.createAiLog` → `INSERT INTO ai_logs`（`server/storage.ts`）。  
2. **呼叫點存在**：`server/routes.ts`、LINE／FB webhook controller 等多處於成功走完 AI 流程時呼叫。  
3. **結論**：計數為 0 = **此資料庫檔尚未經上述路徑產生列**（例如僅開發、未跑完整對話、或 DB 為新備份）。  
4. **已排除**：表不存在、程式永久不寫、無 `ai_logs` 遷移。

---

## `order_lookup_cache = 0` — 真正原因

1. **寫入點**：`setOrderLookupCache`（`server/order-index.ts`），由 `unifiedLookup*` 命中快取邏輯時寫入。  
2. **結論**：0 = **尚未有任何查單流程寫入快取列**（冷庫／未觸發 API+快取路徑）。  
3. **已排除**：表名錯誤、寫入被 feature 永久關閉（無此設計）。

---

## `contact_active_order = 0` — 真正原因

1. **寫入點**：`setActiveOrderContext`（`server/storage.ts`）UPSERT `contact_active_order`。  
2. **結論**：0 = **尚無任何 contact 被寫入 persistent active order**。  
3. **R1 行為變更**：`local_only` 單筆改寫 **`buildProvisionalLocalOnlyActiveContextFromOrder`**，仍會**在該路徑觸發時**寫入列；若仍為 0 表示該路徑尚未在此 DB 執行過。

---

## `db_export_masked` / bundle 與本敘述一致否

- 若 bundle 內 DB 匯出（若有）來自**與線上相同** `DATA_DIR`+`cwd` 執行之 `diagnose`／export，則計數應與線上同檔一致。  
- 若匯出機讀到**本機 cwd DB**，而線上為 `/data/omnichannel.db`，則 **計數可不同** — 屬 **world 不同**，非單一程式 bug。

---

## 驗證

- `npm run verify:r1` — 含 **RUNTIME / EXPORT PARITY** 段（列印 `db_path` 與三表 `COUNT`）。  
- `npm run verify:r1:log` — 完整輸出至 `verify_output/verify_r1.txt`。
