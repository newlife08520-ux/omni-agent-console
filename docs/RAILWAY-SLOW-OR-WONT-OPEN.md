# Railway 打不開／很慢 — 原因與排查

## 可能原因簡表

| 現象 | 可能原因 | 建議動作 |
|------|----------|----------|
| 一直轉圈、最後逾時 | 服務還沒開始 listen，卡在啟動階段 | 看 Deploy Log：是否卡在 Redis 連線或 DB migration |
| 偶爾能開、多半打不開 | Volume 快滿（例如 94%）導致 I/O 極慢或崩潰 | 升級 Volume、清理 DB/uploads，見 [VOLUME-USAGE-AND-SLOWNESS.md](./VOLUME-USAGE-AND-SLOWNESS.md) |
| 開機後前 30 秒～1 分鐘很難開 | 冷啟動：Redis 連線 + DB 同步完成後才 listen；或 30 秒後銷售頁同步開始 | 確認 Redis 同區、健康檢查用 `/api/health`、必要時調高 Railway 啟動逾時 |
| 首頁載入很慢、但最終有畫面 | 首筆請求被銷售頁同步（133 次請求）或 DB 查詢拖慢 | 已延後開機同步 30 秒；若仍慢可看 Deploy Log 與 [WHY-APP-SLOW-OR-WONT-OPEN.md](./WHY-APP-SLOW-OR-WONT-OPEN.md) |
| 健康檢查失敗、一直被重啟 | 用了需登入的 `/api/health/status`（回 401）或逾時 | 健康檢查路徑改為 **`/api/health`**（不需登入、立刻 200） |

---

## 1. 啟動順序（為什麼會「打不開」）

服務要**依序完成**以下步驟才會開始對外回應：

1. 讀取 `DATA_DIR`、連線 **Redis**（`REDIS_URL`）
2. 執行 **syncRedisToSqlite**（品牌/渠道從 Redis 同步到 SQLite）
3. 註冊 session、路由、靜態檔
4. **listen(port)** → 之後才會出現 log `serving on port ...`

若卡在 1 或 2（例如 Redis 連線慢、Volume I/O 極慢），在 `listen()` 之前**不會回應任何 HTTP**，瀏覽器或 Railway 健康檢查就會一直等、逾時，體感就是「打不開」。

---

## 2. 建議排查步驟

### 2.1 看 Railway Deploy Log

- 是否有 `serving on port xxxx`？  
  - **沒有**：代表卡在 Redis 或 DB，檢查 Redis 連線時間、是否同區、Volume 是否滿或權限錯誤。  
  - **有**：代表有 listen，問題多半是健康檢查路徑、逾時，或首筆請求被重邏輯拖慢。

### 2.2 健康檢查路徑設成 `/api/health`

- 本專案已提供 **`GET /api/health`**：不需登入、不查 DB、不打外站，立刻回 `{ "ok": true }`。
- 在 Railway 的 **Settings → Health Check**（或 Deploy 設定）中：
  - **Path** 設為：`/api/health`
  - **Timeout** 可設 10–30 秒（視你 Redis/Volume 冷啟動時間而定）

若目前是用 `/api/health/status`，該路徑需要登入（authMiddleware），會回 401，Railway 可能判定不健康而重啟或顯示異常。

### 2.3 確認 Volume 與 Redis

- **Volume**：若使用率已很高（例如 94%），請先升級 Volume 並視需要清理，見 [VOLUME-USAGE-AND-SLOWNESS.md](./VOLUME-USAGE-AND-SLOWNESS.md)。
- **Redis**：若 Redis 在別區或連線慢，會拖長「從啟動到 listen」的時間，容易超過平台預設啟動逾時；盡量使用同區 Redis，或調高 Railway 的 startup timeout。

### 2.4 冷啟動與全新 DB

- 若 Volume 是全新的（沒有既有 `omnichannel.db`），會跑完整 migration；若 migration 有錯會 crash，見 [RAILWAY_COLDSTART_FIX_REPORT.md](./RAILWAY_COLDSTART_FIX_REPORT.md)。
- 開機後約 30 秒會開始背景執行銷售頁同步（133 次請求），已不會擋住 listen，但若機器資源很緊，那段時間整體仍可能偏慢。

---

## 3. 總結

- **打不開**：多數是「還沒 listen」（卡 Redis/DB）或「健康檢查用錯路徑/逾時」。
- **很慢**：常見是 Volume 快滿、或首筆請求剛好碰上銷售頁同步。
- **立刻可做的**：Deploy Log 確認是否有 `serving on port`、健康檢查改為 **`/api/health`**、確認 Volume 與 Redis 狀態。
