# 本輪 Bug 修復驗收步驟（完整版）

本文件為「確定是 bug」三項修復的完整驗收清單，包含：正常流程、無效 :id、合法 id 但資料不存在、前端反應、SSE 多 client、以及啟動錯誤處理。

---

## 前置：你要輸入什麼指令

在專案根目錄（`Omni-Agent-Console`）執行：

```bash
npm run dev
```

待出現 `serving on port 5001` 與 Webhook URLs 區塊後，再進行下列驗收。

---

## 一、正常啟動與基本功能

### 1.1 正常啟動

- **步驟**：執行 `npm run dev`。
- **預期**：
  - 終端出現 `serving on port 5001`。
  - 出現 Webhook URLs 區塊（LINE、FB、SSE 網址）。
  - 無未捕獲錯誤或 process 崩潰。
- **失敗時**：檢查是否有 `[server] Startup failed:` 或 `Listen error:`，依訊息排查 DB、port、依賴。

### 1.2 首頁與登入

- **步驟**：瀏覽器開啟 `http://localhost:5001`，應看到登入頁；使用測試帳密登入（例如 admin / admin123）。
- **預期**：登入後進入中控台（聯絡人/品牌等），無白畫面、無卡住、無無限 loading。
- **失敗時**：看終端是否有 API 500、看瀏覽器 Console 是否有錯誤。

---

## 二、:id 無效時必回 400（後端）

### 2.1 無效 id 回傳 400 與固定訊息

- **步驟**：登入後，對「帶 :id 的 API」傳入**非法 id**（例如 `abc`、`0`、`-1`、空字串、小數）。
  - 例 1：`GET http://localhost:5001/api/brands/abc`
  - 例 2：`PUT http://localhost:5001/api/contacts/abc/status`，body：`{"status":"resolved"}`
  - 例 3：`GET http://localhost:5001/api/contacts/0`
- **預期**：
  - **HTTP 狀態碼：400**
  - **Response body** 含 `"無效的 ID"`（或與後端實作一致的 message 欄位）。
  - 不會回 200 且 `success: true`。
- **失敗時**：確認該路由已改為使用 `parseIdParam` 並在 null 時 `res.status(400).json({ message: "無效的 ID" })`。

---

## 三、合法整數 id 但資料不存在（後端）

### 3.1 合法 id、資源不存在時回 404 與明確訊息

- **步驟**：登入後，對「帶 :id 的 API」傳入**合法正整數**，但該 id 在資料庫中**不存在**（例如很大的 id：`99999`）。
  - 例 1：`GET http://localhost:5001/api/brands/99999`
  - 例 2：`GET http://localhost:5001/api/contacts/99999`
  - 例 3：`PUT http://localhost:5001/api/contacts/99999/status`，body：`{"status":"resolved"}`
- **預期**：
  - **HTTP 狀態碼：404**
  - **Response body** 為 404 的 JSON，例如：
    - 品牌：`{ "message": "品牌不存在" }`
    - 聯絡人：`{ "message": "聯絡人不存在" }`
    - 其他資源同理，為既有 404 訊息。
  - **不會**回 400「無效的 ID」，也**不會**回 200 與 `success: true`。
- **失敗時**：確認 `parseIdParam` 只擋「非正整數」；合法整數會進入後續邏輯，由 `getBrand(id)` / `getContact(id)` 等回 undefined 時回 404。

---

## 四、前端驗收：無效 id 回 400 時的反應

### 4.1 不白畫面、不卡住、不無限 loading

- **步驟**：
  1. 登入後進入「聯絡人」或「品牌」等會用到 :id 的頁面。
  2. 手動觸發一個「會帶無效 id 的請求」：
     - **方式 A**：在瀏覽器網址列改成無效 id，例如從 `http://localhost:5001/` 進聯絡人後，若前端有「聯絡人詳情」網址含 id，改成 `.../contacts/abc` 或 `.../contacts/0`（依你前端路由而定）。
     - **方式 B**：用開發者工具 Network 對某個「會打 /api/.../:id」的按鈕或連結做修改，讓請求的 id 變成 `abc`；或直接在前端暫時改程式，讓某個 API 請求打 `/api/contacts/abc`。
  3. 觀察畫面與 loading 狀態。
- **預期**：
  - **不會**整頁白畫面。
  - **不會**畫面卡住或無限 loading（轉圈一直轉）。
  - 應出現下列其中一種合理行為（依目前前端實作）：
    - 顯示錯誤訊息（toast / 區塊提示）如「無效的 ID」或「請求失敗」；
    - 或列表/詳情區顯示「載入失敗」「無此資料」等，並可返回或重新整理；
    - 或該請求被標記為錯誤，其他區塊仍可操作。
  - 使用者仍可導航、重新選擇聯絡人/品牌、或重整頁面。
- **失敗時**：檢查前端對 400 的處理：是否有 catch、是否在錯誤時設 loading false、是否有 error boundary 或 fallback UI，避免未處理的 promise 導致白畫面或卡住。

---

## 五、SSE 連線數驗收（單 client 與多 client）

### 5.1 單一 client 斷線後剩餘數為 0

- **步驟**：
  1. 登入後，只開**一個**分頁連到 `http://localhost:5001`（會建立一條 SSE）。
  2. 看 server 終端：應出現 `[SSE] Client connected, total clients: 1`。
  3. 關閉該分頁。
  4. 再看終端。
- **預期**：出現 `[SSE] Client disconnected, remaining: 0`（**不是** `remaining: -1`）。
- **失敗時**：確認 `req.on("close")` 內順序為：先 `sseClients.delete(res)`，再 `console.log("remaining:", sseClients.size)`。

### 5.2 多 client：連線數增加與關閉後剩餘數量正確

- **步驟**：
  1. 登入後，開**第一個**分頁：`http://localhost:5001`。
     - 終端應出現：`[SSE] Client connected, total clients: 1`。
  2. 再開**第二個**分頁（新分頁）：同樣 `http://localhost:5001`。
     - 終端應出現：`[SSE] Client connected, total clients: 2`。
  3. 關閉**其中一個**分頁。
     - 終端應出現：`[SSE] Client disconnected, remaining: 1`。
  4. 再關閉**另一個**分頁。
     - 終端應出現：`[SSE] Client disconnected, remaining: 0`。
- **預期**：
  - 連線時：`total clients` 依序為 1、2（與實際分頁數一致）。
  - 斷線時：`remaining` 依序為 1、0（每次少 1，且不會出現負數或少算）。
- **失敗時**：確認每次 `close` 只做一次 `sseClients.delete(res)`，且 log 用的是 `sseClients.size`（斷線後的即時數量）。

---

## 六、啟動錯誤處理（listen 失敗）

### 6.1 Port 被佔用時有明確錯誤並結束

- **步驟**：
  1. 先讓 5001 被佔用（例如再開一個終端執行 `npm run dev` 佔用 5001，或使用其他程式綁定 5001）。
  2. 在另一個終端再次執行 `npm run dev`。
- **預期**：
  - 終端印出 `[server] Listen error:` 與錯誤訊息。
  - 若為 port 被佔用，應出現 EADDRINUSE 相關提示（例如「Port 5001 is already in use」）。
  - Process 以 **exit code 1** 結束（不會一直掛著或未處理例外）。
- **失敗時**：確認 `httpServer.on("error", ...)` 在 `httpServer.listen(...)` 之前註冊，且內有 `process.exit(1)`。

---

## 七、驗收失敗時的下一步排查

| 現象 | 建議排查 |
|------|----------|
| :id 無效仍回 200 | 確認請求 URL 是否為帶 :id 的路由；在該路由開頭 log `req.params.id` 與 `parseIdParam(req.params.id)`，確認無效時有回 400。 |
| 合法 id 不存在時回 400 | 確認該路由在 `parseIdParam` 通過後，用 `getBrand(id)` / `getContact(id)` 等判斷不存在時回 404，而非當成「無效 id」。 |
| 前端白畫面/卡住/無限 loading | 檢查該 API 的 400 回應是否被 catch、loading 是否在錯誤時關閉、是否有 error boundary 或 fallback。 |
| SSE 人數不對 | 確認 `close` 時先 `delete(res)` 再 log `sseClients.size`；確認沒有重複 delete 或漏 delete。 |
| 啟動無明確錯誤 | 區分是「Listen error」還是「Startup failed」；對應檢查 `on("error")` 與 try/catch 是否涵蓋該錯誤路徑。 |

---

**本輪修復範圍**：① :id 無效時統一回 400；② 合法 id 資料不存在時維持 404；③ 前端在 400 時不白畫面/不卡住；④ SSE 斷線 log 剩餘數正確；⑤ 多 client SSE 連線數正確；⑥ 啟動與 listen 錯誤有明確輸出並 exit(1)。
