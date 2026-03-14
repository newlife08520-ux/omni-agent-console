# LINE 渠道 Token 串接說明（紅字 LOG 排除）

當 log 出現以下紅字時，代表 **LINE 渠道的 API 串接**尚未正確設定，不是轉人工關鍵字的問題：

- `[WEBHOOK] NO MATCH for bot_id: xxxxx`
- `[WEBHOOK] 無匹配渠道 Token，後續 Profile/Media/Reply 將不使用全域 Token（fail-closed）`
- `[WEBHOOK] Token 防呆：access_token 為空或未定義，跳過 Get Profile 請求`
- `[WEBHOOK] Token available: false Secret available: false`

---

## 原因說明

1. LINE 發送 webhook 時會帶 **`destination`**（即你的 LINE 機器人的 **Bot User ID**，多為 U 開頭 33 碼；**不是** Basic settings 的數字 Channel ID）。
2. 系統用這個 `destination` 去後台「渠道」裡找 **bot_id 相同**的那一筆 LINE 渠道。
3. 若**找不到**（NO MATCH for bot_id）→ 就沒有該渠道的 **access_token** 與 **channel_secret** → 無法呼叫 LINE API（取得頭貼、回覆、下載圖片等）→ 出現上述紅字。

所以「後台儲存」若只改了「系統設定」或「轉人工關鍵字」，**不會**解決這些錯誤；必須把 **LINE 渠道** 建好並填對 Token。

---

## 正確設定步驟

### 1. 取得 LINE 後台的數值

到 [LINE Developers Console](https://developers.line.biz/console/)：

- 選你的 **Provider** → 選 **Channel**（Messaging API 類型）。
- 在 **Basic settings** 頁籤可看到數字 **Channel ID**（10 碼）；但 Webhook 傳來的 **destination** 是 **Bot 的 User ID**（U 開頭 33 碼）。請以「日誌中 `[WEBHOOK] destination:` 印出的值」或下方「驗證 LINE」回傳的 **userId** 為準，填到中控台該渠道的 **bot_id**，勿與數字 Channel ID 混淆。
- 在 **Messaging API** 頁籤：
  - **Channel secret**：複製起來，填到中控台該渠道的 **channel_secret**。
  - **Channel access token**：可發行 Long-lived token，複製起來，填到中控台該渠道的 **access_token**。

### 2. 在中控台建立／編輯 LINE 渠道

1. 登入 **Omni-Agent-Console** 後台。
2. 進入 **渠道**（Channels）或 **品牌 → 渠道**。
3. **新增**一筆 LINE 渠道，或點選**既有的 LINE 渠道**編輯。
4. 填寫：
   - **bot_id**：貼上剛才複製的 **Channel ID**（必須與 log 裡 `NO MATCH for bot_id:` 後面的值**完全一致**；若 log 顯示 `U200f74dd5552b52f720fb81dd4b5b849`，這裡就填這個）。
   - **access_token**：貼上 LINE 的 **Channel access token**（Long-lived）。
   - **channel_secret**：貼上 LINE 的 **Channel secret**。
5. **儲存**。

### 3. 確認 Webhook URL

在 LINE Developers 的 **Messaging API** 頁籤：

- **Webhook URL** 設為：`https://你的網域/api/webhook/line`
- **Use webhook** 要開啟。

---

## 如何對照 log 的 bot_id

- log 會印：`[WEBHOOK] Looking up bot_id: xxxxx` 或 `[WEBHOOK] NO MATCH for bot_id: xxxxx`。
- 那個 **xxxxx** 就是 LINE 傳來的 `destination`。
- 請在後台該 LINE 渠道的 **bot_id** 欄位**一字不差**填上這個 xxxxx，並填好 **access_token**、**channel_secret**，儲存後再發一則訊息測試；若配對成功，會出現 `[WEBHOOK] MATCH FOUND - brand: ... channel: ...`，紅字就不會再因 Token 而出現。

---

## 若有多個 LINE 機器人

每個機器人（Channel）都有各自的 Channel ID、token、secret。請在後台為**每個**機器人各建一筆 LINE 渠道，並把對應的 **bot_id / access_token / channel_secret** 填進該筆渠道，這樣不同 `destination` 進來時才會各自匹配到正確的 Token。
