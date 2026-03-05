# 專案 Bug / 潛在問題盤點清單

> 僅列出問題，未修改程式。

---

## 1. 確定是 bug

### 1.1 SSE 斷線日誌人數少算一個
- **位置**：`server/routes.ts`，`/api/events` 的 `req.on("close", ...)` 裡。
- **狀況**：先執行 `sseClients.delete(res)` 後再 `console.log("remaining:", sseClients.size - 1)`，所以 log 顯示的是「目前人數再減 1」，少算一個。
- **影響**：除錯時看到的 SSE 連線數不正確。

### 1.2 路由參數 `:id` 未驗證為整數，可能靜默失敗
- **位置**：`server/routes.ts` 多處 `parseInt(req.params.id)` 後直接用於更新（例如 `PUT /api/contacts/:id/human`、`PUT /api/contacts/:id/status` 等）。
- **狀況**：若傳入 `:id` 為 `abc` 或空，`parseInt` 得 `NaN`，仍會呼叫 `storage.updateContactHumanFlag(NaN, ...)` 等。SQLite 用 `WHERE id = NaN` 不會匹配，更新 0 筆，但 API 仍回 200 與 `success: true`。
- **影響**：前端以為更新成功，實際沒改到任何一筆，行為與回傳不一致。

### 1.3 `db:push` 與實際資料庫不一致，執行必爆錯
- **位置**：`package.json` 的 `"db:push": "drizzle-kit push"`，搭配 `drizzle.config.ts`。
- **狀況**：專案實際用 **SQLite**（`server/db.ts` + `omnichannel.db`），但 Drizzle 設定為 **PostgreSQL** 且必填 `DATABASE_URL`。未設時執行 `npm run db:push` 會直接 throw，且與現有 DB 無關。
- **影響**：指令無法使用，且容易誤以為有在用 Drizzle 管理 DB。

---

## 2. 高機率會出問題

### 2.1 package.json scripts 在非 Windows 的寫法
- **位置**：`package.json` 的 `dev`、`start` 使用 `cross-env NODE_ENV=...`。
- **狀況**：`cross-env` 已用於主要指令，多數情況可跨平台。但 `db:push` 未用 `cross-env`，若日後在 script 裡加環境變數，在 Linux/mac 用 `NODE_ENV=production npm run db:push` 等寫法會和 Windows 不一致。
- **影響**：腳本若再擴充 env，跨平台行為可能不一致；目前 `db:push` 本身就會因 DATABASE_URL 失敗，屬次要。

### 2.2 server 啟動無錯誤處理，崩潰時難排查
- **位置**：`server/index.ts`。
- **狀況**：
  - 最外層是 `(async () => { ... })()`，沒有 `.catch()`，若 `registerRoutes()` 或 `serveStatic()` 等丟出例外或 Promise rejection，會變成 **unhandled rejection**，process 可能直接結束且只看到 Node 預設錯誤。
  - `httpServer.listen(port, "127.0.0.1", () => { ... })` 只傳了成功 callback，沒有處理 `listen` 的錯誤（例如 port 被佔用 `EADDRINUSE`），錯誤會以 exception 拋出，若沒被接到也會直接崩潰。
- **影響**：部署或本機 port 衝突、DB 或 routes 初始化失敗時，日誌不友善，難以判斷原因。

### 2.3 只監聽 127.0.0.1，外網／同網段無法連
- **位置**：`server/index.ts`，`httpServer.listen(port, "127.0.0.1", ...)`。
- **狀況**：只綁定本機。同一台電腦用 localhost 正常，但同網段其他裝置（例如手機、另一台電腦）無法用「本機 IP:port」連到後台。
- **影響**：需從他機或外網連線時會連不到；部署到雲端時若未改，可能只有本機能連。

### 2.4 登入無速率限制，可被暴力猜密碼
- **位置**：`server/routes.ts`，`POST /api/auth/login`。
- **狀況**：僅檢查帳密，沒有依 IP 或帳號做嘗試次數／頻率限制。
- **影響**：可被暴力嘗試密碼，帳號若用弱密碼風險高。

### 2.5 Session 僅存記憶體，重啟即全登出、無法水平擴展
- **位置**：`server/index.ts`，使用 `memorystore`。
- **狀況**：Session 只存在單一 process 記憶體。重啟服務或部署新版本，所有人登入狀態消失；多 instance 時 session 不共用。
- **影響**：正式環境重啟就全登出；要跑多台時必須改存到 Redis 等外部 store。

### 2.6 登出未 regenerate session ID，有 session 固定風險
- **位置**：`server/routes.ts`，`POST /api/auth/logout`。
- **狀況**：僅把 `session.authenticated` 等欄位清空，沒有 `req.session.regenerate()` 或換新 session ID。
- **影響**：若存在 session 固定或竊取 cookie 的情境，理論上風險較高；實務上若 cookie 有設好 httpOnly/sameSite 會稍緩和，但仍建議登出時換 session。

### 2.7 開發環境 SESSION_SECRET 仍用預設值
- **位置**：`server/index.ts`，production 已強制檢查 `SESSION_SECRET`，但開發時仍用 `process.env.SESSION_SECRET || "omnichannel-secret-key"`。
- **狀況**：本機沒設 `SESSION_SECRET` 時會用固定字串，多人共用同一專案或把本機當類正式環境時，密鑰一致有風險。
- **影響**：開發／測試環境若與他人或正式混用，session 安全性較弱。

### 2.8 上傳目錄 `uploads` 若不存在可能出錯
- **位置**：`server/index.ts`，`app.use("/uploads", express.static(path.resolve(process.cwd(), "uploads")))`；以及 `server/routes.ts` 裡 multer 的 `destination`。
- **狀況**：`routes.ts` 裡有對 `uploads`、`uploads/image-assets` 做 `fs.mkdirSync(..., { recursive: true })`，但 `index.ts` 掛載靜態時若目錄不存在，express.static 行為可能不如預期；且若先接到靜態請求再有任何寫入，理論上仍有極少數路徑可能出錯。
- **影響**：全新環境或目錄被刪時，上傳或存取 `/uploads` 有機會出錯或 404。

### 2.9 Webhook 非同步處理中未捕獲的錯誤
- **位置**：`server/routes.ts`，LINE / FB webhook 在 `res.status(200).json(...)` 後用 IIFE 做非同步處理，並有 `.catch(...)`。
- **狀況**：多數已有 try/catch 或 .catch；若未來在非同步流程中新增的程式沒包到，漏掉的 rejection 會變成 unhandled，可能只印錯誤就結束，不影響 200 但 process 可能不穩。
- **影響**：目前結構尚可，但擴充 webhook 邏輯時容易漏接錯誤，風險偏高。

---

## 3. 建議改善但不急

### 3.1 正式環境靜態檔路徑依賴打包後 __dirname
- **位置**：`server/static.ts`，`path.resolve(__dirname, "public")`。
- **狀況**：正式跑的是 `dist/index.cjs`，`__dirname` 為 `dist`，所以會找 `dist/public`，與 Vite 輸出一致，目前正確。但若日後改 build 輸出目錄或檔名，這裡沒一起改會 404。
- **影響**：改 build 流程時要記得同步改，屬維護面風險。

### 3.2 前端 API 路徑用 queryKey.join("/") 的約定
- **位置**：`client/src/lib/queryClient.ts`，`getQueryFn` 用 `queryKey.join("/")` 當 URL。
- **狀況**：目前多數 queryKey 為單一完整路徑（如 `["/api/settings"]`）或 `["/api/contacts", id, "messages"]`，join 後路徑正確。若日後有人寫成 `["/api", "settings"]` 會變成 `/api/settings` 仍對，但若路徑含多段數字或斜線，需注意 join 結果是否與後端一致。
- **影響**：目前無問題，建議在共同風格或註解中約定 queryKey 格式，避免之後踩雷。

### 3.3 錯誤處理 middleware 僅回傳 message，無錯誤碼或類型
- **位置**：`server/index.ts`，`app.use((err, _req, res, next) => ...)` 回傳 `res.status(status).json({ message })`。
- **狀況**：前端只能依 status 和 message 判斷，沒有共用的 `code` 或 `type` 欄位，不利前端統一處理（例如重試、導頁、顯示特定 UI）。
- **影響**：功能可正常，但擴充錯誤處理與 UX 時會較費工。

### 3.4 部分 API 未檢查 body 型別
- **位置**：例如 `server/routes.ts` 的 `PUT /api/settings` 等，`const { key, value } = req.body` 未檢查 `req.body` 是否為物件。
- **狀況**：若 client 送錯 Content-Type 或 body 非 JSON，`req.body` 可能為 undefined，取 `key` 會 undefined，後續邏輯可能回 400 或 500，但錯誤訊息不一定清楚。
- **影響**：前端正常送時沒事；異常請求時除錯較不直覺。

### 3.5 密碼以 SHA-256 儲存，未加鹽
- **位置**：`server/db.ts` 的 `hashPassword`，`server/storage.ts` 的 `authenticateUser`。
- **狀況**：密碼用單次 SHA-256 後存進 DB，沒有 salt，相同密碼 hash 相同，易被彩虹表或重放攻擊推測。
- **影響**：內網或低風險環境尚可接受，對高敏感環境建議改為 bcrypt/argon2 等加鹽雜湊。

### 3.6 環境變數未集中說明
- **位置**：全專案。
- **狀況**：`PORT`、`SESSION_SECRET`、`APP_DOMAIN`、`OPENAI_MODEL`、`FB_VERIFY_TOKEN` 等散落各檔案，沒有單一 `.env.example` 或文件列出必填/選填與說明。
- **影響**：新環境部署或交接時容易漏設或設錯。

### 3.7 前端登出未處理 API 失敗
- **位置**：`client/src/App.tsx`，`handleLogout` 呼叫 `apiRequest("POST", "/api/auth/logout")` 後直接 invalidateQueries。
- **狀況**：若登出 API 失敗（網路錯誤、500），仍會 invalidate 並可能導向登入頁，但 session 在後端可能仍存在；若使用者重試或重新整理，狀態可能不一致。
- **影響**：多數情況下使用者重登即可；極少數情境下可能出現「前端已登出、後端仍認為已登入」的短暫不一致。

### 3.8 AuthenticatedApp 內 /api/settings 失敗時無專用 UI
- **位置**：`client/src/App.tsx`，`useQuery({ queryKey: ["/api/settings"], queryFn: getQueryFn({ on401: "throw" }) })`。
- **狀況**：若該 query 失敗（非 401），預設會 throw，被 React Query 的 error boundary 或上層處理；若沒有全域 error boundary，可能整頁白屏或只顯示錯誤訊息，沒有「重試」或「部分功能降級」的 UI。
- **影響**：設定載入失敗時體驗較差，不影響正常路徑。

---

**以上為本次盤點結果，未對程式做任何修改。**
