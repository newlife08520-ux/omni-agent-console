# 資料目錄與資料庫路徑（單一真相）

## 唯一正式 DB 路徑

- 本系統**僅使用一個資料庫檔案**作為正式來源：`{DATA_DIR}/omnichannel.db`。
- `DATA_DIR` 由環境變數決定；未設定時，development 為 `process.cwd()`，production 為 `/data`。
- 啟動時會於 log 印出：
  - `[server] DATA_DIR = ...`
  - `[server] DB path = .../omnichannel.db`
  - `[DB] path = ... schema_version = 1`

## 禁止雙 DB 漂移

- **禁止**在 repo 內同時維護兩份行為不一致的「正式」DB（例如 `data/omnichannel.db` 與 `data_coldstart/omnichannel.db` 各用一套 schema）。
- 若曾用不同目錄或舊版跑過，可能產生表數量／結構不一致；部署時**務必只掛一個 DATA_DIR**，並讓該目錄內的 DB 跑完所有 migration。

## Cold-start / 測試用 DATA_DIR

- `data_coldstart` 僅為**本地冷啟動測試**時可指定的目錄名稱（例如 `DATA_DIR=./data_coldstart npm run dev`）。
- 同一套程式、同一套 migration 會在那個目錄下建立 `omnichannel.db`；**不是**另一套 schema 來源。
- 正式環境應固定使用一個 DATA_DIR（例如 Railway Volume 掛在 `/data`），並確保該路徑上的 DB 已透過 `initDatabase()` 完成所有 migration。

## Schema 版本

- `schema_info` 表記錄 `schema_version`（目前為 `1`）。
- 啟動時會執行 migration 並寫入/更新此值，log 可確認當前 DB path 與 schema_version。
