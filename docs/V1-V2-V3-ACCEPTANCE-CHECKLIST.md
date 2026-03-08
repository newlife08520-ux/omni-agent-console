# V1/V2/V3 人工驗收清單

**目標**：驗證 fail-closed 修正是否生效，且未破壞正常回覆。  
**範圍**：僅下列 6 個情境，不改 code。

---

## 情境 1：無 destination → 不自動回

| 項目 | 內容 |
|------|------|
| **前置條件** | LINE Webhook 已指向本系統；可送測試事件（或暫時讓 body 無 `destination`）。 |
| **怎麼測** | 送一則 LINE webhook 事件（文字或影片），body 內**沒有** `destination` 欄位（或為空）。 |
| **預期 log 關鍵字** | `No destination field in webhook body`、`無 destination，視為未匹配 channel，不自動回覆（fail-closed）`；若為文字則有 `無匹配 channel，跳過文字自動回覆（fail-closed）`。 |
| **預期外部行為** | 用戶端（LINE）**收不到**任何自動回覆。 |
| **通過判準** | 外部未收到回覆，且 log 出現上述 fail-closed 相關字樣。 |

---

## 情境 2：destination 對不到 channel → 不 fallback、不改 bot_id、不自動回

| 項目 | 內容 |
|------|------|
| **前置條件** | DB 中已有至少一筆 LINE channel（bot_id 為 A）；可送 webhook。 |
| **怎麼測** | 送一則 LINE webhook，`destination` 設為** DB 中不存在的 bot_id**（例如與 A 不同的值）。送前記下該 channel 的 bot_id；測後再查 DB 確認 bot_id 未變。 |
| **預期 log 關鍵字** | `NO MATCH for bot_id:`、`不 fallback，無法確認渠道時不進行自動回覆（fail-closed）`；若為文字則有 `無匹配 channel，跳過文字自動回覆（fail-closed）`。 |
| **預期外部行為** | 用戶端**收不到**自動回覆；DB 中該 channel 的 **bot_id 未被改寫**。 |
| **通過判準** | 未收到回覆、bot_id 未變、log 有 NO MATCH 與「不 fallback」且無「FALLBACK to first LINE channel」或「AUTO-FIXED」。 |

---

## 情境 3：channel 匹配但 is_ai_enabled=0 → 不自動回

| 項目 | 內容 |
|------|------|
| **前置條件** | 有一筆 LINE channel 已正確設定 bot_id / destination，且該 channel **is_ai_enabled = 0**（後台關閉 AI）。 |
| **怎麼測** | 用該 channel 的 destination 送一則**文字** webhook。 |
| **預期 log 關鍵字** | `MATCH FOUND`、`AI 已關閉 (channel: ...) - 跳過自動回覆`。 |
| **預期外部行為** | 用戶端**收不到** AI 或固定回覆。 |
| **通過判準** | 未收到回覆，且 log 為「AI 已關閉」而非「無匹配 channel」。 |

---

## 情境 4：needs_human=1 後送影片 → 不發固定回覆

| 項目 | 內容 |
|------|------|
| **前置條件** | 同一 LINE 用戶已因關鍵字或手動被設為 **needs_human=1**（已轉人工）；該 channel 匹配且 is_ai_enabled=1。 |
| **怎麼測** | 該用戶再送一則**影片** webhook。 |
| **預期 log 關鍵字** | `案件已轉人工(needs_human=1)，跳過影片固定回覆 contact_id=`。 |
| **預期外部行為** | 用戶端**收不到**「已收到您的影片，將為您轉交專人檢視。」。 |
| **通過判準** | 未收到影片固定回覆，且 log 有 needs_human 跳過字樣。 |

---

## 情境 5：channel 匹配且 AI 開啟，文字訊息 → 正常自動回

| 項目 | 內容 |
|------|------|
| **前置條件** | 有一筆 LINE channel 匹配（destination 正確）、**is_ai_enabled=1**；有設定 OpenAI API Key；該聯絡人 **needs_human=0**。 |
| **怎麼測** | 送一則該 channel 的**文字** webhook（非轉人工關鍵字）。 |
| **預期 log 關鍵字** | `MATCH FOUND`、無「無匹配 channel」或「AI 已關閉」、有 `autoReplyWithAI` 或後續 AI 流程相關 log。 |
| **預期外部行為** | 用戶端**有收到** AI 回覆（或測試模式下僅 DB 有紀錄、依 test_mode 設定）。 |
| **通過判準** | 在 AI 開啟且 test_mode 未擋的前提下，外部有收到回覆；或 test_mode 開啟時僅 DB/SSE 有紀錄、無外發，且無錯誤。 |

---

## 情境 6：channel 匹配且 AI 開啟、未轉人工，影片 → 正常固定回覆

| 項目 | 內容 |
|------|------|
| **前置條件** | 同一 LINE channel 匹配、is_ai_enabled=1；該聯絡人 **needs_human=0**。 |
| **怎麼測** | 該用戶送一則**影片** webhook。 |
| **預期 log 關鍵字** | `MATCH FOUND`、無「案件已轉人工」或「跳過影片固定回覆」；可有影片處理成功等 log。 |
| **預期外部行為** | 用戶端**有收到**「已收到您的影片，將為您轉交專人檢視。」。 |
| **通過判準** | 有收到上述固定回覆文案，且 log 無 needs_human 或 fail-closed 擋下。 |

---

## 最短回報格式

每測完一個情境，可依下表回報：

| 欄位 | 填寫 |
|------|------|
| **1. 情境編號** | 1 / 2 / 3 / 4 / 5 / 6 |
| **2. 是否通過** | 通過 / 不通過 |
| **3. 外部實際收到什麼** | 有收到：簡述內容；未收到：寫「未收到」 |
| **4. log 關鍵字** | 實際看到的關鍵 log 一兩句（可節錄） |
| **5. 是否與預期一致** | 是 / 否；若否請簡述差異 |

**範例：**

- 情境編號：1  
- 是否通過：通過  
- 外部實際收到什麼：未收到  
- log 關鍵字：`No destination field in webhook body`、`無 destination，視為未匹配 channel，不自動回覆（fail-closed）`  
- 是否與預期一致：是  

---

本輪僅做驗收支援與回報格式整理，不改 code，不進入下一輪修正。
