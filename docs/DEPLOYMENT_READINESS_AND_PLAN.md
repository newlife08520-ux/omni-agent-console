# 部署前盤點與上線方案

目標：**正式上線、長期運行、多人同時使用**，非 demo。  
本文件為「部署前盤點 + 上線方案」，以務實可落地為原則。

---

## A. 現況盤點

### 1. 前端技術

| 項目 | 現況 |
|------|------|
| 框架 | **React 18** |
| 建置工具 | **Vite 7** |
| 路由 | **wouter** |
| 狀態／請求 | TanStack React Query、React Hook Form |
| UI | Radix UI、Tailwind CSS、Lucide Icons |
| 即時 | SSE（`/api/events`）＋ 前端 EventSource |
| 產物 | `npm run build` → **dist/public/**（靜態檔 + index.html） |

結論：**前後端同一 repo，production 時由後端 Express 提供靜態檔**（`server/static.ts` 讀取 `dist/public`），未拆成獨立 SPA 部署。

---

### 2. 後端技術

| 項目 | 現況 |
|------|------|
| 執行環境 | **Node.js**（建議 18+） |
| 框架 | **Express 5** |
| 啟動方式 | 單一進程：`node dist/index.cjs`（production）或 `tsx server/index.ts`（dev） |
| API 形態 | 同源 API routes，無獨立 API 網域 |
| 認證 | **express-session**（cookie-based），依 **MemoryStore** 存 session |

結論：**前後端一體**，不適合拆成純 serverless（有長期連線、定時任務、檔案寫入）。

---

### 3. 資料庫

| 項目 | 現況 |
|------|------|
| 類型 | **SQLite**（better-sqlite3） |
| 檔案位置 | `process.cwd()/omnichannel.db`（單一檔案） |
| 初始化 | `server/db.ts` 內建 CREATE TABLE IF NOT EXISTS，無獨立 migration 腳本 |
| ORM / 查詢 | 無 ORM，直接 **db.prepare()** 寫入／查詢 |
| Drizzle | 僅 **drizzle.config.ts** 存在（dialect: postgresql、DATABASE_URL），**目前 runtime 未使用**，僅為日後遷移預留 |

結論：**目前完全依賴本機單一 SQLite 檔案**，多實例或重啟後若無持久化磁碟會丟資料。

---

### 4. 現有 Webhook 路徑

| 方法 | 路徑 | 用途 |
|------|------|------|
| POST | `/api/webhook/line` | LINE 平台推送（訊息／事件） |
| GET  | `/api/webhook/facebook` | Meta 驗證（verify_token） |
| POST | `/api/webhook/facebook` | Meta（FB/IG）推送（留言、私訊等） |

Webhook 需**公網 HTTPS、穩定網域**，且 LINE / Meta 後台需設定此 URL。

---

### 5. 背景工作／排程／重試

| 項目 | 現況 |
|------|------|
| 逾時重分配 | **setInterval 60 秒** 呼叫 `assignment.runOverdueReassign()`（同進程內） |
| 其他排程 | 無獨立 cron／queue；評價卡為結案當下發送，無延遲排程 |
| 重試 | Webhook 內呼叫外部 API（LINE/Meta/OpenAI）有手動 retry（例如 1s、2s 延遲），無獨立 job queue |
| 去重 | `processed_events` 表（SQLite）記錄 webhook event_id，避免重複處理 |

結論：**背景邏輯與 Web 進程綁在一起**，適合單一長駐進程（VM / 單容器），不適合 serverless 或短生命週期函數。

---

### 6. 依賴本機／單機的資料與行為

| 項目 | 說明 |
|------|------|
| **omnichannel.db** | 位於 `process.cwd()`，無 env 可改路徑；重啟或換機器若無掛載同一磁碟則資料不連續 |
| **uploads/** | `process.cwd()/uploads`（含 `uploads/image-assets`、`uploads/avatars`）；上傳檔案寫入本機，無雲端儲存 |
| **Session** | MemoryStore（記憶體），多實例不共用；重啟即全部登出 |
| **監聽位址** | `httpServer.listen(port, "127.0.0.1")` 只聽本機，對外需反向代理或改為 `0.0.0.0` |
| **靜態檔** | production 時讀取 `path.resolve(__dirname, "public")`（即 **dist/public**），與執行檔同機 |

結論：**DB、檔案、Session、監聽** 皆假設單機、本機磁碟，直接上雲且不調整會不穩定或無法多人／多實例使用。

---

### 7. 環境變數（程式內實際使用）

| 變數 | 用途 | 必填（production） |
|------|------|---------------------|
| **NODE_ENV** | production 時要設為 `production` | 是 |
| **PORT** | 服務埠，預設 5001 | 建議設 |
| **SESSION_SECRET** | session 簽章；production 未設會拒絕啟動 | **是** |
| **APP_DOMAIN** | 對外網域（不含協定），用於印出 webhook URL、SSE、圖片連結等 | **是**（接 webhook 時） |
| **REDIS_URL** | Session 持久化（production 必設，未設會拒絕啟動） | **是**（production） |
| **DATA_DIR** | 資料目錄（SQLite + uploads）；production 預設 `/data`，dev 預設 process.cwd() | 選填（Railway Volume 掛 /data 時可不設） |
| **FB_VERIFY_TOKEN** | Meta webhook 驗證用 token | 建議設（有 Meta 時） |
| **OPENAI_MODEL** | 覆寫 AI 模型（可選；否則用後台設定） | 選填 |

其餘（LINE token、FB secret、OpenAI API key、一頁商店／SHOPLINE 等）目前多數存於 **settings 表**（後台設定），上線後在系統內填寫即可。

---

## B. 建議部署架構

以「**內部長期使用、多人同時操作、穩定第一、可接 Meta/LINE webhook、可日後擴充**」為前提，建議如下。

### 架構總覽（精簡可行）

```
[ 使用者 ] → [ 網域 / CDN（可選）]
                 ↓
[ 單一後端服務 ]  ← 前後端一體（Express 提供 API + 靜態檔）
     │
     ├── 持久化磁碟 或 雲端 DB + 雲端儲存
     │      • DB：SQLite 檔案 或 遷移後 Postgres
     │      • 檔案：本機 uploads 目錄 或 S3/R2
     ├── Session：Redis 或 資料庫 session store
     └── 定時任務：同進程 setInterval（維持現狀即可）
```

不建議：前後端拆成 Vercel + serverless 後端（webhook 逾時、長連線、定時任務、檔案寫入皆不適合）。

---

### 前端部署

- **建議**：**不單獨部署前端**。目前 production 已是「Express 提供 dist/public 靜態檔」，同一服務即可。
- 若日後要拆離：可改為 Vite  build 到 `dist/public`，再將該目錄部署到 **Vercel** 或 **Cloudflare Pages**，API 指到後端網域；需處理 CORS、cookie 網域、SSE 跨域。**現階段維持一體較簡單。**

---

### 後端部署

- **建議**：**單一長駐 Node 服務**，可選：
  - **Railway**：單服務 + 持久化 Volume（放 SQLite + uploads），設定簡單，適合先上線。
  - **Render**：Web Service，可掛 Disk（付費），或改用外部 DB + 外部儲存。
- 需可設定：
  - **PORT**（平台多會注入）
  - **APP_DOMAIN**（平台提供的 hostname 或自訂網域）
  - **SESSION_SECRET**
  - 對外監聽 **0.0.0.0**（見下方必改項目）

---

### 資料庫

- **短期（最小改動）**：維持 **SQLite**，將 `omnichannel.db` 放在 **持久化 Volume**（Railway/Render 的 Disk），重啟與 redeploy 不丟資料。
- **長期／多人／高可用**：遷移至 **Postgres**（例如 **Supabase** 或 **Neon**），需改 `server/db.ts` 與所有 storage 層（或引入 Drizzle 並用既有 schema）。可列為「可後補」。

---

### 檔案儲存

- **短期**：**uploads** 目錄放在同一持久化 Volume（與 DB 同碟或同 volume），程式不改。
- **長期**：上傳改存 **S3 / Cloudflare R2**，需改 `server/routes.ts` 內上傳與讀取邏輯，並設定 env（如 `S3_BUCKET`、`R2_*`）。可後補。

---

### Staging / Production 分離

| 環境 | 建議 |
|------|------|
| **Staging** | 同一平台（Railway/Render）另開一服務，用不同專案或不同 branch 部署；DB 用另一 SQLite 檔或另一 Postgres 專案；APP_DOMAIN 用 staging 網域。 |
| **Production** | 獨立服務 + 獨立 DB + 正式網域；LINE/Meta webhook 各設對應環境 URL。 |
| 環境變數 | 各環境在平台後台分別設定，不混用。 |

---

### 環境變數整理

建議在專案內建 **`.env.example`**（不提交實際值），內容至少：

```bash
NODE_ENV=production
PORT=5001
SESSION_SECRET=          # 必填，建議 32+ 字元隨機
APP_DOMAIN=              # 例：your-app.railway.app 或 console.example.com
FB_VERIFY_TOKEN=         # Meta webhook 驗證用（可自訂）
OPENAI_MODEL=            # 選填，覆寫後台預設模型
```

其餘（LINE/FB/OpenAI 等）多數仍走後台設定，上線後在系統內填即可。

---

### 網域規劃

| 情境 | 建議 |
|------|------|
| 先上線 | 使用平台預設網域（如 `xxx.railway.app`），APP_DOMAIN 設為該 hostname，即可接 webhook。 |
| 正式對外 | 自訂網域（如 `console.yourcompany.com`），在平台綁定並設定 DNS（CNAME 或 A），APP_DOMAIN 改為該網域；LINE/Meta 後台 webhook URL 改為 `https://console.yourcompany.com/api/webhook/line` 等。 |
| HTTPS | 由 Railway/Render 提供即可，無需自建憑證。 |

---

## 不適合直接上線的現狀（風險摘要）

| 項目 | 現狀 | 風險 |
|------|------|------|
| **SQLite / 本機 DB** | 使用 `process.cwd()/omnichannel.db` 單檔 | 未掛載持久化磁碟時，redeploy/重啟即丟資料；多實例無法共用。 |
| **Webhook** | 路徑已支援公網，但需 APP_DOMAIN 正確 | 若 APP_DOMAIN 未設或錯誤，回覆連結與日誌錯誤；且目前只聽 127.0.0.1，對外無法連。 |
| **背景工作** | setInterval 60s 逾時重分配，同進程 | 若改用 serverless，每次請求新進程，無長駐 setInterval，會中斷。 |
| **本地檔案** | uploads、avatars、image-assets 寫入 `process.cwd()/uploads` | 無持久化則重啟後檔案消失；多實例無法共用。 |
| **Session** | MemoryStore（記憶體） | 重啟即全員登出；多實例 session 不共用。 |
| **登入／權限** | 已有角色與 authMiddleware | 若 SESSION_SECRET 弱或未設，production 會拒絕啟動；建議補強密碼政策與首次建帳流程。 |
| **備份／監控** | 無自動備份、無正式監控告警 | 資料損壞或服務掛掉無自動發現與還原。 |

以上皆可透過 **C. 必改** 與 **D. 可後補** 逐步處理。

---

## C. 上線前必改項目

1. **SESSION_SECRET**  
   - production 未設會直接 exit，必須在部署平台設定足夠隨機、長度足夠的 SESSION_SECRET。

2. **監聽 0.0.0.0**  
   - 目前 `listen(port, "127.0.0.1")` 僅本機可連，對外需改為 `listen(port, "0.0.0.0")`（或省略 host 讓預設為 0.0.0.0）。

3. **APP_DOMAIN**  
   - 接 LINE/Meta webhook 時必設，為對外網域（不含 `https://`），否則回覆中的連結與日誌中的 webhook URL 會錯誤。

4. **Session Store 改為持久化**  
   - MemoryStore 在重啟與多實例下不可用，建議改為 **Redis**（如 Upstash）或 **connect-redis + Redis**，並在平台設定 REDIS_URL；若暫不支援多實例，可先改為 **資料庫 session store**（需實作或套件），至少重啟後不丟 session（若單實例）。

5. **DB 與 uploads 持久化**  
   - 若維持 SQLite：**omnichannel.db** 與 **uploads** 必須放在平台提供的 **持久化 Volume/Disk**，並在啟動前確保路徑存在（或透過 env 指定目錄，程式需支援）；否則每次 redeploy 清空。

6. **登入與權限**  
   - 已有 authMiddleware、super_admin、角色區分，確保 production 僅使用強密碼、必要時可補「首次安裝建立 super_admin」流程或檔案鎖，避免未授權存取。

---

## D. 可後補項目

- **資料庫遷移 Postgres**：改用 Supabase/Neon，改寫 `server/db.ts` 與 storage 介面（或接 Drizzle），並做資料遷移。
- **上傳改 S3/R2**：上傳與讀取改走雲端，減少單機磁碟依賴。
- **備份**：SQLite 定期備份（cp/sqlite3 .backup）到雲端；Postgres 則用平台備份或 pg_dump。
- **監控與告警**：健康檢查已有 `/api/health/status`、`/api/debug/status`，可接 Uptime Robot 或平台內建；日誌可接 Logtail 等。
- **Rate limit**：對 webhook 與登入 API 做 rate limit（例如 express-rate-limit），防濫用。
- **Staging 正式化**：CI 部署到 staging、手動或按鈕部署到 production。

---

## E. 實際部署步驟（精簡版）

1. **程式與必改**  
   - 改 `server/index.ts`：`listen(port, "0.0.0.0")`。  
   - 設定 SESSION_SECRET、APP_DOMAIN（及必要時 FB_VERIFY_TOKEN）。  
   - （可選）改 Session Store 為 Redis，並設定 REDIS_URL。

2. **建置**  
   - 在本機或 CI：`npm ci && npm run build`，產出 `dist/index.cjs` 與 `dist/public/`。

3. **部署到 Railway 範例**  
   - 新增專案 → 從 GitHub 連線此 repo。  
   - 新增 **Volume**，掛載路徑設為 **`/data`**（程式透過 DATA_DIR 使用，production 未設時預設即 `/data`）。  
   - 新增 **Redis** 服務（Railway 內建或 Upstash），取得連線 URL 後設為 **REDIS_URL**。  
   - 設定 env：**NODE_ENV=production**、**PORT**（平台多會自動注入）、**SESSION_SECRET**、**REDIS_URL**、**APP_DOMAIN**；可選 **DATA_DIR=/data**（production 預設已是 /data，若 Volume 掛在別徑再改）。  
   - 設定啟動指令：`npm run build && node dist/index.cjs` 或先於 CI 建置後 `node dist/index.cjs`；Working Directory 為 repo 根目錄。  
   - 程式會將 SQLite 寫入 `DATA_DIR/omnichannel.db`、上傳寫入 `DATA_DIR/uploads`，並在啟動時自動建立 uploads 目錄。

4. **Webhook**  
   - 取得服務網址（如 `https://xxx.railway.app`）。  
   - LINE 開發者後台：Webhook URL = `https://xxx.railway.app/api/webhook/line`。  
   - Meta 開發者後台：Webhook URL = `https://xxx.railway.app/api/webhook/facebook`，Verify Token = FB_VERIFY_TOKEN。

5. **Railway 必設環境變數**  
   | 變數 | 說明 |
   |------|------|
   | NODE_ENV | production |
   | PORT | 通常由平台注入 |
   | SESSION_SECRET | 必填，建議 32+ 字元隨機 |
   | REDIS_URL | 必填（production），Railway Redis 或 Upstash 連線 URL |
   | APP_DOMAIN | 對外網域（例：xxx.railway.app 或自訂網域） |
   | DATA_DIR | 選填，預設 production 為 /data；Volume 掛 /data 時可不設 |
   | FB_VERIFY_TOKEN | 有 Meta 時必設，與 FB 後台 Verify Token 一致 |

   LINE Channel Secret / Access Token、Meta App Secret、OpenAI API Key、一頁商店／SHOPLINE 等請在**系統後台（設定／品牌管理）**填寫，非 env。

6. **驗證**  
   - 瀏覽 `https://xxx.railway.app` 可開登入頁、登入後可操作。  
   - 送一則 LINE/Meta 測試訊息，確認後台有對話、無 5xx。  
   - 依 **F. 驗收步驟** 做重啟不丟資料、兩人同時登入不互踢。

---

## F. 驗收步驟

### 一般驗收

| # | 項目 | 方式 |
|---|------|------|
| 1 | 首頁與登入 | 開啟 APP_DOMAIN，登入後可進入主畫面。 |
| 2 | Webhook LINE | 從 LINE 發一則訊息，後台出現該聯絡人與訊息，AI 或模板有回覆。 |
| 3 | Webhook Meta | 從 FB/IG 觸發一則留言或私訊，後台可見並可回覆。 |
| 4 | 重啟不丟資料 | 重啟服務後，再次登入、聯絡人/訊息仍存在。 |
| 5 | 多人同時使用 | 兩組以上帳號同時登入、各自操作聯絡人/設定，無互相登出或錯亂。 |
| 6 | 上傳與靜態 | 上傳頭像或知識庫檔案，重新整理後仍可讀取（路徑正確、權限正常）。 |

### 部署必驗（持久化與 Session）

1. **本地 DATA_DIR 與重啟**  
   - 本機執行：`DATA_DIR=./data npm run dev`（Windows：`set DATA_DIR=./data && npm run dev`）。  
   - 登入、新增一筆聯絡人或設定，確認有寫入。  
   - 停止服務後再執行一次（同上），確認 DB 與 uploads 仍在 `./data`，登入狀態與資料不丟。

2. **Railway 重啟後資料仍在**  
   - 部署完成後登入、建立/編輯聯絡人或設定。  
   - 在 Railway 後台對該服務執行 **Restart**。  
   - 再次開啟網站，確認可登入、聯絡人/訊息/設定仍存在（SQLite 與 uploads 在 Volume `/data`）。

3. **兩人同時登入不互踢**  
   - 用兩個不同帳號（例如 A、B）在兩個瀏覽器或無痕視窗同時登入。  
   - 各自切換聯絡人、設定頁等操作一段時間。  
   - 確認兩邊皆未被迫登出、Session 由 Redis 持久化正常。

---

## 7. Cursor 可處理 vs 您需手動 vs 需提供的資料

### Cursor 可直接處理（程式與文件）

- 修改 **server/index.ts**：`listen(port, "0.0.0.0")`。  
- 新增 **.env.example** 與 **docs 內環境變數說明**。  
- （若您決定採用）**Session 改 Redis**：加入 connect-redis、從 REDIS_URL 讀取、替換 MemoryStore。  
- （若您決定採用）**DB/uploads 路徑可配置**：例如支援 `DATA_DIR` 或 `DB_PATH`、`UPLOADS_DIR`，讓 SQLite 與 uploads 寫到 Volume 路徑。  
- 撰寫或更新 **README 部署段落**、**DEPLOYMENT_READINESS_AND_PLAN.md** 的實際步驟（如 Railway/Render 按鈕與截圖說明）。

### 需您手動在平台設定的項目

- **Railway / Render**：建立專案、連線 repo、建立 Volume、設定 env（SESSION_SECRET、APP_DOMAIN、PORT、FB_VERIFY_TOKEN、REDIS_URL 等）。  
- **LINE 開發者後台**：Webhook URL、Channel Secret、Access Token（後兩個多數仍從系統後台設定讀取）。  
- **Meta 開發者後台**：Webhook URL、Verify Token、App Secret（後者多從系統後台設定）。  
- **DNS**：若用自訂網域，在註冊商設定 CNAME 或 A 指向平台。  
- **首次建立 super_admin**：若 DB 為新建，需有方式寫入第一筆管理員（例如本機跑一次 script 或後台「首次設定」流程）。

### 需要您先提供的資料（若要我代寫設定範例）

- 預計使用的**平台**（Railway / Render / 其他）。  
- 是否已有 **Redis**（或要用 Upstash 等），以及 **REDIS_URL** 格式是否需隱藏網域。  
- **APP_DOMAIN** 預計用哪個（平台預設網域或自訂網域）。  
- 若要做 **DB 路徑可配置**：Volume 掛載路徑（例如 `/data` 或 `C:\data`）。

---

以上為部署前盤點與上線方案；先完成 **C. 上線前必改項目** 再部署，可大幅降低上線後問題。若您指定平台與選項，我可以再產出該平台的具體步驟與可貼上的 env 範例。
