# 圖片訊息流程現況與 Vision 使用報告

## 結論先講：屬於情況 B（圖有拿到，但沒送進 Vision）

- **情況 A**：系統拿得到圖，但被流程設計成先走模板 → **部分符合**（流程確是 template-first）。
- **情況 B**：系統根本沒把圖送進 vision，AI 沒看到圖 → **成立**：純圖片訊息時，**從未呼叫 vision**，只回固定模板。

因此：**解法 = 先改「有沒有送 vision」**（改為 vision-first），再優化意圖分類與 fallback。

---

## 1. LINE / FB Webhook 收到圖片後，系統目前拿到什麼？

### LINE

| 項目 | 現況 |
|------|------|
| Webhook 收到 | `event.message.type === "image"`，`event.message.id`（messageId） |
| 系統有無下載圖片檔？ | **有**。呼叫 `downloadLineContent(messageId, ".jpg", channelToken)`，向 LINE Get Content API 下載二進位，寫入本地 `uploads/`，回傳本地路徑（如 `/uploads/line-xxx.jpg`） |
| 寫入 DB | `storage.createMessage(contact.id, "line", "user", "[圖片訊息]", "image", imageUrl)` → **content 為 "[圖片訊息]"**，**image_url 為本地檔案路徑** |
| 有無送進模型看圖？ | **沒有**。純圖片分支內**只**：寫入 message → 取 `SAFE_IMAGE_ONLY_REPLY`（或 escalate 文案）→ 直接回覆，**未呼叫任何 OpenAI Vision / multimodal API** |

### Facebook (Messenger)

| 項目 | 現況 |
|------|------|
| Webhook 收到 | `att.type === "image"`, `att.payload.url`（圖檔 URL） |
| 系統有無下載圖片檔？ | **有**。呼叫 `downloadExternalImage(att.payload.url)`，下載後寫入本地 `uploads/fb-xxx.jpg`，回傳本地路徑；失敗則保留原 URL |
| 寫入 DB | `storage.createMessage(contact.id, "messenger", "user", "[圖片訊息]", "image", finalUrl)` → 同上，**content 固定 "[圖片訊息]"**，**image_url 有值** |
| 有無送進模型看圖？ | **沒有**。同 LINE，純圖片時只回 `SAFE_IMAGE_ONLY_REPLY` / escalate，**未呼叫 Vision** |

### 小結

- 兩平台都有：**message type、image id/url，以及實際下載後的圖檔（或可存取 URL）**。
- 兩平台都沒有：在**純圖片訊息**的處理路徑上，**把圖送進 vision / multimodal**。  
→ 因此屬於 **情況 B**：圖拿得到，但 AI 根本沒看到圖；prompt 再怎麼寫都沒用，因為純圖片時從未進 LLM。

---

## 2. 現有「有送圖」的程式在哪裡？為何純圖片沒用到？

- **`analyzeImageWithAI(imageFilePath, contactId, lineToken, platform)`**（routes.ts）：會把圖轉成 data URI，連同近期對話送進 OpenAI Chat Completions（含 `image_url`），並可呼叫查單／轉人工等 tools。  
- 但在 **LINE / FB webhook 的「純圖片」分支裡，沒有任何地方呼叫 `analyzeImageWithAI`**。  
- 主流程 **文字訊息**進 `autoReplyWithAI` 時，會把歷史訊息中的 `message_type === "image"` 且 `image_url` 有值的訊息轉成 `image_url` 放進 prompt，所以**若用戶先發圖再發文，主流程有機會「看到」那張圖**；但**用戶只發圖、不發文時，不會進主流程，只走固定模板**。

---

## 3. 兩種情況對應的解法（區分清楚）

| 情況 | 描述 | 解法 |
|------|------|------|
| **A** | 系統拿得到圖，但被流程設計成先走模板 | 改流程：純圖片也先跑 vision 意圖判讀，再決定回覆或 fallback；不先塞固定模板 |
| **B** | 系統沒把圖送進 vision，AI 沒看到圖 | 在純圖片路徑**加入** vision 呼叫（或共用 `analyzeImageWithAI` / 新 vision-first 入口），確保「有圖就送進模型」 |

目前是 **B + 流程像 A**：  
- 先做 **B 的解法**：純圖片時改為「下載 → 存 message → **送 vision** → 依意圖回覆或 fallback」。  
- 同時做 **A 的解法**：改為 vision-first（先判讀意圖，高信心直接回或只問 1 題，低信心才用縮短 fallback），不再「有圖就先發問卷」。

---

## 4. 後續實作方向（簡要）

1. **Vision-first 入口**：LINE / FB 純圖片分支改為呼叫統一的「圖片處理」函式，內含：送圖 + 近期對話 + 案件標籤／商品範圍／查單退貨脈絡 → 先做**圖片意圖判讀**（訂單截圖、商品問題、商品頁/尺寸、無關、無法判讀）。  
2. **意圖對應行為**：訂單/物流截圖 → 查單或只問 1 個關鍵欄位；商品問題/瑕疵 → 售後路徑；商品頁/尺寸 → 商品問答；無關圖 → 短句收邊界；無法判讀／低信心 → **縮短 fallback，只問 1 個最關鍵問題**。  
3. **Fallback 縮短**：現有「四選一 + 補單號/商品名/手機」改為低信心時才用，且改為**最多 1 段、只問 1 個關鍵問題**。  
4. **驗收**：新增圖片場景（訂單截圖、客服對話截圖、包包商品頁/尺寸圖、瑕疵照、無關圖、低信心圖）的預期行為與 pass/fail。

以上為圖片流程現況與 vision 使用之明確區分與對應解法。

---

## 5. 已實作：Vision-first 與縮短 Fallback

- **純圖片**（LINE / FB）：下載圖後改為呼叫 `handleImageVisionFirst(imagePath, contactId)`，將圖 + 近期對話 + 案件標籤 + 已鎖定商品範圍送進 OpenAI Vision，回傳 JSON：`intent`（order_screenshot / product_issue_defect / product_page_size / off_brand / unreadable）、`confidence`（high / low）、`reply_to_customer`。
- **高信心**：直接使用 `reply_to_customer`（經 output guard）；**低信心或 unreadable**：使用 `SHORT_IMAGE_FALLBACK`（只問 1 個關鍵問題）。
- **Fallback 文案**：`收到圖了～可以簡單說一下這張圖是關於「訂單/出貨」、「商品問題」還是其他嗎？一句就好，我才能對應處理。`
- **Escalate**：仍依 `shouldEscalateImageSupplement`（近期含「收到圖了～」或舊版「已收到您的圖片」達 2 次即升級人工）。

---

## 6. 圖片驗收案例（預期行為）

| 案例 | 輸入 | 預期意圖／行為 | 禁止 |
|------|------|----------------|------|
| 訂單截圖 | 貼訂單/出貨截圖 | 先判讀為 order_screenshot，簡短說明協助查單、只問 1 個必要欄位 | 不可直接問四選一、不可先問卷 |
| 客服對話截圖 | 貼客服對話截圖（反映回覆不當） | 判讀為 order_screenshot 或反映問題，簡短承接 | 不可一律問分類 |
| 包包商品頁/尺寸圖 | 貼包包商品頁或尺寸圖 | 判讀為 product_page_size，商品問答、簡短 | 不可退回通用模板、不可跳類（已鎖定包包時不提甜點） |
| 商品瑕疵照 | 貼瑕疵/損壞照片 | 判讀為 product_issue_defect，走售後路徑、安撫 | 不可先問一堆無關欄位 |
| 無關圖片 | 貼與品牌無關圖 | 判讀為 off_brand，短句收邊界 | 不可陪聊、不可推薦 |
| 低信心/無法判讀 | 模糊或無法歸類圖 | 使用 fallback，只問 1 個關鍵問題 | 不可長問卷、不可多段多選 |

驗收時需確認：**reply_source = image_vision_first**、ai_log 內 **result_summary** 含 intent；實際回覆文案符合上表「預期」且不觸犯「禁止」。
