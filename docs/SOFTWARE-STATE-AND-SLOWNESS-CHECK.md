# 軟體狀態與變慢檢查報告

**檢查日期**：2025-03-03  
**目的**：回應「打不太開軟體、速度都超慢」之全面檢查。

---

## 一、目前軟體狀態摘要

| 項目 | 狀態 |
|------|------|
| **專案結構** | 單一 repo，Express 後端 + Vite 前端（client/），開發時 `npm run dev` 會啟動後端並掛載 Vite middleware |
| **Node** | v24.14.0（專案內使用 `import.meta.dirname`，需 Node 20.11+） |
| **依賴** | 單一 package.json（React 18、Vite 7、TanStack Query 5、Express 5、Redis/connect-redis、Drizzle、better-sqlite3 等） |
| **Session** | Production 強制 REDIS_URL + SESSION_SECRET；Development 未設 REDIS_URL 時使用 memorystore |
| **啟動流程** | 非 production：建立 DB、可選 Redis 連線與 syncRedisToSqlite → 註冊 routes → 掛載 Vite → listen(port) |

---

## 二、可能導致「打不開／速度超慢」的原因

### 1. 後端啟動慢或卡住

- **Redis 連線**：若設了 `REDIS_URL`（例如本機或雲端 Redis），啟動時會：
  - `await redisClient.connect()`
  - `await syncRedisToSqlite(redisClient, db)`
  若 Redis 服務未開、網路慢、或連線逾時設定長，**整個 server 會卡在啟動**，瀏覽器連不上。
- **建議**：本機開發若不需要 Redis，**不要設 REDIS_URL**（或註解掉），會改用 MemoryStore，啟動較快。
- **檢查方式**：執行 `npm run dev` 後看終端是否很快出現 `serving on port 8080` 與 Vite 相關訊息；若卡在 Redis 或 DB，會一直沒有 "serving on port"。

### 2. 前端首次載入／編譯慢

- **Vite 開發模式**：第一次打開頁面或切到 Chat 頁時，Vite 要編譯該頁用到的模組（含 chat.tsx 約 2200+ 行、大量 UI 與 query），**首次會較慢**，之後有 HMR 會快很多。
- **Chat 頁**：單檔很大、依賴多（React Query、多個 useQuery、SSE、表單、訂單查詢等），**首編譯與熱更新都會偏重**。
- **建議**：第一次開或換頁時等幾秒；若持續慢，可看瀏覽器 DevTools → Network：是否卡在某支 API 或大量請求。

### 3. Chat 頁同時發送大量 API

- 進入 Chat 頁後會同時或短時間內觸發多個 **useQuery**：
  - 聯絡人列表（`/api/contacts`）— **refetchInterval: 3000**
  - 選中聯絡人後：messages、linked-orders、assignment、contact detail 等
  - 另有 auth check、available-agents（管理員）、apiTagShortcuts 等
- **refetchInterval: 3000 / 5000** 會讓聯絡人列表與訊息每 3～5 秒輪詢，**體感會變重、網路與後端負擔也大**。
- **建議**：若本機或後端慢，可暫時把 chat 頁的 `refetchInterval` 調大（例如 15000、30000）或關閉，觀察是否變順。

### 4. 本機環境

- **防毒／Windows Defender**：對 `node_modules` 或專案目錄即時掃描，可能拖慢啟動與檔案讀取。
- **磁碟與記憶體**：專案或 `node_modules` 在慢速碟、或記憶體吃緊，Node/Vite 都會變慢。
- **建議**：關閉或排除專案目錄的即時掃描；確保有足夠可用記憶體。

### 5. 資料庫與檔案

- **SQLite**：DB 檔過大或磁碟 I/O 慢，會影響所有讀寫 API。
- **uploads 目錄**：若靜態檔很多，理論上影響較小，但可確認是否在慢速碟。

---

## 三、建議立即檢查的項目

1. **終端**：執行 `npm run dev` 後，是否在 **約 10～30 秒內** 出現 `serving on port ...`？若沒有，看卡在哪一行（Redis / DB / registerRoutes 等）。
2. **環境變數**：本機是否有 `.env` 且設了 `REDIS_URL`？若有，改為不設或註解，重啟再試。
3. **瀏覽器**：開 DevTools → Network，重新整理或進入 Chat 頁，看是否有請求一直 pending 或失敗（4xx/5xx），或一次爆量請求。
4. **Node 與磁碟**：工作管理員看 Node 進程的 CPU / 記憶體；確認專案與 `node_modules` 不在網路磁碟或極慢的碟上。

---

## 四、與「變慢」相關的程式位置（供後續優化）

| 項目 | 位置 | 說明 |
|------|------|------|
| Redis 啟動與同步 | `server/index.ts`（約 94–108 行） | 有 REDIS_URL 時會 connect + syncRedisToSqlite |
| Chat 聯絡人輪詢 | `client/src/pages/chat.tsx`（約 329–333 行） | refetchInterval: 3000、refetchIntervalInBackground: true |
| Chat 訊息輪詢 | `client/src/pages/chat.tsx`（約 337–350 行） | refetchInterval: 5000 |
| 全域 Query 預設 | `client/src/lib/queryClient.ts` | staleTime: Infinity、refetchInterval: false，各頁可覆寫 |
| App 登入檢查 | `client/src/App.tsx`（約 284–289 行） | /api/auth/check，staleTime: 0（每次視為過期） |
| Vite 開發入口 | `server/vite.ts` | 開發時每請求會 transform index.html + 依賴編譯 |

---

## 五、結論與「是否正常」

- **「打不太開、速度都超慢」在以下情況算常見**：
  - 本機設了 REDIS_URL 但 Redis 沒開或很慢 → 啟動卡住。
  - 第一次開瀏覽器／第一次進 Chat 頁 → Vite 編譯 + 多支 API 同時打 → 體感慢。
  - 聯絡人／訊息每 3～5 秒輪詢 + 多個 query 同時跑 → 若後端或網路慢，整體會覺得卡。
- **建議**：先依「三、建議立即檢查的項目」逐項確認；必要時暫時關閉或拉長 refetchInterval、本機不設 REDIS_URL，再觀察是否改善。若仍慢，可再針對單一 API 或單一頁面做效能量測（例如 Network 的 Waterfall、後端日誌耗時）。
