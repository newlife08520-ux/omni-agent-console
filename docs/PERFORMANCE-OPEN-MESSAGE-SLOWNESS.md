# 「點開訊息」載入 1～2 秒 — 全方面分析與優化

## 現象

正式機 [https://richbear-omnicare-hub.up.railway.app/](https://richbear-omnicare-hub.up.railway.app/) 升級容量後可正常開啟，但**每次點開一則對話（訊息）都要載入 1～2 秒**才出現內容。

---

## 根因分析（為何會慢）

### 1. 點開訊息時前端會發哪些請求？

選中一個聯絡人（`selectedId`）時，`chat.tsx` 會同時發多個 API（皆 `enabled: !!selectedId`）：

| 請求 | 用途 | 可能耗時 |
|------|------|----------|
| `GET /api/contacts/:id/messages` | 載入對話紀錄 | **高**：預設 200 筆、DB 查詢 + JSON 體積大 |
| `GET /api/contacts/:id` | 聯絡人詳情（含 ai_suggestions） | **高**：見下 |
| `GET /api/contacts/:id/assignment` | 分配狀態 | 低 |
| `GET /api/contacts/:id/linked-orders` | 關聯訂單 | 低～中 |

畫面要「可用」通常會等 **messages** 與 **contact detail** 都回來，所以兩者任一變慢都會拉長體感時間。

### 2. 後端瓶頸（主要來源）

#### 2.1 GET /api/contacts/:id 內藏「讀 500 則訊息」

- 程式在回傳聯絡人前會呼叫 `suggestAiFromMessages(id)`，用最近訊息關鍵字產生 AI 建議（issue_type、status、tags）。
- **原本實作**：`storage.getMessages(contactId).slice(-20)`  
  - `getMessages(contactId)` **未傳 limit**，預設會讀 **500 筆**訊息。
  - 再用 `.slice(-20)` 只取最後 20 筆來算建議。
- 結果：每次點開對話都會為「聯絡人詳情」多讀 **500 筆** 訊息（SQLite + JSON 組裝），再丟掉 480 筆，造成明顯延遲（尤其 Railway 磁碟 I/O）。

#### 2.2 訊息列表一次 200 筆

- `GET /api/contacts/:id/messages` 未帶 `limit` 時，後端預設 **200**。
- 對話一多、單筆 content 較長時，單次回應體積大、傳輸與解析時間拉長，首屏體感變慢。

#### 2.3 其餘部分

- `getContacts` 已改為批次查「每個 contact 的最後一則訊息」，無 N+1。
- `messages` 表已有 `idx_messages_contact_id`、`idx_messages_contact_created`，查詢有索引可用。
- 因此主要瓶頸在「聯絡人詳情內重複、過量的訊息讀取」與「訊息列表預設筆數偏大」。

---

## 已實作優化

### 1. suggestAiFromMessages 只讀 20 筆

- **改動**：`storage.getMessages(contactId).slice(-20)` → `storage.getMessages(contactId, { limit: 20 })`  
- **效果**：計算 AI 建議時只向 DB 要最近 20 筆，不再讀 500 筆，大幅減少 I/O 與 CPU。

### 2. GET /api/contacts/:id 先回傳、AI 建議改背景

- **改動**：聯絡人取得後**立即 `res.json(contact)`**；若狀態非 closed/resolved，用 `setImmediate` 在背景執行 `suggestAiFromMessages` → `updateContactAiSuggestions`，完成後 `broadcastSSE("contacts_updated", { contact_id, brand_id })`。
- **效果**：點開訊息時「聯絡人詳情」不再被 AI 建議計算卡住，首屏回應變快；建議算完後透過既有 SSE，前端會 invalidate 並自動 refetch，稍後補上 ai_suggestions。

### 3. 訊息列表預設筆數 200 → 80

- **改動**：`GET /api/contacts/:id/messages` 的預設 `limit` 由 200 改為 **80**（仍可透過 query `limit` 指定 1～500）。
- **效果**：首筆訊息 API 回應體積與 DB 工作量下降，載入更快；需要更早的紀錄時可透過「載入更早的訊息」再拉取。

---

## 優化後流程簡述

1. 使用者點選一則對話。
2. 前端並行請求：messages（預設 80 筆）、contact detail、assignment、linked-orders。
3. **Contact detail** 立刻回傳（不再等 500 筆訊息 + AI 建議），**messages** 因筆數減少也較快。
4. 背景算完 AI 建議後寫入 DB 並廣播 `contacts_updated`，前端 refetch 後取得更新後的 ai_suggestions。

---

## 若仍覺得慢可再檢查

- **Railway Volume I/O**：若使用率仍高，可再確認 [VOLUME-USAGE-AND-SLOWNESS.md](./VOLUME-USAGE-AND-SLOWNESS.md)。
- **網路**：用 DevTools → Network 看各 API 的 TTFB 與下載時間，區分是「後端慢」還是「傳輸/前端慢」。
- **首屏必要資料**：若未來要再優化，可考慮「首屏只取最近 N 條（如 30）」，其餘用捲動載入。

---

## 總結

| 項目 | 優化前 | 優化後 |
|------|--------|--------|
| 聯絡人詳情內訊息讀取 | 500 筆（只用 20 筆） | 0 筆（詳情先回傳）；背景只讀 20 筆 |
| 聯絡人詳情回應 | 等 AI 建議算完才回 | 先回傳，建議背景算完再經 SSE 更新 |
| 訊息列表預設筆數 | 200 | 80 |

預期可明顯縮短「點開訊息」到出現對話內容的 1～2 秒延遲；若實測仍有瓶頸，可依上述「若仍覺得慢」段落逐項排查。
