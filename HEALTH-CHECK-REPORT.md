# Omni-Agent-Console 專案健康檢查報告

> 本報告為盤點結果，未對程式進行任何修改。

---

## 一、高風險問題

### 1. 正式環境 Session 存在記憶體，重啟就消失、無法多機共用
- **位置**：`server/index.ts`，使用 `memorystore` 存 session。
- **說明**：登入狀態寫在目前這台機器的記憶體裡。伺服器重開或部署新版本，所有人會被登出；若以後用兩台以上機器做負載平衡，session 不會共用，使用者會一直被踢出。
- **影響**：正式上線或多人使用時，登入體驗差、除錯困難。

### 2. 預設 Session 密鑰寫死在程式裡
- **位置**：`server/index.ts`，`secret: process.env.SESSION_SECRET || "omnichannel-secret-key"`。
- **說明**：沒設 `SESSION_SECRET` 時會用固定字串。若部署時忘記設環境變數，所有人共用同一個可猜到的密鑰，cookie 可能被偽造、冒用他人登入。
- **影響**：正式環境有安全風險。

### 3. 只監聽 127.0.0.1，同一台電腦以外連不到
- **位置**：`server/index.ts`，`httpServer.listen(port, "127.0.0.1", ...)`。
- **說明**：只綁定本機。同一台電腦用 localhost 可連，但同一網路的手機、其他電腦無法用「你的 IP:5001」連到後台。
- **影響**：若要在公司內網或本機以外測試，會連不上；部署到雲端時若沒改，可能只允許本機連線。

### 4. `nanoid` 未列在 package.json，可能安裝不完整
- **位置**：`server/vite.ts` 使用 `import { nanoid } from "nanoid"`，但 `package.json` 的 `dependencies` 裡沒有 `nanoid`。
- **說明**：目前可能是被 Vite 或其他套件間接裝進來，所以能跑。日後 clean install 或換環境，若沒有依賴帶入，`npm install` 後跑 `npm run dev` 可能直接報錯。
- **影響**：新環境或 CI 建置有機會失敗。

### 5. 正式環境靜態檔路徑依賴打包後的 __dirname
- **位置**：`server/static.ts`，`path.resolve(__dirname, "public")`。
- **說明**：正式環境跑的是 `dist/index.cjs`，所以 `__dirname` 會是 `dist`，實際會找 `dist/public`，和 Vite 輸出一致，目前是對的。但若以後改打包方式（例如輸出到別目錄、或改檔名），這裡沒一起改就會 404。
- **影響**：改 build 流程時容易踩雷，算結構性風險。

---

## 二、中風險問題

### 6. `server/routes.ts` 單檔超過 3200 行，過於肥大
- **位置**：`server/routes.ts`（約 3251 行）。
- **說明**：所有 API、LINE/FB webhook、AI、訂單、知識庫等邏輯都在同一檔。找一個功能要捲很久，改一處容易動到別處，合併衝突機率高。
- **影響**：維護與擴充成本高，新人接手困難。

### 7. 實際用 SQLite，但 Drizzle 設定成 PostgreSQL，且必填 DATABASE_URL
- **位置**：`server/db.ts` 用 `better-sqlite3` + 本機 `omnichannel.db`；`drizzle.config.ts` 要求 `process.env.DATABASE_URL` 且為 PostgreSQL。
- **說明**：真正跑的是 SQLite，沒用 Drizzle 連線。但執行 `npm run db:push` 會因為沒設 `DATABASE_URL` 直接拋錯；若有人照文件用 Drizzle 操作，會和現有 SQLite 脫節。
- **影響**：指令與文件容易誤導，日後若要換成 Postgres 也要改一堆地方。

### 8. 未使用的依賴：passport、passport-local、pg、connect-pg-simple
- **位置**：`package.json` 的 `dependencies`。
- **說明**：登入是用自寫的 session + storage，沒用 Passport；資料庫是 SQLite，沒用 pg。這些套件在程式裡沒有被 import。
- **影響**：安裝變慢、node_modules 變大、安全更新時要多追一堆套件，且容易讓人誤以為有在用。

### 9. Vite 開發時錯誤處理直接 process.exit(1)
- **位置**：`server/vite.ts`，`customLogger.error` 裡呼叫 `process.exit(1)`。
- **說明**：Vite 編譯或執行時一報錯就把整個 Node 關掉。在開發時會突然斷線，若搭配自動重啟或監聽檔案，會一直重啟。
- **影響**：開發體驗差，不利除錯。

### 10. OpenAI 模型名稱寫死為 gpt-5.2
- **位置**：`server/routes.ts` 與 `client/src/pages/settings.tsx` 多處寫死 `gpt-5.2`。
- **說明**：若你的 OpenAI 帳號沒有 gpt-5.2（例如只有 gpt-4o），所有 AI 功能會失敗。未來若 OpenAI 改版或棄用該型號，要全域搜尋替換。
- **影響**：模型升級或帳號權限不同時，容易整批壞掉。

### 11. 日誌會把 API 回應內容整段印出來
- **位置**：`server/index.ts`，API 的 middleware 會 `console.log(JSON.stringify(capturedJsonResponse))`。
- **說明**：除錯方便，但若回應裡有敏感資料（token、個資），會寫進 log，被看到就有風險。
- **影響**：正式環境若沒關閉或過濾，有資安與合規風險。

---

## 三、低風險問題

### 12. Replit 相關套件與設定
- **位置**：`vite.config.ts` 使用 `@replit/vite-plugin-runtime-error-modal`；`REPL_ID` 存在時才載入 cartographer、dev-banner；`package.json` 有三個 `@replit/*` devDependencies。
- **說明**：在 Windows 本機沒有 `REPL_ID`，所以那兩個 plugin 不會載入，但 config 和依賴還在。Replit 的 error modal 在非 Replit 環境可能多餘。
- **影響**：本機可正常跑，只是多一點雜訊與依賴。

### 13. `attached_assets` 目錄與 @assets alias
- **位置**：`vite.config.ts` 的 `@assets` 指向 `attached_assets`；專案裡已有該資料夾與檔案。
- **說明**：若有人刪掉 `attached_assets` 或沒建，前端 import `@assets/...` 會失敗。目前有目錄，屬低風險。
- **影響**：之後若精簡專案或改目錄結構要注意。

### 14. better-sqlite3 在 Windows 需編譯環境
- **位置**：`package.json` 的 `better-sqlite3`。
- **說明**：這是 native 模組，Windows 上 `npm install` 可能需要 Visual Studio Build Tools 或 windows-build-tools，否則編譯失敗。
- **影響**：新電腦或 CI 若沒裝編譯工具，會裝不起來；裝好就沒事。

### 15. 變數命名遮蔽內建模組
- **位置**：`server/index.ts` 的 middleware 裡 `const path = req.path`，和頂層 `import path from "path"` 的 `path` 同名。
- **說明**：在該 middleware 內 `path` 是字串，不是 Node 的 path。目前該段沒用到 path 模組，所以不會當機，只是容易誤讀。
- **影響**：低，僅程式可讀性。

### 16. package.json 的 name 為 "rest-express"
- **位置**：`package.json` 的 `"name": "rest-express"`。
- **說明**：與專案實際用途（全通路 AI 客服中控台）不符，可能是範本沒改。
- **影響**：僅辨識與文件上的混淆。

---

## 四、建議先做的 5 個優化項目

依「風險＋實作成本」排序，建議優先做這 5 項：

1. **把 `nanoid` 正式列為依賴**  
   在 `package.json` 的 `dependencies` 加上 `"nanoid"`，避免日後在新環境或 CI 跑不起來。不改程式邏輯，只改依賴表。

2. **正式環境一定要用 SESSION_SECRET**  
   在部署文件或啟動腳本中明確寫：正式環境必須設定 `SESSION_SECRET`，且不要用預設值。有餘力可改為未設定時在 production 直接 throw，強制提醒。

3. **清理未使用依賴**  
   移除或改為 optional：`passport`、`passport-local`、`pg`、`connect-pg-simple`（若確定不會用到）。可減少安裝時間與維護負擔。

4. **移除或條件化 Replit 專用 Vite 設定**  
   若不再在 Replit 開發：可拿掉 `@replit/vite-plugin-runtime-error-modal` 以及 `REPL_ID` 相關的 cartographer、dev-banner，減少本機與建置的干擾。

5. **開始拆分 routes.ts**  
   不必一次大改。可先依功能拆成多個小檔（例如：`routes/auth.ts`、`routes/webhook-line.ts`、`routes/webhook-fb.ts`、`routes/contacts.ts`…），在 `routes.ts` 只做 `app.use(...)` 掛載。之後新功能或修 bug 會好找、好改。

---

**報告結束。以上為盤點結果，未對程式做任何修改。**
