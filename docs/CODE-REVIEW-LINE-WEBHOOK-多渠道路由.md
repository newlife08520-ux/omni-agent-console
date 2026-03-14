# LINE Webhook 多渠道路由邏輯 — 深度 Code Review 報告

## 摘要

本報告針對共用端點 `/api/webhook/line` 的身分比對、Token 取用、簽名驗證與非同步傳遞進行檢查，並列出發現的邏輯漏洞與建議修復。

---

## 1. 身分比對邏輯 (Destination vs Bot ID)

### 1.1 目前實作

- **Webhook Controller**（`routes.ts`）使用 **`req.body.destination`** 進行渠道匹配，**沒有**使用 `events[0].source.userId`（那是「發訊用戶」的 ID，不是機器人本身）。
- 匹配呼叫：`matchedChannel = storage.getChannelByBotId(destinationTrimmed || destination);`
- **結論：** 使用 `destination` 是正確的；`destination` 為 LINE 官方帳號（Bot）的 User ID，與「哪個機器人收到這則 webhook」一致。

### 1.2 資料庫 `bot_id` 欄位語義

- **設計意圖：** 程式碼以 `destination` 與 DB 的 `bot_id` 比對，且 `storage.getChannelByBotId` 內有「U 前綴有無」的雙向 fallback（`raw` / `alt`），因此 **`bot_id` 應存放的是「Webhook 的 destination」**，即 LINE 傳來的 Bot User ID（多為 U 開頭 33 碼），**不是** LINE Developers 後台 Basic settings 的 10 碼數字 Channel ID。
- **潛在衝突：** 文件 `docs/LINE-渠道-Token-串接說明.md` 寫「Channel ID：複製起來，這就是 webhook 裡的 destination」。在 LINE 官方文件中，Basic settings 的 **Channel ID** 多為數字，而 webhook 的 **destination** 實際為 Bot 的 User ID（常為 U 開頭）。若後台依文件填的是「10 碼 Channel ID」，會導致 **NO MATCH**（因為 LINE 送的是 U 開頭 destination）。
- **建議：**
  - 在程式或 DB 註解中明確定義：**`bot_id` = Webhook 請求體中的 `destination`（Bot 的 User ID，通常 U 開頭 33 碼）**。
  - 更新 `LINE-渠道-Token-串接說明.md`：說明「bot_id 請填寫 **Webhook 日誌中出現的 destination**（或從「驗證 LINE」按鈕取得之 userId），勿與 Basic settings 的數字 Channel ID 混淆」。

### 1.3 Redis 與 SQLite 雙寫下的讀取來源

- **現況：** `storage.getChannelByBotId` 與 `storage.getChannels()` **僅從 SQLite 讀取**；Redis 的 `redis-brands-channels.getChannelByBotId` **未被 Webhook 使用**。
- **影響：** Webhook 路由邏輯與 SQLite 一致；若未來改為從 Redis 讀渠道，需注意 Redis 版的 `getChannelByBotId` 目前是 **嚴格相等**（`c.bot_id === botId`），沒有 TRIM 與 U 前綴 fallback，需與 SQLite 版行為對齊。

---

## 2. Redis 快取與狀態污染

### 2.1 結論：**無 request 間互相污染**

- `channelToken`、`channelSecretVal`、`matchedChannel`、`matchedBrandId` 均在 **單一 request 的 handler 內以 `let`/`const` 宣告**，每個請求有獨立閉包，不會被其他請求覆蓋。
- 非同步事件處理使用同一請求的 `channelToken` / `matchedChannel`，屬於「同一請求內多 event 共用同一渠道」的預期行為。

### 2.2 Redis 的角色

- Redis 在 `redis-brands-channels.ts` 中用於 **品牌／渠道的持久化**（如 Railway 無狀態環境），**不是**用來快取「當前請求的 access_token」。
- 渠道的讀取在 Webhook 路徑上僅經由 `storage.getChannelByBotId` → SQLite，**沒有**「先寫 Redis 再被其他請求當成自己的 token」的競態。

### 2.3 建議

- 維持「每個 request 僅使用自己解析出的 `matchedChannel` / `channelToken`」的設計；若日後在 Webhook 路徑引入「依 channel_id 從 Redis 讀 token」的短 TTL 快取，需用 **channel_id（或 destination）為 key**，避免多渠道路由錯用。

---

## 3. Global Channel Secret 退避機制 (Fallback) 的盲區

### 3.1 目前邏輯

```ts
// 若匹配到的渠道沒有 channel_secret，才用全域
if (!channelSecretVal) {
  channelSecretVal = storage.getSetting("line_channel_secret");
  console.log("[WEBHOOK] Using global channel_secret, exists:", !!channelSecretVal);
}
```

- **情境 A：** 有 destination、且 **MATCH FOUND** → 使用該渠道的 `channel_secret` 驗簽 → 正確。
- **情境 B：** 有 destination、但 **NO MATCH** → `channelSecretVal` 仍為空，接著被設成 **global** → 用 **全域** channel_secret 驗簽。
- **問題：** 多品牌時，該請求實際來自某個 LINE 機器人 A，但系統不知道 A 是誰（NO MATCH）。此時用「任一」或「預設」的 secret 驗簽都不合理：
  - 若 global 是機器人 B 的 secret → 驗簽會失敗（403）。
  - 若環境僅一個機器人且剛好設成 global → 可能誤通過，但渠道仍 NO MATCH，後續 Token 為空、fail-closed，行為不直觀且日誌會出現「Using global channel_secret, exists: false」等混亂訊息。

### 3.2 設計缺陷

- **NO MATCH 時不應使用 global channel_secret 驗簽**：因為無法得知此 webhook 來自哪個機器人，用 global 驗簽會造成「錯誤通過」或「錯誤拒絕」，且與「每個渠道各自驗簽」的多租戶原則不一致。
- 日誌「無匹配渠道 token，後續將不使用全域 Token (fail-closed)」是正確的 policy，但 **channel_secret 的 fallback 應與此一致**：無匹配渠道時，**不要**用 global secret 驗簽。

### 3.3 建議修復

- **僅在「已匹配到渠道、但該渠道未填 channel_secret」時**，才考慮使用 global channel_secret（若產品上允許單一機器人用全域設定）。
- **若 NO MATCH（無 matchedChannel）**：不要將 `channelSecretVal` 設為 global；可選擇：
  - **選項 A（建議）：** 不驗簽、直接回 200 並記錄 alert，且不處理 events（或僅記錄日誌），避免誤用其他機器人的 secret。
  - **選項 B：** 維持不驗簽但回 200，並在日誌明確寫「NO MATCH，跳過簽名驗證，不處理 events」。
- 實作上建議：**僅在 `matchedChannel` 存在時才做簽名驗證**；若 `matchedChannel` 不存在，則 `channelSecretVal` 保持為空、不 fallback 到 global，並跳過驗證或直接拒絕（見下方修復程式碼）。

---

## 4. Token 防呆機制的觸發時機與非同步傳遞

### 4.1 觸發時機

- 「Token 防呆：access_token 為空或未定義，跳過 Get Profile 請求」發生在 **MATCH FOUND 之後**：`fetchAndUpdateLineProfile(userId, contact.id, channelToken, matchedChannel?.id)` 被呼叫時，若 `channelToken` 為空即觸發。
- **合理原因：** 匹配到的渠道在 DB 中 **未填 access_token**（或為空字串），因此 `channelToken = matchedChannel.access_token || null` 為 null。

### 4.2 是否有非同步導致 Token 遺失？

- **結論：無。** `channelToken` 與 `matchedChannel` 在該次請求的閉包中為常數，不會在非同步流程中被覆寫。
- **debounceTextMessage** 的 callback 會捕獲當次請求的 `channelToken`，延遲執行時仍使用同一請求的 token，不會被其他請求覆蓋。
- **downloadLineContent**、**pushLineMessage**、**replyToLine** 等皆以參數傳入 `channelToken`，沒有在內部再從「全域或 storage 依別 key 取 token」而拿錯的狀況。

### 4.3 建議

- 若希望減少「MATCH FOUND 卻 token 為空」的狀況，可在 **後台儲存渠道時** 強制檢查：platform 為 LINE 時，若未填 access_token 則提示或阻擋儲存；並在 Webhook 日誌中，當 MATCH FOUND 但 token 為空時，明確寫出「渠道 channel_id=xxx 未填 access_token」。

---

## 5. 修復方案總覽

| 項目 | 建議 |
|------|------|
| **身分比對** | 維持以 `destination` 匹配；統一文件與註解：`bot_id` = Webhook 的 destination（Bot User ID，常 U 開頭），並修正 LINE-渠道-Token-串接說明.md。 |
| **Redis/狀態** | 無需改動；保持「每 request 獨立變數」；若未來從 Redis 讀渠道，需為 getChannelByBotId 加上 TRIM + U 前綴 fallback。 |
| **Global secret fallback** | NO MATCH 時不要用 global channel_secret；僅在 matchedChannel 存在時才做簽名驗證；若 matchedChannel 不存在則不 fallback、不驗簽並記錄 alert。 |
| **Token 防呆** | 維持現有防呆與閉包傳遞；可加強後台必填與日誌（channel_id 未填 token）。 |

---

## 6. 具體程式碼修改建議（節錄）

以下為建議的程式碼變更要點（實作見倉庫內對應 patch）。

### 6.1 Webhook：僅在匹配到渠道時才用該渠道 secret；NO MATCH 時不用 global 驗簽

- 在 `app.post("/api/webhook/line", ...)` 中：
  - 若 `matchedChannel` 存在但 `channelSecretVal` 為空，再考慮 `channelSecretVal = storage.getSetting("line_channel_secret")`（可選，依產品是否允許「單一渠道用全域 secret」）。
  - 若 `matchedChannel` **不存在**，則**不要**設定 `channelSecretVal = global`；保持 `channelSecretVal` 為 null，並跳過簽名驗證（或改為回 403），同時記錄 system alert。

### 6.2 文件與註解

- **shared/schema.ts** 或 DB 註解：`bot_id`：LINE 為 Webhook 請求體中的 `destination`（Bot User ID，通常 U 開頭 33 碼），用於多渠道路由匹配；非 LINE Developers 後台的數字 Channel ID。
- **LINE-渠道-Token-串接說明.md**：將「Channel ID」改為「Webhook 的 destination（日誌中的 destination，或透過「驗證 LINE」取得的 userId）」，並註明勿與 Basic settings 的數字 Channel ID 混淆。

### 6.3 Redis getChannelByBotId 行為對齊（若未來 Webhook 改走 Redis）

- 在 `redis-brands-channels.ts` 的 `getChannelByBotId` 中，對 `botId` 做 TRIM，並仿照 storage 做「有無 U 前綴」的雙向查詢，與 SQLite 行為一致。

---

*本報告對應程式庫：Omni-Agent-Console，Webhook 端點：`/api/webhook/line`。*
