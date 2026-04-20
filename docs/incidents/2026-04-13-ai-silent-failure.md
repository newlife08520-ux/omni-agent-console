# 事故紀錄：全系統 AI 靜默不回（2026-04-13 ～ 2026-04-19）

## 摘要

約自 **2026-04-13** 起，多品牌出現 **AI 不回覆**、前端異常、日誌上 **worker 顯示已送出** 但 **看不到 `[AI Latency] run-ai-reply start` / `[AI-DIAG] ENTER`** 等矛盾。經多階段修復與驗證，至 **2026-04-19** 確認 **AI 回覆管線恢復正常**。本文件供事後檢討與根因留存（老闆／Claude 筆記用）。

---

## 時間軸

| 日期 | 事件（摘要） |
|------|----------------|
| **2026-04-13** | 事故浮現：兩品牌情境（天鷹座 AI 異常、私藏 AI 關閉等）、全系統 AI 不回、新訊息前端難查、Bot ID 警告等。 |
| **4/13 ～ 4/18** | 排錯與多版修復：BullMQ jobId／completed 殘留、loopback HTTP 非 2xx 須拋錯、full-diag、channel／brand 資料誤讀釐清、bundle 內字串搜尋方式釐清等。 |
| **2026-04-17 ～ 18** | **Phase 106.26**：確認 **production SPA fallback** 在 **`registerRoutes` 之前** 掛載，`POST /internal/run-ai-reply` 被 **`index.html` 以 HTTP 200 回應**，in-process worker **誤判成功**，`autoReplyWithAI` **從未被呼叫**。修正 `static.ts` 排除 `/internal/*`，loopback 加上 **非 `application/json` 即 throw**。 |
| **2026-04-19** | **Phase 106.25.x 驗證成功**，AI 可正常回覆；本事故正式收尾（本報告 + 待清理臨時診斷程式碼）。 |

---

## 根因（分項）

### Bug 1：BullMQ 固定 jobId 與 completed 殘留（Job ID 碰撞／silent no-op）

**現象**：佇列在固定 jobId 下，completed 殘留導致 **`Queue.add` 靜默 no-op**，工作看似完成實際未進管線。

**處置（Phase 106.25 佇列層）**：跑完主動 **remove**、釋放 jobId；並讓非 2xx 拋錯使 job 進入 failed／retry（避免靜默吞掉）。另曾以 **106.24.2-drain** 等 admin 手段清理 Redis 殘留（臨時）。

### Bug 2：Loopback 非 2xx 被當成功（silent swallow）

**現象**：`fetch('/internal/run-ai-reply')` 回 **403／500** 等時，若上層不 **throw**，worker 仍視為成功，**不會重試**。

**處置（Phase 106.25）**：`!res.ok` 時讀 body 並 **`throw`**，讓 BullMQ 進入 failed／retry。

### Bug 3：SPA 靜態 fallback 攔截 `POST /internal/run-ai-reply`（**最終阻斷 autoReplyWithAI 的主因**）

初期曾列為「與 bundle／日誌不一致」等多種假設；經瀏覽器與日誌交叉驗證後確認：

- **Production** 在 `server/index.ts` 內 **先** `serveStatic(app)`，**後** `await registerRoutes(...)`（見下方 **PowerShell 佐證**）。
- `server/static.ts` 的 SPA fallback 僅排除 **`/api/*`**、**`/uploads/*`**，**未排除 `/internal/*`**。
- 因此 **`POST /internal/run-ai-reply`** 落入 **`res.sendFile(index.html)`**，回 **200 + `text/html`**，**不會進** `routes.ts` 內 handler → **不會印** `[AI Latency] run-ai-reply start`、**不會進** `autoReplyWithAI`、**不會印** `[AI-DIAG] ENTER`；與「worker 有印 sent、但完全沒 latency／diag」一致。

**處置（Phase 106.26）**

1. **`static.ts`**：`/internal` 前綴 **`next()`**，不送 SPA HTML。  
2. **`index.ts` loopback**：除 `!res.ok` 外，**要求 `Content-Type` 含 `application/json`**，否則 throw（防未來類似代理／錯誤頁回 200）。  
3. **`ai-reply.worker.ts`**（獨立 worker）：同上 JSON 檢查。

**為何這次終於會通（給老闆的一句話）**

- **佇列／jobId／loopback throw** 修掉「排了 job 卻假完成、或錯誤不重試」；  
- **SPA 排除 `/internal` + JSON 防呆** 修掉「**HTTP 200 但其實是登入頁／index.html**、handler 從未執行」——這是 **autoReplyWithAI 完全沒被呼叫** 的斷點。

**Redis／品牌快取**：Redis 與 `runChannelsAiReplyDefaultV1` 等仍影響 **渠道／設定快取**，可作為次要變因；但 **無 `[AI Latency] start` 且無 `[AI-DIAG] ENTER`** 的組合，與 **internal 被 HTML 吃掉** 高度吻合，**主因歸屬 Bug 3**。

---

## 已修復 Phase 摘錄（106.25 系 + 106.26）

| Phase | 內容（摘要） |
|-------|----------------|
| **106.25** | BullMQ completed／jobId、loopback 非 2xx 必須 throw、相關診斷與 full-diag 等。 |
| **106.25.3-diag** | `GET /api/admin/full-diag` 等唯讀診斷（**臨時**，待清）。 |
| **106.25.4** | `GET /api/admin/brand-enable-ai` 一次性開 AI（**臨時**，待清）。 |
| **106.26** | SPA 不攔 `/internal/*`；loopback 強制 JSON **Content-Type**。 |

---

## 預防措施（後續建議）

1. **中介層順序**：任何「回 `index.html`」的 SPA fallback，必須 **明確排除** `/api/*`、`/internal/*`、webhook 若走非 `/api` 前綴亦同。  
2. **Loopback／內部 API**：除 status 外，**驗證 `Content-Type`**（或解析 JSON），避免 **200 + HTML** 誤判。  
3. **觀測**：保留 `[AI Latency]`／關鍵 queue log 於正式環境一段時間（清理診斷後仍可保留 **精簡** latency 一行，視團隊規範）。  
4. **部署驗證**：上線後用 **腳本** `POST /internal/run-ai-reply`（正 secret）確認 **JSON body**，而非僅看 HTTP 200。

---

## 附錄：`server/index.ts` 註冊順序（PowerShell 佐證）

以下為在專案根目錄執行：

`Select-String -Path server/index.ts -Pattern "serveStatic|app\.get|registerRoutes|\*" -Context 1,1`

之重點節錄（**邏輯順序以原始檔為準**；終端機編碼可能造成中文註解顯示亂碼，此處改寫為可讀中文）：

- **約 L100–L102**：註解「production 先掛靜態…」→ **`serveStatic(app)`**  
- **約 L137–L138**：`app.get("/api/health", …)`  
- **約 L158–L159**：`app.use("/uploads", …)` → **`await registerRoutes(httpServer, app)`**  

結論：**`serveStatic`（含 SPA fallback）在 `registerRoutes` 之前**。若 SPA middleware 未排除 `/internal`，則 **`POST /internal/run-ai-reply` 不會抵達** `routes.ts` 內註冊的 handler。

---

## 待清理（**老闆綠燈後** — commit 建議：`cleanup: Phase 106.28 - remove all temporary diag/admin endpoints after incident closure`）

**尚未從程式碼刪除**；下列為搜尋結果，供單一 cleanup PR 使用。

### 臨時 admin／diag 路由（`server/routes/core.routes.ts`）

| 路由 | Phase 標記 |
|------|------------|
| `GET /api/admin/bullmq-inspect` | 106.24.1-debug |
| `GET /api/admin/bullmq-drain-completed` | 106.24.2-drain |
| `GET /api/admin/full-diag` | 106.25.3-diag |

### `server/routes.ts`

- 檔頭註解：`Phase 106.25.4 temporary`
- `GET /api/admin/brand-enable-ai` — **106.25.4 one-off**

### `Phase 106.25.5`

- 程式庫內 **無** `106.25.5` 字樣（若曾於分支／未合併，請自行補列）。

### `[AI-DIAG]` console（`server/services/ai-reply.service.ts`）

- `ENTER`、多處 `RETURN reason=…`、`FINISH reason=normal_complete` 等（**full-diag** 內 `bundle_check` 曾 grep 此字串；清理時一併刪除或改為 debug flag）。

### 打包／CONTEXT 腳本（可選是否保留）

- `scripts/pack-ai-reply-diag.ps1`
- `scripts/ai-reply-diag-CONTEXT.template.md`  

若僅供事故期間交 ChatGPT 診斷，可於 106.28 一併刪除或改存 `docs/` 純文件。

---

## 文件維護

- **建立**：2026-04-19  
- **狀態**：事故已結案；**診斷程式碼清理**待老闆核准後執行 Phase 106.28 commit。
