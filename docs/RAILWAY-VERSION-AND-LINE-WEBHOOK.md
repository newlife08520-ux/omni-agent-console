# 確認 Railway 同一版 ＋ LINE Webhook 驗證成功

## 若開 `/api/health` 出現前端 404（「Did you forget to add the page to the router?」）

代表請求**沒有打到 Node API**，而是被當成前端路由（拿到 index.html，再由 wouter 顯示 404）。請確認：

1. **Railway 跑的是「整包 Node 服務」**  
   - 在 Railway 專案裡，這個服務的 **Start Command** 應為：`npm start` 或 `node dist/index.cjs`（先 `npm run build` 再啟動）。  
   - **不要**只部署「前端靜態檔」或只用 Vite 的 preview；否則所有網址都會回傳 SPA，`/api/health` 就會變成前端 404。

2. **程式已修正**  
   - 靜態檔的 fallback 已改為**不處理 `/api/*`**，只對非 API 路徑回傳 index.html。部署最新版後，若服務確為 Node，`/api/health` 應會回 `{"ok":true}`。

3. **用指令直接測 API（避開前端）**  
   - 在終端機執行：`curl -s https://你的Railway網址/api/health`  
   - 若回 `{"ok":true}`，代表 API 正常，只是瀏覽器開同網址時曾被打到前端；若也是 404，代表該網址目前沒有對應到 Node 服務。

---

## 一、確認 Railway 是「同一版」

### 方法 1：打 API 看版本（最快）

用瀏覽器或 curl 打你正式機網址：

```text
GET https://你的Railway網址/api/health
GET https://你的Railway網址/api/version
```

- **/api/health**：若回 `{"ok":true}` 且很快（幾百 ms 內），代表服務有起來、和目前部署一致。
- **/api/version**：若 build 有寫入 version.json，會回 `buildTime`、`commit`，可和本機最後一次 deploy 的 commit 對照。

### 方法 2：看 Railway 後台

1. 登入 [Railway Dashboard](https://railway.app/dashboard) → 選你的專案 → 選這個服務。
2. 切到 **Deployments**，看最新一筆的狀態是否 **Success**、**Commit** 是否為你剛推的 commit（例如 `51f8854` 或你的 commit message）。
3. 同一版 = 最新一次 Deploy 的 commit 就是目前程式碼版本。

### 方法 3：本機 git 對照

```bash
git log -1 --oneline
```

把這行顯示的 commit（例如 `51f8854 chore(production): ...`）和 Railway 最新 Deploy 的 commit 比對，一樣就是同一版。

---

## 二、LINE Webhook 要「驗證成功」的條件

你畫面上出現 **「A timeout occurred when sending a webhook event object」** = LINE 有送測試事件到你填的網址，但**沒在時間內收到回應**，所以 LINE 那邊**不算成功**。

要讓 LINE 驗證成功，必須同時滿足：

### 1. Webhook URL 一定要正確

正確格式：

```text
https://你的Railway完整網址/api/webhook/line
```

- 路徑必須是 **`/api/webhook/line`**（全小寫、沒有多餘路徑）。
- 若填成別的（例如 `/apw/WEDHOOR/IE` 或少打字），LINE 會打到錯的 path，容易 404 或 timeout。

範例（請改成你的實際網址）：

```text
https://richbear-omnicare-hub.up.railway.app/api/webhook/line
```

在 LINE Developers → 你的 Channel → **Messaging API** 分頁 → **Webhook settings** → **Webhook URL** 檢查是否和上面一致。

### 2. Railway 服務要能「很快」回應

LINE 送驗證請求時，若你的服務：

- 還在冷啟動（剛 deploy、還沒 listen），或  
- 負載高、回應超過 LINE 的 timeout（通常幾秒），  

就會出現 timeout。所以要先確認：

- 在瀏覽器開：`https://你的Railway網址/api/health`  
  - 若 1～2 秒內就出現 `{"ok":true}`，代表目前這版有在跑、能對外回應。
- 再回 LINE 後台按 **Verify**，通常就會過。

### 3. 使用 HTTPS、且網址可從外網連

- 一定要 **https**。
- 網址要能從外網連到（Railway 預設會給可用的網址）。

---

## 三、建議操作順序

1. **確認 Railway 同一版**  
   - 看 Railway Deployments 最新一筆的 commit 是否為你預期的版本。  
   - 可順便打一次 `GET /api/health` 確認服務正常。

2. **確認 LINE Webhook URL**  
   - 改為：`https://你的Railway網址/api/webhook/line`（路徑一字不差）。  
   - 儲存。

3. **再按一次 Verify**  
   - 若仍 timeout，可過 1～2 分鐘再試（避開冷啟動），或看 Railway 的 **Deploy / Runtime Log** 是否有收到請求、是否有錯誤。

4. **驗證成功後**  
   - LINE 送來的訊息會打到 `/api/webhook/line`，中控台才會收到新訊息、最後訊息與「最後互動」才會更新。

---

## 四、總結

| 項目 | 怎麼確認 |
|------|----------|
| Railway 同一版 | Deployments 最新 commit = 本機 `git log -1`；或打 /api/health、/api/version |
| LINE 是否成功 | 不要出現 "timeout when sending webhook"；Verify 要成功 |
| Webhook URL | 必須是 `https://你的網址/api/webhook/line`，路徑不可打錯 |

目前畫面上的 timeout 就代表 LINE 還沒驗證成功；把 URL 改對、確保 Railway 有正常回應後再按 Verify，即可確認 LINE 那邊成功。
