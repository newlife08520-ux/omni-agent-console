# Railway 冷啟動 Crash 修復回報

## 1. 問題根因

- **現象**：Railway deploy 啟動時崩潰，log 顯示 `SqliteError: no such column: brand_id`。
- **原因**：`migrateContactStatusExpansion()` 在「擴充 contacts.status CHECK」時，會建立 `contacts_new` 並用 `INSERT INTO contacts_new (...) SELECT ... FROM contacts` 複製資料。SELECT 清單**固定包含** `brand_id`、`channel_id` 等欄位。
- **全新空 DB**：`initDatabase()` 建立的 `contacts` 表是**最初版 schema**（無 `brand_id`、`channel_id`、`ai_rating`、`issue_type`、`order_source`）。因此執行到該 SELECT 時，SQLite 報錯「no such column: brand_id」。
- **對應 deploy log**：錯誤發生在 bundled 檔 `/app/dist/index.cjs` 對應之 **server/db.ts** 內 `migrateContactStatusExpansion()` 的 `INSERT...SELECT` 那一行。

---

## 2. 實際出錯 SQL 與檔案位置

| 項目 | 內容 |
|------|------|
| **檔案** | `server/db.ts` |
| **函式** | `migrateContactStatusExpansion()` |
| **約略行號** | 原約 768–780（依你目前版本可能 ±2） |
| **出錯 SQL** | `INSERT INTO contacts_new (id, platform, ..., brand_id, channel_id, issue_type, order_source) SELECT id, platform, ..., brand_id, channel_id, issue_type, order_source FROM contacts;` |
| **原因** | 來源表 `contacts`（全新 DB）沒有 `brand_id`、`channel_id` 等欄位，SELECT 卻直接列出這些欄位名稱。 |

---

## 3. 修改檔案清單

- **server/db.ts**
  - **migrateContactStatusExpansion()**：改為依「目前 `contacts` 表實際欄位」動態組出 SELECT 清單；若某欄位不存在於來源表，則在 SELECT 中用 `NULL`，不再假設來源表已有 `brand_id` / `channel_id` / `ai_rating` / `issue_type` / `order_source`。
  - 具體改動：用 `PRAGMA table_info(contacts)` 取得現有欄位，對目標欄位逐一判斷「有則用欄位名、無則用 NULL」，再執行 `INSERT INTO contacts_new (...) SELECT ... FROM contacts`。

---

## 4. Cold-start 驗收步驟（本機已執行）

1. **清空測試目錄**  
   - 刪除或建立全新目錄作為 DATA_DIR（本次使用 `.\data_coldstart`）。

2. **指定全新 DATA_DIR 啟動**  
   - Windows (PowerShell)：
     ```powershell
     $env:DATA_DIR = ".\data_coldstart"   # 或 Resolve-Path 後的絕對路徑
     $env:NODE_ENV = "development"
     npx tsx server/index.ts
     ```
   - 或：`DATA_DIR=./data_coldstart npm run dev`（bash 環境）。

3. **預期**  
   - 自動在 DATA_DIR 下建立 `omnichannel.db`、`uploads/` 等。  
   - 所有 migration 跑完、無 SqliteError。  
   - 日誌出現 `serving on port 5001` 與 Webhook URLs。

4. **基本 API 驗證**  
   - `GET http://localhost:5001/api/auth/check` → 預期 200。  
   - `GET http://localhost:5001/api/settings` → 未登入時可為 401，表示服務有回應。

5. **檔案確認**  
   - DATA_DIR 內應有：`omnichannel.db`、`omnichannel.db-wal`、`omnichannel.db-shm`、`uploads/`（及子目錄）。

---

## 5. 驗收結果（本機）

| 項目 | 結果 |
|------|------|
| 全新 DATA_DIR 啟動 | 通過，無 crash |
| 自動建立 omnichannel.db | 有，位於 `data_coldstart/omnichannel.db` |
| 自動建立 uploads | 有，含 `uploads/avatars`、`uploads/image-assets` |
| Migration 全數跑完 | 是，日誌有「contacts.status CHECK 已擴充完成」「已建立多品牌架構」等 |
| 服務 listening | 是，`serving on port 5001` |
| GET /api/auth/check | 200 |
| GET /api/settings（未登入） | 有回應（401 屬預期） |

**結論**：在「全新空 DB + 全新 DATA_DIR」下，本機 cold-start 已通過。

---

## 6. Railway 下一步操作

### 方案 A（救火：沿用現有 DB）

- 若你**已有本機可用的 omnichannel.db**（含 users、brands、settings 等）：
  1. 將該 `omnichannel.db` 上傳到 Railway Volume 的 **/data** 目錄（即 `DATA_DIR` 對應路徑）。
  2. 檔名須為 **`omnichannel.db`**。
  3. 確認服務的 env 有 **DATA_DIR=/data**（或未設，production 預設即 `/data`）。
  4. 重啟 / 重新 deploy 後，應用會直接使用該 DB，**不會再跑「從零建表」**，因此不會觸發剛才修掉的那段 SELECT；可先讓服務跑起來。
- **如何確認有吃到**：日誌無 `SqliteError`、可登入、品牌/設定存在；或於 Volume 內執行 `ls -la /data` 看到 `omnichannel.db`。

### 方案 B（正式修復：全新 Volume / 全新 DB）

- 修好 migration 後（即本次 **server/db.ts** 修改）：
  1. 重新 build 並 deploy 到 Railway（或 push 後由 CI 部署）。
  2. 使用**全新 Volume** 掛在 `/data`，或清空既有 Volume 內檔案，讓應用**從零建立** `omnichannel.db`。
  3. 啟動後應看到與本機相同的 migration 日誌，並出現 `serving on port ...`，無 crash。
  4. 首次使用需依系統設計建立管理員帳號（或依 seed 預設帳號登入）。
- **驗證**：Deploy log 無 `no such column: brand_id`；開啟站點可登入、基本功能正常。

---

## 7. 仍存在的風險

- **其他 migration**：本次僅修正 `migrateContactStatusExpansion()`。其餘 migration 已依執行順序檢查，在「全新空 DB」情境下皆為先建表/加欄再查，目前未發現同類問題；若日後新增 migration，仍建議遵循：**先確認表/欄存在再 SELECT 或 UPDATE**。
- **seedMockData**：在空 DB 會寫入預設使用者與聯絡人；若 production 不需 mock 資料，可考慮依 NODE_ENV 或設定關閉。
- **Volume 權限**：Railway 上 `/data` 須可寫，否則 DB 或 WAL 寫入可能失敗；此為環境設定，非本次程式變更範圍。

---

**總結**：根因是「擴充 contacts.status 的 migration 在來源表尚無 brand_id 時就 SELECT brand_id」；已改為依實際欄位動態組 SELECT，冷啟動通過。可先以方案 A 救火，再以方案 B 用全新 DB 正式驗證。
