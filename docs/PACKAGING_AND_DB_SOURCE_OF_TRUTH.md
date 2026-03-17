# 打包與 DB 單一真相

## 正式 DB 路徑（唯一來源）

- **唯一正式 DB**：`${DATA_DIR}/omnichannel.db`
- `DATA_DIR` 由環境變數設定；未設時 development 為 `process.cwd()`，production 為 `/data`。
- **根目錄不得作為正式 DB 來源**：專案根目錄若有 `omnichannel.db` 僅為歷史或本機殘留，正式部署必須使用單一 `DATA_DIR`。

## 交付 source ZIP 時必須排除

打包**原始碼**時請勿包含：

- `.git/`
- `node_modules/`
- `dist/`
- 真實 `.env`（僅可含 `.env.example`）
- **任何 DB 快照**：
  - `omnichannel.db`
  - `*.db-wal`
  - `*.db-shm`
  - `data/` 目錄
  - `data_coldstart/` 目錄

若需提供「測試資料包」供本機還原，應另檔交付並明確標示**僅供本機測試**，不得與 source ZIP 混為一包當正式來源。

### attached_assets/ 與 uploads/ 是否納入 source ZIP

- **attached_assets/**：後台「圖片素材庫」上傳的圖片會存於此目錄（或 `uploads/image-assets` 等，依實作）。若交付**最乾淨**的 source package（僅程式與設定、無營運資料），建議**不納入**或納入**空目錄**；若需提供預設素材供佈署參考，可納入少量範例並在文件註明。
- **uploads/**：一般上傳暫存或使用者上傳檔案目錄。同上，**最乾淨**交付建議**不納入**或僅保留空目錄結構，避免夾帶本機/測試資料。佈署時由程式或啟動 script 建立空目錄即可。
- **結論**：若要交「最乾淨」source package，兩者皆可排除或改為空目錄；若保留，請在交付說明中註明用途與是否含範例/測試檔。

## 冷啟動 / 測試用

- 冷啟動測試可指定空目錄，例如：`DATA_DIR=./data_coldstart npm run dev`。
- 同一套 code + migration 在該目錄下建立 `omnichannel.db`，**不是**第二套正式 DB。
- 正式環境只使用一個 DATA_DIR（如 Volume 掛載 `/data`），並確保 migration 在該路徑跑完。

## 啟動時 log

啟動後 log 應可見到：

- `[server] DATA_DIR = ...`
- `[server] DB path = .../omnichannel.db`
- `[DB] path = ... schema_version = ...`

若 schema 檢查失敗（缺表／缺欄位／schema_version 不符），程式應**明確報錯**，不得靜默啟動。

## Migration / coldstart 操作

- 空 DB：執行 `npm run dev` 或 `npm start` 時會呼叫 `initDatabase()`，建立所有表並寫入 `schema_info`。
- 既有 DB：啟動時會執行 migration 並更新 `schema_info`；若缺必要表會依 P0-5 規定報錯。

## 如何從零建立本機開發資料庫

交付包**不得附 DB 快照**；本機開發需自建 DB，方式如下。

1. **指定資料目錄**（可為空目錄）  
   - 例：`DATA_DIR=./data npm run dev` 或 Windows：`set DATA_DIR=./data && npm run dev`  
   - 未設時，development 預設為專案根目錄（不建議與版控混用）。

2. **首次啟動即建庫**  
   - 在該目錄下會產生 `omnichannel.db`。  
   - `initDatabase()` 會建立所有必要表並寫入 `schema_info`（key=`schema_version`，value=`1`）。

3. **無需種子檔時**  
   - 直接啟動後為空 DB，可透過後台建立品牌、渠道、使用者等。  
   - 若需測試資料，請自行在後台操作或撰寫一次性 seed script（不提交真實 DB 檔）。

4. **若需可重現的測試資料**  
   - 建議：新增 `script/seed-dev.ts`（或類似）僅插入最小必要資料（例如一組 brand、一組 channel、一組 user）。  
   - 執行方式：`DATA_DIR=./data tsx script/seed-dev.ts`。  
   - 不要將 `data/` 或 `*.db` 放入版控或 source ZIP。

5. **驗證**  
   - 啟動後 log 應出現：`[DB] path = ... schema_version = 1`。  
   - 若出現「缺少表」或「schema_version 為空」，表示 migration 未在該路徑執行，請以空目錄重新啟動一次。
