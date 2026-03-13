# LINE Webhook「無匹配渠道」排錯說明

## 日誌現象

- `[WEBHOOK] NO MATCH for bot_id: Uxxxxxxxx...`
- `[WEBHOOK] 無匹配渠道 Token，後續 Profile/Media/Reply 將不使用全域 Token（fail-closed）`
- `[WEBHOOK] Token 防呆：access_token 為空或未定義，跳過 Get Profile 請求`
- `[WEBHOOK] 無匹配 channel，跳過文字自動回覆（fail-closed）`

## 原因說明

LINE 發送 Webhook 時會在請求 body 裡帶 **`destination`**（該官方帳號的 **Bot 使用者 ID**，通常為 `U` 開頭）。  
系統用這個值去資料庫查「渠道」的 **Bot ID**：

- **有對應到渠道** → 會用該渠道的 Channel Access Token 回覆、拉頭像等，一切正常。
- **沒有對應** → `matchedChannel` 為空，沒有 `access_token`，所以：
  - 無法呼叫 LINE API（Get Profile、回覆訊息）
  - 會跳過文字／圖片自動回覆（fail-closed）
  - 客人發的訊息仍會存進後台，但**不會有 AI 回覆**

因此「收不到訊息」多半是：**客人有發、系統有收，但因為找不到渠道而無法回覆**。

## 解決步驟

1. **看日誌裡的 bot_id**  
   日誌會印：`[WEBHOOK] Looking up bot_id: U29700b9390fBe0fe5ee67dccda7edbc0`（實際以你看到的為準）。  
   記下這個 **destination（Bot 使用者 ID）**。

2. **到後台設定渠道**  
   - 登入 Omni-Agent-Console  
   - 進入 **品牌管理** → 選擇對應品牌 → **渠道管理**  
   - 若已有該 LINE 官方帳號的渠道：**編輯**；若沒有：**新增 LINE 渠道**

3. **對齊 Bot ID**  
   - 在渠道設定中，**Bot ID** 欄位必須填成與日誌中 **完全一致** 的 `destination`（例如 `U29700b9390fBe0fe5ee67dccda7edbc0`）。  
   - 可到 [LINE Developers Console](https://developers.line.biz/console/) → 該 Provider / Channel → **Basic settings** 頁，在 **Bot information** 裡可看到 **User ID**，即為 Webhook 的 `destination`。

4. **填寫 Channel Secret 與 Access Token**  
   - **Channel Secret**：LINE Developers 同一個 Channel 的 **Basic settings** 裡。  
   - **Channel Access Token**：**Messaging API** 頁籤中，發行 **長期** Token 並貼到後台「Access Token」欄位。  
   - 儲存後，之後進來的 Webhook 就會被辨識為該渠道，並用這個 Token 回覆。

5. **確認 AI 已開啟**  
   該 LINE 渠道的「啟用 AI」要勾選，否則即使匹配到渠道也不會自動回覆。

## 檢查清單

| 項目 | 說明 |
|------|------|
| Webhook URL | LINE Developers 中 Messaging API 的 Webhook URL 要指到你這台主機的 `/api/webhook/line`，且可從外網連到。 |
| Bot ID 一致 | 後台渠道的 Bot ID = Webhook 請求 body 的 `destination`（區分大小寫）。 |
| Channel Secret | 與 LINE Developers 該 Channel 的 Secret 一致，否則簽章驗證會 403。 |
| Access Token | 已發行長期 Token 並貼到後台，未過期。 |
| 啟用 AI | 該渠道「啟用 AI」已勾選。 |

完成後重新讓客人發一則訊息，日誌應出現 `[WEBHOOK] MATCH FOUND`，且會正常回覆。
