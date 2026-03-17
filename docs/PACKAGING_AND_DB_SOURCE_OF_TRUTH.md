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
