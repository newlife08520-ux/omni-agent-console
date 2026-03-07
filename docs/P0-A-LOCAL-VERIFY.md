# P0-A 本地驗收：如何跑 PR 分支並驗證

**說明**：Production 尚未部署 P0-A，無法用 production 驗收。請在本地跑 **PR 分支** `p0-a-comment-center-routes` 後再驗收。

**實測**：本 branch 在本地執行 `npm run dev` 可正常啟動，服務於 http://localhost:8080（或您設定的 `PORT`）。

---

## 一、在本地跑出 PR 分支版本（最短步驟）

### 1. 切到 PR 分支並確認

```bash
cd <repo 根目錄>
git fetch origin
git checkout p0-a-comment-center-routes
git pull origin p0-a-comment-center-routes
git status
```

預期：`On branch p0-a-comment-center-routes`，`nothing to commit, working tree clean`（或僅預期之變更）。

### 2. 安裝依賴（若尚未安裝）

```bash
npm install
```

### 3. 啟動開發伺服器

```bash
npm run dev
```

預期：終端出現類似 `serving on port 8080`（或 `PORT` 環境變數指定的 port）。若未設 `PORT`，預設為 **8080**。

### 4. 用瀏覽器驗收

- 打開：**http://localhost:8080**（若 port 不同則改數字）。
- 登入後依 `docs/P0-A-MANUAL-ACCEPTANCE.md` 的「人工驗收最短步驟」操作。

---

## 二、環境變數（若啟動失敗）

開發模式通常會 fallback，但若需要可設：

- `PORT`：伺服器 port，預設 8080。
- `SESSION_SECRET`：development 可留空或隨意字串。
- `REDIS_URL`：production 必填；development 若未設可能用 memory store，視專案設定而定。

若有 `.env.example`，可複製為 `.env` 後依本地環境調整。

---

## 三、驗收完成後

請在 PR 中補上：
1. 人工驗收結果（可貼 `docs/P0-A-MANUAL-ACCEPTANCE.md` 末段的「可直接貼進 PR comment 的驗收段落」並打勾）。
2. 四頁路徑截圖或短片（`/comment-center/inbox`、`/rules`、`/channel-binding`、`/simulate`；可選 hash 導轉示範）。

**在您補完截圖／短片與人工驗收前，不會進行 P0-B，也不會建議 merge。**
