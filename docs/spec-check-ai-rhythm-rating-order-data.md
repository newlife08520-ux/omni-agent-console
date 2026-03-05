# Spec-Check：AI 回覆節奏 / 評價卡 / 訂單回跳 / 資料保存

以下為**先閱讀需求後之現況盤點與風險檢查**，未動手改程式前的結論與設計方向。

---

## 一、目前系統是否已有相關機制

### A. AI 是否會在客人還沒打完字時就搶著回覆

| 項目 | 現況 | 說明 |
|------|------|------|
| 觸發方式 | **收到單筆訊息即進入處理流程** | LINE/FB webhook 收到 `message` 後，先 `createMessage` 存 DB，再呼叫 `debounceTextMessage(contactId, text, callback)`。 |
| Debounce | **已有** | `server/routes.ts` 第 318–345 行：`messageDebounceBuffers` Map、`DEBOUNCE_MS = 3000`。同一 `contactId` 短時間多則會合併成一行（`\n` join），只觸發一次 `processCallback(mergedText)`。 |
| 重新計時 | **已有** | 若 buffer 已存在，會 `clearTimeout(existing.timer)` 再設新 `setTimeout(..., DEBOUNCE_MS)`，等同「最後一則後再等 3 秒」。 |
| 可設定 | **無** | `DEBOUNCE_MS` 為常數 3000，未從 settings 或環境變數讀取。 |
| 人工／靜音保護 | **已有** | `autoReplyWithAI` 內會再取一次 contact，若 `needs_human`、`isAiMuted`、`status === "awaiting_human"` 或 `high_risk` 則不回覆。debounce callback 外層有 `withContactLock(contactId, fn)` 避免同 contact 並行。 |

**結論**：已有「同一使用者短時間多則合併、最後一則後等 3 秒再回」的機制，但秒數寫死、後台無可視化。

---

### B. 對話完成後，評價卡片應該多久沒回才發

| 項目 | 現況 | 說明 |
|------|------|------|
| 觸發時機 | **僅在「後台把案件狀態改為 resolved/closed」時** | `PUT /api/contacts/:id/status` 當 `status === "resolved" \|\| "closed"` 時，立刻發送真人或 AI 滿意度卡片（`sendRatingFlexMessage`）。 |
| 延遲發送 | **無** | 沒有「X 小時內客人未再回覆才發」的邏輯，也沒有排程／cron。 |
| 最後一則誰發 | **未檢查** | 未判斷最後一則是否為客服/AI；實務上通常是客服按「結案」才改 status，故多為客服已回完。 |
| 同一對話只發一次 | **有** | 依 `cs_rating == null` / `ai_rating == null` 決定是否發，發過會寫入 rating，不會重複發。 |
| 爭議／導流 LINE／不發 | **未區分** | 沒有「已導流 LINE／爭議中／未解決則不發評價卡」的欄位或判斷。 |
| 可設定 | **無** | 沒有 `satisfaction_card_delay_hours`、`satisfaction_card_enabled`。 |

**結論**：評價卡是「結案當下立即發」，沒有延遲與條件過濾，需新增延遲與可設定開關／時數。

---

### C. 一頁式訂單查詢，要能從訂單／備註跳回對話

| 項目 | 現況 | 說明 |
|------|------|------|
| 訂單來源 | **僅外部 API，無本地訂單表** | 一頁商店用 SuperLanding API（`fetchOrders`, `lookupOrderById` 等），OrderInfo 含 `global_order_id`, `buyer_phone`, `buyer_email`, `buyer_name` 等，不寫入本機 DB。 |
| 對話／聯絡人 | **contacts 表** | 有 `id`, `platform`, `platform_user_id`（LINE userId / FB psid）, `display_name`，**沒有** `phone`、`email`、`order_id` 欄位。 |
| 關聯 | **無直接欄位** | 無法用「訂單編號」或「訂單備註」直接查到 contact_id；也無法在訂單詳情頁顯示「此訂單對應的對話」。 |
| 現有 API | **有** | `GET /api/orders/lookup?q=訂單編號` 可查單筆訂單；`GET /api/contacts/:id/orders` 是「依 contact 查訂單」但實作是直接 `fetchOrders` 全量，未依 contact 篩選；沒有「依訂單編號／電話／email 查 contact」的 API。 |

**結論**：目前**無法**從訂單備註或訂單詳情一鍵跳回「該客戶的對話」，需補關聯方式與 API／UI。

---

### D. 聊天／修改／任務紀錄保存位置與期限

| 資料類型 | 保存位置 | 實際路徑／表 | 重啟後 | 換機／重建 container |
|----------|----------|--------------|--------|----------------------|
| 顧客對話、AI 回覆、分派、標籤、評價、訂單關聯 | **SQLite** | `process.cwd()/omnichannel.db`（`server/db.ts` 第 5 行） | 保留 | **會消失**（若 volume 未掛載） |
| 設定 (settings) | **SQLite** | `settings` 表 key-value | 保留 | 同上 |
| Webhook 原始 payload | **未持久化** | 僅記憶體處理，未寫入 DB 或 log 檔 | 重啟即無 | 無 |
| 上傳檔案 / 圖片 | **本機目錄** | `process.cwd()/uploads`、`uploads/image-assets`、`uploads/avatars` | 保留 | **會消失**（未掛載則無） |
| Session / token | **依實作** | 登入多半 JWT 或 cookie，未見持久化 session 表 | 依實作 | 無 |
| Queue / cron / job state | **無** | 無 Redis/DB job queue；評價卡為「結案當下」發送，無排程 | — | — |
| Log | **stdout** | 無指定 log 檔路徑，僅 `console.log` | 不保留 | 不保留 |
| Cursor 本身 | **非本專案** | 程式碼在 git/工作區；對話上下文為 Cursor 產品行為 | — | — |

**結論**：重要資料都在本機 SQLite 與 `uploads`，無內建備份與保留政策，需文件化並建議備份與 retention。

---

## 二、哪些能直接沿用、哪些要新增

| 需求 | 可沿用 | 要新增 |
|------|--------|--------|
| **A. 避免搶答** | `debounceTextMessage` 邏輯、`withContactLock`、`needs_human`/`isAiMuted` 檢查 | 將 `DEBOUNCE_MS` 改為從 settings 讀取（如 `ai_reply_debounce_seconds`）；後台設定頁顯示目前值；必要時加入「同一輪」定義與「已回過不重複」檢查。 |
| **B. 評價卡延遲** | 現有 `sendRatingFlexMessage`、`cs_rating`/`ai_rating` 防重複 | 延遲發送邏輯（需排程或定時檢查）；「最後一則為客服/AI 且像收尾」的判斷；「可評價狀態」與「X 小時內無新訊息」；設定項 `satisfaction_card_delay_hours`、`satisfaction_card_enabled`；爭議／導流 LINE 不發的欄位或標記。 |
| **C. 訂單回跳** | `lookupOrderById`、OrderInfo、`/api/orders/lookup`、聊天頁已有 contact | 訂單↔對話關聯（見下節）；API：依訂單編號/電話/email 查 contact 或「可能相關對話」；訂單詳情「查看對話」按鈕；對話頁「相關訂單」；搜尋訂單編號可對應到對話。 |
| **D. 資料保存說明** | 現有 DB/路徑 | 文件或後台「資料保存盤點」頁：DB 類型/路徑、重要表、log/uploads、備份建議、保留政策；若無 retention/備份則標示風險。 |
| **E. 後台管理** | 現有 settings 與設定頁 | AI 回覆等待秒數、評價卡延遲時數、評價卡開關、對話狀態（已解決/爭議/導流 LINE）、訂單與對話關聯按鈕、事件時間線／稽核紀錄（若要做）。 |

---

## 三、可能影響的資料表 / API / 前端 / webhook / 排程

| 類別 | 影響 |
|------|------|
| **資料表** | **settings**：新增 key 如 `ai_reply_debounce_seconds`、`satisfaction_card_delay_hours`、`satisfaction_card_enabled`。**contacts**：必要時新增 `satisfaction_eligible_at`、`last_customer_message_at` 或「不發評價」標記；若做訂單↔對話關聯，需 **contact_order_links**（contact_id, order_id/global_order_id, source）或從 messages/ai_log 推論。**訂單不落本地則不需訂單表**，關聯表存 order 編號即可。 |
| **API** | **GET/PUT /api/settings** 或專用 key 讀寫 debounce、評價延遲與開關。**評價卡**：若改為延遲發送，需 **排程**（例如每 N 分鐘掃「可評價且已過 X 小時」的 contact）或 **POST /api/cron/send-pending-ratings** 由外部 cron 呼叫。**訂單回跳**：**GET /api/contacts/by-order?order_id=xxx** 或 **GET /api/orders/:orderId/conversations**（依訂單編號查 contact/對話）；**GET /api/contacts/:id/orders** 改為依 phone/email 或關聯表查訂單。 |
| **前端** | **設定頁**：AI 回覆等待秒數、評價卡延遲時數、評價卡開關。**訂單相關**：訂單詳情或訂單列表「查看對話」；對話詳情「相關訂單」；搜尋框支援訂單編號查對話。**資料盤點**：可為設定內一區塊或獨立「資料保存」頁。 |
| **Webhook** | **LINE/FB**：不改 webhook 簽名與 ACK；若 debounce 改為可設定，僅讀取新設定值，不變更「先 200 OK 再非同步處理」流程。可選：在寫入 message 時更新 `last_customer_message_at`，供評價排程使用。 |
| **排程** | 若評價改為「X 小時後發」：需定時任務（Node 內 setInterval 或外部 cron 打 API）掃描「狀態為 resolved/closed、最後一則為客服/AI、已過 X 小時、未發過評價、未標記不發」的 contact 並發送。 |

---

## 四、風險點與避免誤觸發方案

| 風險 | 說明 | 避免方案 |
|------|------|----------|
| **A. 搶答** | 3 秒若改太短，仍易在客人連發時搶答 | 下限建議 ≥3，上限 8–10 秒；後台顯示目前值並可調。 |
| **A. 人工接手後仍回** | 若 debounce 已在跑，callback 執行時才檢查 needs_human | 現有 `autoReplyWithAI` 內已再取 contact 並檢查；可再加「status 為 closed 不回」。 |
| **B. 客人已回又發評價** | 延遲期間客人又發言，不應再發卡 | 排程或發送前再查「最後一則訊息」：若為 user 或時間在「可評價時間」之後則不發；有新訊息則取消該 contact 的排程。 |
| **B. 重複發卡** | 同一對話發多次 | 維持現有 `cs_rating`/`ai_rating` 檢查；若延遲排程，可加 `satisfaction_sent_at` 或沿用 rating 非 null 即視為已發。 |
| **B. 爭議／導流仍發** | 客訴或已導 LINE 仍收到滿意度 | 新增「不發評價」標記或依 status/tags 排除（如 high_risk、closed 且 tag 含導流）；僅在「已解決且非爭議」才進入延遲發送池。 |
| **C. 訂單↔人搞錯** | 同電話多筆訂單或多人共用電話 | 關聯以「訂單編號 + contact」為主；用電話/email 時標示「可能相關」，並列出多筆對話讓客服選擇，不自動唯一綁定。 |
| **C. 無關聯** | 查單僅在對話內，未寫回 DB | 若要做「訂單詳情→對話」，需在 AI 查單成功時寫入 contact_order_links，或定期用訂單 phone/email 比對 contact（需先補 contact 的 phone/email 或從訊息萃取）。 |
| **D. 資料丟失** | SQLite/uploads 在換機或重建後消失 | 文件明確寫出路徑、備份建議（例如定期複製 `omnichannel.db` 與 `uploads`）、保留政策；部署建議掛 volume。 |

---

## 五、訂單↔對話關聯設計（C 項）

**建議優先順序與風險**：

1. **依訂單編號 + 寫入關聯**  
   - AI 或客服在對話中查詢訂單成功時，寫入一筆 `contact_order_links(contact_id, global_order_id, source)`。  
   - 訂單詳情頁用 `global_order_id` 反查 contact，顯示「查看對話」並帶 contact_id。  
   - 風險：歷史對話未寫入則查不到，僅新查單後可回跳。

2. **依電話／email 查詢**  
   - 訂單有 `buyer_phone`、`buyer_email`；contact 目前沒有，需從訊息內容或 AI 萃取寫入 contact 欄位，或建「contact_identifiers(contact_id, phone/email)」。  
   - 用訂單的 phone/email 查 contact，列出「可能相關對話」。  
   - 風險：同電話多訂單、共用電話、資料不完整會有多筆或找不到。

3. **platform_user_id（LINE/FB）**  
   - 一頁式訂單通常沒有 LINE UID，無法直接對應；僅在「從 LINE 內連到訂單頁並帶參數」時才可能綁定，實務上多數沒有。

**建議**：  
- 先做 (1) 查單成功寫入 `contact_order_links` + 訂單詳情「查看對話」按鈕。  
- (2) 視需求再補 contact 的 phone/email 或 identifier 表，用於「依訂單電話找可能對話」。

**一頁式訂單編號格式**：  
- 文件中已見 `global_order_id`、範例如 20260303101244717、DEN65151、MRQ55276；`lookupOrderById` 會做 `trim().toUpperCase()`，實作時以 `global_order_id` 為準即可。

---

## 六、評價卡延遲方案建議（B 項）

- **12 小時 vs 24 小時**：電商客服情境下，12 小時較常見（當天結案、隔日上午可收卡）；24 小時較不催促，但部分客人已忘情境。建議**預設 12 小時**，並可設定 6/12/24/48。  
- **較完整規則**：  
  - 僅在「最後一則為客服或 AI」且狀態為 resolved/closed 時，才進入「可發評價」狀態。  
  - 記錄「可發評價時間點」；若之後 X 小時內沒有「客人新訊息」，則發送；若其間有客人新訊息，則取消或重算。  
  - 同一對話只發一次（沿用 cs_rating/ai_rating）。  
  - 若 status 為 high_risk 或 tags 含導流 LINE／爭議等，可不進入發送池或設「不發評價」旗標。

---

## 七、下一步（實作前確認）

1. **A**：將 debounce 改為設定（key 如 `ai_reply_debounce_seconds`），後台可編輯並顯示目前值；必要時補「同一輪」定義與不重複回覆檢查。  
2. **B**：新增設定 `satisfaction_card_delay_hours`、`satisfaction_card_enabled`；實作「可評價狀態 + X 小時內無新訊息才發」；排程或 cron 掃描並發送；發送前再檢查最後一則與是否已發。  
3. **C**：新增 `contact_order_links`（或等效）與寫入時機；API 依 order_id 查 contact；訂單詳情「查看對話」；視需求補 phone/email 查詢。  
4. **D**：撰寫「資料保存盤點」文件或後台區塊（DB、uploads、log、備份建議、保留政策、無備份風險）。  
5. **E**：後台集中「AI 回覆等待秒數、評價卡延遲與開關、訂單回跳按鈕」等，並視需求加事件時間線／稽核。

若你同意此盤點與方向，我再依此開始實作（先 A、B、D、E 可設定與文件，C 依你優先級做關聯與按鈕）。
