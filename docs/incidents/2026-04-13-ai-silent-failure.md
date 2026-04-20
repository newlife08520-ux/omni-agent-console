# 事故紀錄：全系統 AI 靜默不回與關聯效能（2026-04-13 ～ **2026-04-20 正式結案**）

## 摘要

自 **2026-04-13** 部署後，**AI 實際上從未透過 `autoReplyWithAI` 送出回覆**，但佇列／送達紀錄層面卻顯示 **成功**（含 **`ai_reply_deliveries` 多筆 `sent`** 等**誤導性「假成功」**）。至 **2026-04-19** 經 **Phase 106.25**（佇列／loopback）與 **Phase 106.26**（SPA／Content-Type）修復後驗證通過，AI 恢復真正對客回覆。

**2026-04-20**：補登 **Bug 4**（Deep Sync 大量同步阻塞 event loop，導致 **Gemini HTTP 約 45 秒 timeout**）。經 **Phase 106.30**（暫停 Deep Sync 定時排程）、**Phase 106.32**（訂單索引寫入分批 `await` yield + 恢復 cron）與 **Phase 106.33**（移除臨時診斷程式）後，**事故與關聯議題一併結案**。本文件為事後根因與預防筆記。

---

## 事故時間軸

| 時間 | 說明 |
|------|------|
| **2026-04-13** | **Phase 106.24** 上線：AI Reply worker 改為 **主進程 in-process**，以 **HTTP loopback** 呼叫 `POST /internal/run-ai-reply`（繞過 Railway edge，直連本機 Express）。 |
| **4/13 ～ 4/19** | 現象：全系統 AI 不回、日誌矛盾（**`[Worker] sent`** 但無 **`[AI Latency] run-ai-reply start`**／**`[AI-DIAG] ENTER`**）、診斷反覆。中間修復 **BullMQ jobId／completed 殘留**、**loopback 非 2xx 必須 throw** 等。 |
| **2026-04-19** | **Phase 106.26** 確認並修復：**SPA static fallback** 攔截 **`POST /internal/run-ai-reply`**，回 **HTML 200**，導致 handler 從未執行；加上 **Content-Type** 防呆。驗證成功，**主因（Bug 1～3）結案**。 |
| **2026-04-20** | **Bug 4**：Deep Sync 大量 `upsertOrderNormalized` 長時間佔用 **單執行緒 event loop**，與 **Gemini HTTP** 競爭，出現 **約 45 秒 AI timeout**。**106.30** 暫停 Deep Sync cron 止血 → **106.32** 於 `runOrderSync` 內 **每頁／每 200 筆** `await` yield，並恢復 Deep Sync **cron**（啟動後 60 秒首次 Deep 仍停用，改 **手動** `POST /api/admin/trigger-deep-sync`）。**106.33** 移除臨時 **AI-STEP** 診斷 log、確認診斷用 admin 路由已不在程式庫。 |

---

## 症狀

- **全系統 AI 自 4/13 起未真正送出過回覆**（`autoReplyWithAI` 管線未跑通）。
- Worker／送達層仍可能顯示 **已送出**；**`ai_reply_deliveries` 出現多筆 `sent`**，屬 **未真實完成對話回覆的「假紀錄」**，與客人端無感形成強烈反差。
- 日誌：**有 `[Worker] sent`**，但 **沒有** **`[AI Latency] run-ai-reply start`**、**沒有 `[AI-DIAG] ENTER`**（後者為診斷期間所加，已於 Phase 106.28 清除）。

---

## 四個 Root Cause（Bug 1～3：靜默不回；Bug 4：結案後關聯之 AI timeout）

### Bug 1：BullMQ Job ID 碰撞

**completed／failed 等殘留** 導致 **固定 `jobId` 下 `Queue.add` 靜默 no-op**，工作看似完成、實際未進入業務邏輯。

**永久修復（Phase 106.25）**：`server/queue/ai-reply.queue.ts` 等處，跑完主動 **remove**、釋放 jobId；並避免 completed 殘留影響後續 add。

### Bug 2：Loopback `callRunAiReply` 未嚴格檢查回應

若 **`fetch('/internal/run-ai-reply')` 回非 2xx** 卻未 **throw**，worker 會 **誤判成功**、不重試。

**永久修復（Phase 106.25）**：`server/index.ts` 內 loopback：**`!res.ok` 讀 body 並 `throw`**。

### Bug 3（元凶）：SPA static fallback 攔截 `/internal/run-ai-reply` POST

**Production** 在 `server/index.ts` **先** `serveStatic(app)`，**後** `registerRoutes`（見下節 **PowerShell 佐證**）。`server/static.ts` 的 SPA fallback 原僅排除 **`/api/*`**、**`/uploads/*`**，**未排除 `/internal/*`**。

因此 **`POST /internal/run-ai-reply`** 落入 **`res.sendFile(index.html)`**，回 **HTTP 200 + `text/html`**：

- **從未進入** `routes.ts` 內的 **`/internal/run-ai-reply` handler**  
- **不會印** `[AI Latency] run-ai-reply start`  
- **`autoReplyWithAI` 從未被呼叫**（與 Bug 1／2 疊加時更難查）

**永久修復（Phase 106.26）**：

1. **`static.ts`**：`/internal` 前綴 **`next()`**，不送 SPA HTML。  
2. **`index.ts` loopback + `ai-reply.worker.ts`**：除 status 外，**`Content-Type` 須含 `application/json`**，否則 throw。

### Bug 4（2026-04-20 補登）：Deep Sync 訂單索引寫入導致 event loop 飢餓 → AI 逾時

**背景**：Deep Sync（近 45 天、多來源訂單）屬**剛需**（客人常問欠貨、約一個月前訂單），但 **`runOrderSync` 內對 `orders_normalized` 的同步 `upsert` 迴圈**在單一 tick 內可連續處理**數千筆**（例如 Shopline 先分頁拉齊再整批寫入；一頁商店每頁最多 200 筆），導致 **Node event loop 長時間無法處理其他 I/O**（含對 **Gemini** 的 HTTP），現象為 **AI 管線約 45 秒 timeout**（與 Bug 1～3 主因分開、時間點可較晚浮現）。

**Phase 106.30（臨時止血）**：`server/index.ts` **註解** Deep Sync 的 **四段 `cron.schedule`** 與相關啟動 log；**保留** `runOrderSync` 淺層 **15 分／60 分** 排程；**保留** `POST /api/admin/trigger-deep-sync` 供手動觸發。

**Phase 106.32（永久修法）**：`server/scripts/sync-orders-normalized.ts` 的 `runOrderSync`：

- **SuperLanding**：每 **頁**（最多 200 筆）寫入後 **`await` 約 200ms**，讓出 event loop。  
- **Shopline**：每實際寫入 **200 筆** **`await` 約 100ms**（因列表可能一次數千筆，無「單頁寫入邊界」可掛）。

`server/index.ts`：**恢復** 四段 Deep Sync **cron**（04:00／12:30／18:00／23:00）；**啟動後 60 秒首次 Deep Sync** 維持**註解**（避免一開機即深層同步）。

---

## 為什麼是 4/13 才爆發？

**Phase 106.24** 將 worker 從 **獨立 service** 改為 **in-process loopback**：

- **Loopback 走 `127.0.0.1`**，**不經 Railway edge／反向代理** 對 API 的正常路由規則。  
- 請求直接進 **同一 Express 實例** 的 **middleware 鏈**，**撞上「先掛 SPA、後掛 API routes」的順序 bug**（SPA 本為解決 `/assets` 與首屏；**未排除 `/internal`** 時即爆雷）。

先前若 worker 為 **獨立行程** 打 **`INTERNAL_API_URL`（對外公開網域）**，請求可能由 **edge 只轉 API** 而不經同一組 SPA fallback，故 **不易觸發同一 bug**。

---

## PowerShell 佐證：`server/index.ts` 註冊順序

執行：

`Select-String -Path server/index.ts -Pattern "serveStatic|app\.get|registerRoutes|\*" -Context 1,1`

**與根因有關的節錄**（行號依本機檔案；中文註解以可讀版重寫）：

- **約 L100–L102**：註解「production 先掛靜態…」→ **`serveStatic(app)`**  
- **約 L137**：`app.get("/api/health", …)`  
- **約 L158–L159**：`app.use("/uploads", …)` → **`await registerRoutes(httpServer, app)`**  

**結論**：**`serveStatic`（含 SPA fallback）在 `registerRoutes` 之前**；若未排除 **`/internal/*`**，則 **`POST /internal/run-ai-reply` 不會到達** API handler。

**Phase 106.26 實際 diff**（commit `711e958`，精簡）：

- `server/static.ts`：SPA middleware 增加 **`if (req.path.startsWith("/internal")) return next();`**  
- `server/index.ts`、`server/workers/ai-reply.worker.ts`：在 **`res.ok`** 後增加 **`content-type` 必須含 `application/json`**，否則 throw。

---

## 已併入主線的永久修法（清理後仍保留）

| 區域 | 說明 |
|------|------|
| **`server/queue/ai-reply.queue.ts`** | Bug 1：completed／jobId 相關修復（**保留**）。 |
| **`server/index.ts`** | Bug 2：`!res.ok` throw；Bug 3：**Content-Type JSON 檢查**（**保留**）。 |
| **`server/static.ts`** | Bug 3：**`/internal` 不進 SPA fallback**（**保留**）。 |
| **`server/workers/ai-reply.worker.ts`** | 獨立 worker 模式：**Content-Type** 檢查（**保留**）。 |
| **`server/scripts/sync-orders-normalized.ts`** | Bug 4：**Deep Sync／淺層同步**寫入索引時 **分批 `await` yield**（**保留**，Phase 106.32）。 |
| **`server/index.ts`**（訂單排程區） | Bug 4：**Deep Sync cron 已恢復**；啟動後 **60 秒自動 Deep** 仍停用，改手動 API（**保留**，Phase 106.30／106.32）。 |

---

## 預防措施

1. **`/internal/*` 與 `/api/*`**：任何 SPA **`sendFile(index.html)`** fallback，必須 **明確排除**（或改為 **先 `registerRoutes` 再 `serveStatic`**，需再評估 `/assets` 與 session 順序）。  
2. **Loopback／內部 HTTP**：除 **HTTP status** 外，**驗證 `Content-Type`**（或改為 in-process **直接 function call**，見下「未來可選」）。  
3. **觀測**：保留 **`[AI Latency]`** 等精簡 log 於正式環境，避免僅依「200 OK」判斷業務成功。

### 之後可考慮：Phase 106.27

將 loopback 由 **HTTP `fetch('/internal/run-ai-reply')`** 改為 **同 process 內直接呼叫** `runAiReply` 邏輯（或注入 handler），**徹底消除** SPA／代理／URL 誤配對 **HTTP 層**風險。

---

## 未解（待做）

| 項目 | 說明 |
|------|------|
| **補回客人** | **4/13～4/19** 期間被晾的聯絡人（例）：`4211, 4468, 22958, 27093, 27920, 30966, 31169, 31737, 32968` — 需營運／客服策略補發或標記。 |
| **私藏 LINE** | **channel token 401 reissue** — 與本事故主因分開，待追 TOKEN／渠道設定。 |

---

## Phase 106.28 清理（歷史紀錄）

以下項目已於 **Phase 106.28** 從程式庫移除（見當時 commit 說明）；**Phase 106.33** 再次確認 **主線 `server/routes` 內無** 下列路由註冊，並移除 **Phase 106.29** 的 **`[AI-STEP]`／`__diagStep`** 臨時計時 log。

- `GET /api/admin/bullmq-inspect`（106.24.1-debug）  
- `GET /api/admin/bullmq-drain-completed`（106.24.2-drain）  
- `GET /api/admin/full-diag`（106.25.3-diag）  
- `GET /api/admin/brand-enable-ai`（106.25.4）  
- **`GET /api/admin/reopen-contact`（106.25.5）**：程式庫內 **原本即無**  
- **`server/services/ai-reply.service.ts`** 內 **`[AI-DIAG]`** 日誌行（106.28）  
- **Phase 106.29**：`autoReplyWithAI` 內 **`__diagStart`／`__diagStep`／`[AI-STEP]`**（**106.33** 已刪）

**未刪**：`scripts/pack-ai-reply-diag.ps1` 等（若需一併移除可另開更動）。

---

## 文件維護

- **事故正式結束日**：**2026-04-20**（含 Bug 4 處置與 **Phase 106.33** 最終 cleanup，已併入主線 push）。
- **最後更新**：2026-04-20
