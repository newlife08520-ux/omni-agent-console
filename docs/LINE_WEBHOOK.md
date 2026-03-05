# LINE Webhook 路徑與驗證

## Webhook URL

後端接收 LINE 訊息的**精確路由**為：

```
POST /api/webhook/line
```

完整 URL 範例（請替換成你的 Railway 網域）：

```
https://你的服務.up.railway.app/api/webhook/line
```

在 LINE Developers 後台 → 該 Channel → Messaging API 設定頁 → **Webhook URL** 填上上述網址。

---

## 後端行為摘要

1. **驗證 (Signature)**  
   - 請求標頭需帶 `x-line-signature`。  
   - 後端使用該渠道的 **Channel Secret** 對 request body 做 HMAC-SHA256，與簽名比對；不符則回傳 `403 Invalid signature`。

2. **接收訊息**  
   - 先回傳 `200 { success: true }`（2 秒內 ACK），再非同步處理 `body.events`。  
   - 依 `body.destination`（Bot 的 User ID）查找對應渠道；若有設定 Channel Access Token / Channel Secret 則用於呼叫 LINE API 與驗證。

3. **邏輯位置**  
   - 實作在 `server/routes.ts`：`app.post("/api/webhook/line", async (req, res) => { ... })`。

---

## 注意事項

- Webhook 必須為 **HTTPS**（Railway 預設即為 HTTPS）。  
- 品牌與渠道若已改存 Redis，重啟或重新部署後仍會從 Redis 同步至 SQLite，LINE 渠道設定會保留。
