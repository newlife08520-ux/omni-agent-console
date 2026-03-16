# 看不到新訊息 — 排查步驟

綁好 Webhook 後，若 LINE / FB 傳來的訊息沒有出現在中控台，請依下列順序檢查。

---

## 1. 確認 Webhook 有收到請求（看伺服器 log）

發一則訊息到 LINE 或 FB 後，看**執行 `npm run dev` 的那個終端**或 **Railway Deploy Log**：

- **LINE**：應出現  
  `===== [LINE WEBHOOK START] =====`  
  `[WEBHOOK] destination: xxxxx`  
  `[WEBHOOK] events count: 1`
- **FB**：應出現  
  `[FB Webhook] ...` 相關 log

若完全沒有上述 log，代表 LINE/FB 沒打到你的網址，請檢查：

- Webhook URL 是否為 **https**（本機開發可用 ngrok 等）
- 網址是否與實際運行位址一致（例如 Railway 網址）

---

## 2. LINE：渠道「Bot ID」必須等於 Webhook 的 destination

LINE 送來的 body 裡有一個 **`destination`**，代表「收到訊息的 Channel」。中控台用這個值去對應「哪一個品牌／渠道」。

- 在 log 裡找到：**`[WEBHOOK] destination: xxxxx`**（或 `[WEBHOOK] Looking up bot_id: xxxxx`）
- 到 **系統設定 → 品牌 → 該品牌 → LINE 渠道 → 編輯**，把 **「Bot ID」** 設成和上面 **完全一樣** 的 `xxxxx`。
- 若 Bot ID 留空或填錯，log 會出現 **`[WEBHOOK] NO MATCH for bot_id: xxx`**，此時訊息仍會存進 DB，但聯絡人的 **品牌會是空的**，只會在左側選「**全部**」時才看得到。

**重點**：Bot ID 要填的是 **LINE 送來的 destination**，不是 User ID（U 開頭）。不確定時，以 log 裡的 `destination` 為準。

---

## 3. 左側品牌篩選

左側聯絡人列表會依**目前選的品牌**篩選：

- 若新訊息的聯絡人 **沒有對應到品牌**（例如 LINE 沒匹配到渠道，見上一段），該聯絡人只會在 **品牌選「全部」** 時出現。
- 請試著把左上角品牌切到 **「全部」**，看是否出現新聯絡人／新訊息。

---

## 4. 簽章失敗（403）會完全不寫入

若 LINE / FB 的 **Channel Secret** 或 **App Secret** 填錯，驗證簽章會失敗，伺服器回 **403**，**不會寫入任何訊息**。

- **LINE**：log 會出現 `[WEBHOOK] SIGNATURE MISMATCH` 或 `Missing signature`
- **FB**：會出現 `[FB Webhook] SIGNATURE MISMATCH` 或 `Missing signature`

請到 **系統設定 → 品牌 → 該渠道** 檢查：

- LINE：**Channel Secret** 是否與 LINE Developers 後台一致
- FB：**App Secret**（若系統有存）是否與 Meta 後台一致

---

## 5. 前端即時更新（SSE）

新訊息會經 **SSE** 推送到瀏覽器，畫面才會馬上更新。

- 打開瀏覽器 **開發者工具 → Console**，發一則訊息後應看到：  
  `[SSE] new_message received, contact: xxx`
- 若看到 **`[SSE] Connection error`** 或 **`ERR_HTTP2_PROTOCOL_ERROR /api/events`**（常見於 Railway 等 HTTP/2 代理環境），代表 SSE 沒連上；此時系統會**自動改為每 5 秒輪詢**，新訊息仍會出現，只是略慢。詳見 **`docs/RAILWAY_SSE_HTTP2.md`**。
- 亦可手動**重整頁面**重新建立 SSE 連線。

---

## 快速檢查表

| 項目 | 如何確認 |
|------|----------|
| Webhook 有收到 | 終端 / Railway log 有 LINE 或 FB webhook 的 log |
| LINE 渠道對應 | log 有 `MATCH FOUND - brand: xxx`，且 Bot ID = log 裡的 destination |
| 品牌篩選 | 左側選「全部」看是否出現該聯絡人 |
| 簽章 | 無 SIGNATURE MISMATCH、無 403 |
| 即時更新 | 瀏覽器 Console 有 `new_message received`，或等幾秒 / 重整 |

若以上都確認過仍看不到，請把 **發訊息當下** 的伺服器 log（從 `[LINE WEBHOOK START]` 或 FB 那幾行開始）貼給開發者排查。
