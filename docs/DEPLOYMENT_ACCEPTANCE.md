# 部署驗收步驟（持久化與多人 Session）

部署必改完成後，請依序執行以下驗收，確認資料持久化與 Session 正常。

---

## 1) 本地 DATA_DIR：重啟後 DB / uploads 不丟

- **目的**：確認 `DATA_DIR` 生效，SQLite 與 uploads 寫入指定目錄，重啟後仍存在。
- **步驟**：
  1. 在專案根目錄執行（依作業系統擇一）：
     - Windows（PowerShell）：`$env:DATA_DIR="./data"; npm run dev`
     - Windows（CMD）：`set DATA_DIR=./data && npm run dev`
     - macOS / Linux：`DATA_DIR=./data npm run dev`
  2. 瀏覽器開啟 http://localhost:5001，登入後新增一筆聯絡人或修改一項設定並儲存。
  3. 停止服務（Ctrl+C）。
  4. 確認目錄 `./data` 內有 `omnichannel.db` 與 `uploads/`（若有上傳則有檔案）。
  5. 再次執行同一步驟 1 的指令啟動服務。
  6. 重新整理瀏覽器，確認仍可登入、剛才的聯絡人/設定仍在。
- **通過標準**：重啟前後資料一致，無需重新登入（dev 使用 MemoryStore 時重啟仍會掉登入為預期，但 DB/uploads 內容須仍在）。

---

## 2) Railway：重啟服務後資料仍在

- **目的**：確認 Volume 掛載 `/data` 與 `DATA_DIR` 生效，重啟後 DB 與 uploads 不丟。
- **步驟**：
  1. 部署完成後，以 APP_DOMAIN 開啟網站並登入。
  2. 建立或編輯一筆聯絡人、或修改設定，確認有儲存成功。
  3. 到 Railway 後台，對該 Web Service 點選 **Restart**。
  4. 等待服務重新啟動完成後，再次開啟同一網址。
  5. 登入（若使用 Redis，Session 仍在可免再登入；若曾重啟 Redis 則需重新登入），檢查聯絡人列表與設定是否與重啟前一致。
- **通過標準**：聯絡人、訊息、設定等資料重啟後仍存在；上傳過的檔案仍可讀取。

---

## 3) 兩人同時登入不互踢

- **目的**：確認 Session 使用 Redis，多人同時使用不會互相登出。
- **步驟**：
  1. 使用**帳號 A** 在瀏覽器一（或一般視窗）登入。
  2. 使用**帳號 B** 在瀏覽器二（或無痕視窗）登入。
  3. 兩邊同時操作：切換聯絡人、進入設定、留言中心等，持續數分鐘。
  4. 確認兩邊皆未出現被登出、跳回登入頁的情況。
- **通過標準**：兩帳號可同時在線、各自操作，無互踢。

---

## 快速對照

| 項目 | 預期 |
|------|------|
| 本地 DATA_DIR | `./data` 內有 omnichannel.db、uploads；重啟後資料仍在 |
| Railway 重啟 | 聯絡人/設定/上傳檔案仍在 |
| 兩人同時登入 | 無互踢，Session 由 Redis 持久化 |
