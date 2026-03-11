# 線上打不開 — 從頭到尾驗證清單

你的網址：**https://richbear-omnicare-hub.up.railway.app**

---

## 已確認：後端有在跑

- **GET** `https://richbear-omnicare-hub.up.railway.app/api/health` 回傳 **`{"ok":true}`**
- 代表 **Node 服務有啟動**，API 對外正常，不是「整站掛掉」。

所以問題多半是：**首頁（/）打不開** 或 **開了白屏／卡住**，而不是 API 完全連不到。

---

## 一、請先開「首頁」網址（不要只開 /api/health）

要開的是**根路徑**，不是 /api/health：

```text
https://richbear-omnicare-hub.up.railway.app/
```

注意：

- 結尾的 **/** 可有可無（多數會自動導向）
- 一定要 **https**，不要用 http
- 網址不要打錯（richbear-**omnicare**-hub，不是 nchbear 或 omnic**a**le）

---

## 二、依你看到的情況對照處理

### 情況 A：首頁一片白、或一直轉圈

1. **強制重整＋清快取**  
   - Windows：**Ctrl + Shift + R** 或 **Ctrl + F5**  
   - 或 F12 → 右鍵重新整理鈕 → **清除快取並強制重新載入**

2. **開無痕視窗再開一次**  
   - 避免舊快取、擴充功能干擾  
   - 無痕開：`https://richbear-omnicare-hub.up.railway.app/`

3. **看瀏覽器 Console 有沒有紅字錯誤**  
   - 按 **F12** → 分頁 **Console**  
   - 若有 **Failed to load resource**、**net::ERR_**、**CORS**、**404**（尤其是 /assets/ 開頭的 JS/CSS），記下來  
   - 常見：舊版快取載到錯的 JS 路徑 → 清快取後再開

4. **換瀏覽器或裝置試一次**  
   - 排除單一瀏覽器／網路環境問題

### 情況 B：首頁顯示 404 或「Page Not Found」

- 代表伺服器**沒有回傳 index.html**（靜態檔或路徑有問題）。
- 程式已加「明確處理 GET /」；請確認 **Railway 已部署最新版**（有包含 `server/static.ts` 的修改）。
- 在 Railway 後台確認：**Build 指令** 為 `npm run build`（會產出 `dist/public`），**Start 指令** 為 `npm start` 或 `node dist/index.cjs`。

### 情況 C：首頁有出來，但登入後白屏或卡住

- 按 **F12 → Console** 看是否有 **API 錯誤**（401、404、500）或 **SSE / EventSource** 錯誤。
- 若有黃色橫幅「即時更新已中斷」，按 **重新整理頁面** 再試。

### 情況 D：公司網路 / 學校網路 / VPN

- 部分環境會擋 **railway.app** 或 **up.railway.app**。
- 改用手機 4G/5G 或家裡網路開同一個網址，確認是否可開。

---

## 三、Railway 後台自檢（若首頁 404 或一直異常）

在 Railway 專案 → 選這個服務：

| 項目 | 建議設定 |
|------|----------|
| **Build Command** | `npm run build`（會建 client + server，產出 `dist/public` 與 `dist/index.cjs`） |
| **Start Command** | `npm start` 或 `node dist/index.cjs` |
| **Root Directory** | 專案根目錄（有 package.json 的那一層） |
| **環境變數** | production 需有 `NODE_ENV=production`、`SESSION_SECRET`、`REDIS_URL` 等（依你的設定） |

部署完成後，在 **Deployments** 看最新一筆是否 **Success**；若有錯誤，點進去看 **Build Log** 與 **Deploy Log**，確認有沒有 `Could not find the build directory` 或 找不到 `dist/public`。

---

## 四、快速檢查順序（從頭到尾）

1. 確認開的是 **首頁**：`https://richbear-omnicare-hub.up.railway.app/`
2. **Ctrl + Shift + R** 強制重整（清快取）
3. 仍不行 → **無痕視窗** 開同網址
4. 仍不行 → **F12 → Console** 看錯誤訊息（紅字）
5. 仍不行 → 換瀏覽器或網路（例如手機 4G）
6. 若首頁 404 → 到 **Railway** 確認 Build/Start、並確認已部署含「明確 GET /」的版本

---

## 五、總結

- **/api/health 回傳 {"ok":true}** ＝ 後端正常，請以**首頁**為準排查。
- 多數「打不開」是：**快取**、**開錯網址**、**首頁/靜態沒正確回傳**；照上面順序做一輪，通常可定位問題。
- 若你已照做仍打不開，請提供：**你開的完整網址**、**畫面上看到的（白屏／404／錯誤字樣）**、**F12 Console 一兩行紅字**，方便進一步排查。
