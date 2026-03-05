# 私訊（DM）安全確認 — 上線前可執行驗收步驟

本文為 **私訊通道** 的「非本店／他平台／詐騙／待確認來源」安全確認驗收，與 `EXTERNAL_ORDER_AND_SAFE_AFTERSALE.md` 共用同一套判定邏輯（`safe-after-sale-classifier`）。

---

## 觸發方式說明

私訊 AI 回覆的入口為：

1. **LINE**：使用者傳送文字訊息 → `POST /api/webhook/line` → `autoReplyWithAI()`
2. **Messenger**：使用者傳送文字訊息 → `POST /api/webhook/messenger`（或 FB 對應 endpoint）→ `autoReplyWithAI()`

驗收可擇一進行：

- **方式 A（建議）**：在已串接的 LINE / Messenger 測試帳號中，由使用者實際傳送下列訊息，觀察後台「聯絡人」該則對話的 AI 回覆與案件狀態。
- **方式 B**：以 curl 或 Postman 模擬 Webhook 請求（需正確簽章與 payload 結構），觸發同上流程。

驗收時請確認：**回覆內容**、**聯絡人狀態是否設為 awaiting_human**、**AI Log 內是否為 safe_confirm_template**，以及**未出現退款承諾／認責**。

---

## 私訊案例 1：他平台訂單

### 輸入

| 項目 | 內容 |
|------|------|
| 觸發方式 | LINE 或 Messenger 由使用者傳送一則文字訊息（或模擬 Webhook 之 `message.text`） |
| 實際輸入 message | `我在蝦皮買的怎麼還沒到` |

### 預期結果

| 項目 | 預期 |
|------|------|
| classifier 回傳類型 | `classifyMessageForSafeAfterSale` 命中 **external_platform**（對應模板 category：**external_platform_order**） |
| 實際回覆使用模板欄位 | **reply_private**（若該模板無 `reply_private` 則 fallback **reply_first**） |
| 是否設為 awaiting_human | **否**（他平台為導正方向，預設不強制轉人工） |
| 是否避免標準售後承諾 | **是**：回覆不得承諾「我們會為您處理出貨／退款」；須引導確認是否官方通路、或說明他平台訂單請找該平台客服 |

### 驗收檢查清單

- [ ] 回覆文案為「他平台訂單｜導正方向」之私訊版（含 reply_private 或 reply_first）
- [ ] 文案中無「我們會幫您處理出貨／退款」等認責／承諾
- [ ] 有引導「若為官方通路請提供訂單編號」或「他平台請找該平台客服」
- [ ] AI Log 中 `tools_called` 含 `safe_confirm_template`，`result_summary` 含 `external_platform_order`

---

## 私訊案例 2：詐騙／冒用

### 輸入

| 項目 | 內容 |
|------|------|
| 觸發方式 | LINE 或 Messenger 由使用者傳送一則文字訊息（或模擬 Webhook） |
| 實際輸入 message | `我被假客服騙了，對方要我轉帳` |

### 預期結果

| 項目 | 預期 |
|------|------|
| classifier 回傳類型 | `classifyMessageForSafeAfterSale` 命中 **fraud_impersonation**（對應模板 category：**fraud_impersonation**） |
| 實際回覆使用模板欄位 | **reply_private**（蒐證引導；若無則 fallback **reply_first**） |
| 是否設為 awaiting_human | **是**（`suggest_human === true` 時聯絡人狀態應設為 **awaiting_human**，並建立 case notification） |
| 是否避免標準售後承諾 | **是**：不得承諾退款、不得認責；須引導提供截圖／付款證明／對方帳號，並建議報警／通知平台 |

### 驗收檢查清單

- [ ] 回覆文案為「疑似詐騙／冒用｜蒐證引導」之私訊版
- [ ] 文案中無「我們會退款」「是我們的疏失」等認責／承諾
- [ ] 聯絡人狀態為 **awaiting_human**
- [ ] AI Log 中 `transfer_triggered: true`，`transfer_reason` 含 `安全確認分流(fraud_impersonation)`

---

## 私訊案例 3：來源不明／查無訂單

### 輸入

| 項目 | 內容 |
|------|------|
| 觸發方式 | LINE 或 Messenger 由使用者傳送一則文字訊息（或模擬 Webhook） |
| 實際輸入 message | `查不到我的訂單，我要退款` |

### 預期結果

| 項目 | 預期 |
|------|------|
| classifier 回傳類型 | `classifyMessageForSafeAfterSale` 命中 **safe_confirm_order**（訂單／退款關鍵字且無「官網／官方」等本店提示） |
| 實際回覆使用模板欄位 | **reply_private**（待確認訂單來源｜安全確認；若無則 fallback **reply_first**） |
| 是否設為 awaiting_human | **否**（預設不強制；若營運另設規則可再調） |
| 是否避免標準售後承諾 | **是**：不直接承諾退款；須先引導提供「官方通路訂單資訊」或確認是否為本店訂單 |

### 驗收檢查清單

- [ ] 回覆文案為「待確認訂單來源｜安全確認（通用）」之私訊版
- [ ] 文案中無「我們會為您辦理退款」等直接承諾
- [ ] 有引導提供訂單編號／下單手機或確認是否官方通路
- [ ] AI Log 中 `result_summary` 含 `safe_confirm_order`

---

## 名詞對照（程式 vs 文件）

| 文件／驗收用語 | 程式內 |
|----------------|--------|
| 他平台訂單 | classifier **type**: `external_platform` → 模板 **category**: `external_platform_order` |
| 詐騙／冒用 | classifier **type**: `fraud_impersonation` → 模板 **category**: `fraud_impersonation` |
| 來源不明／查無訂單／待確認 | classifier **type**: `safe_confirm_order` → 模板 **category**: `safe_confirm_order` |

---

## 模擬 Webhook 時注意事項

- LINE：body 需含 `destination`、`events[].type`、`events[].message.type === "text"`、`events[].message.text`；若開啟簽章驗證，需正確計算 `x-line-signature`。
- Messenger：body 需符合 Facebook 要求的 `entry` / `messaging` 結構，且含 `message.text`。
- 模擬後可在後台「聯絡人」點選該聯絡人，查看「訊息」與「AI Log」，核對回覆內容與 `tools_called` / `result_summary`。

---

## 與留言驗收的關係

- 判定邏輯與 `docs/EXTERNAL_ORDER_AND_SAFE_AFTERSALE.md` 一致，差別僅在：
  - **留言**：可隱藏、可導 LINE、使用 reply_first / reply_second。
  - **私訊**：不隱藏、使用 reply_private（或 fallback reply_first），依 type 決定是否設 awaiting_human。

若三個私訊案例皆通過，可視為私訊通道「安全確認先於標準售後、不亂承認、不亂承諾」已達上線前驗收標準。

---

## 圖片型私訊邏輯與模板（不亂猜、不亂承諾、先縮小問題）

圖片型私訊與文字型共用「不亂承認、不亂承諾」原則，**不依 Vision/OCR 硬判**，先引導補充類型與資訊。

### 會走哪條邏輯

| 情境 | 邏輯 | 行為 |
|------|------|------|
| **僅圖片、無文字** | 不進一般 AI／Vision 售後承諾 | 回覆 **圖片型通用補充版**，要求補充：類型（訂單查詢／出貨物流／商品問題／付款／疑似詐騙）＋訂單編號／商品名稱／下單手機 |
| **圖片＋極短／模糊文字**（如「幫我看」「這個怎麼辦」「是不是被騙」） | 不當成已確認情境 | 先走 **補充模板**：依文字 hint 選「通用／訂單物流／詐騙付款／商品問題」其一，不進一般 AI |
| **圖片＋明確文字**（如「我在蝦皮買的怎麼還沒到」「我被假客服騙了」「這筆官網訂單怎麼還沒出貨」） | 依文字跑 **classifyMessageForSafeAfterSale** | 命中則走既有安全確認模板（他平台／詐騙蒐證／待確認訂單／本店訂單）；未命中則可進一般 AI |

### 哪些情況只回中性補充模板

- **僅圖片、無文字**：一律回 **IMAGE_DM_GENERIC**（通用補充版）。
- **圖片＋短文字**（字數 ≤20 或命中「幫我看、這個怎麼辦、是不是被騙」等）：回 **getImageDmReplyForShortCaption(text)**，依關鍵字 hint 選一則（詐騙→疑似詐騙/付款截圖；訂單/出貨→疑似訂單/物流；過敏/瑕疵→商品問題；其餘→通用）。

以上皆**不呼叫 Vision**，不猜訂單或責任歸屬。

### 哪些情況會進一步套安全確認模板

- **圖片＋明確文字**且 `classifyMessageForSafeAfterSale(text)` 命中時：
  - 他平台 → **external_platform_order**（reply_private）
  - 詐騙／冒用 → **fraud_impersonation**（reply_private，並可設 awaiting_human）
  - 待確認訂單來源 → **safe_confirm_order**（reply_private）
- 本店明確文字（如「這筆官網訂單怎麼還沒出貨」）未命中安全確認時，可進一般訂單查詢／售後流程。

### 新增的圖片型私訊 fallback 模板（常數）

皆在 `server/safe-after-sale-classifier.ts`：

| 常數 | 用途 |
|------|------|
| **IMAGE_DM_GENERIC** | 圖片型私訊通用補充版（僅圖片，或圖片＋短文字無明顯 hint） |
| **IMAGE_DM_ORDER_SHIPPING** | 圖片型私訊疑似訂單／物流畫面（短文字含 訂單、出貨、物流、還沒到、漏寄、查詢） |
| **IMAGE_DM_FRAUD_PAYMENT** | 圖片型私訊疑似詐騙／付款截圖（短文字含 詐騙、被騙、假客服、轉帳、匯款、騙） |
| **IMAGE_DM_PRODUCT_ISSUE** | 圖片型私訊商品問題／瑕疵／過敏（短文字含 過敏、瑕疵、商品、壞掉、擦了） |

語氣符合目前人格：不機器、不官腔、不先承認責任。

### 連續無效圖片／無效補充的升級邏輯

- 若同一位用戶**連續 2 次**仍只丟圖片，或圖片後仍只回極短／無法判斷的內容（如「幫我看」「你看一下」），不再重複補問。
- **規則**：近期 AI 回覆中若有 ≥2 則為「圖片型補充模板」內容（以「已收到您的圖片」或「收到您的圖片了」開頭），則本次改為：
  - 回覆固定文案：**「已為您轉接專人檢視，請稍候。」**
  - 標記聯絡人 **awaiting_human**、建立 case notification，避免無限循環補問。
- 常數：`IMAGE_SUPPLEMENT_ESCALATE_THRESHOLD = 2`、`IMAGE_SUPPLEMENT_ESCALATE_MESSAGE`（`safe-after-sale-classifier.ts`）。

### 圖片型私訊的 log／追蹤

每則圖片型相關回覆都會寫入 **AI Log**，至少可辨識：

| 欄位 | 說明 |
|------|------|
| **tools_called** | `image_dm_only`（僅圖片）／`image_dm_short_caption`（圖片＋短文字）／`safe_confirm_template`（圖片＋明確文字且命中安全確認） |
| **result_summary** | `image_only \| IMAGE_DM_GENERIC` 或 `image_only \| escalated_awaiting_human`；`image_short_caption \| <模板名>` 或 `image_short_caption \| escalated_awaiting_human`；`safe_confirm_template: <category>` 或 `safe_confirm_template: <category> \| image_clear_caption` |
| **transfer_triggered** | 是否轉人工（連續無效升級或詐騙型 suggest_human） |

可依此統計：哪類圖片型訊息最多、哪個模板最常用、哪種情境最常卡住需升級人工。

### 四組圖片型模板之後是否搬進後台（建議）

- **建議**：之後可將四組圖片型模板搬進 **後台模板管理**（如 `meta_comment_templates`），category 例如 `image_dm_generic`、`image_dm_order_shipping`、`image_dm_fraud_payment`、`image_dm_product_issue`，每筆一則 `reply_first` 或單一文案欄位。
- **好處**：營運可改文案不需改 code／部署；與既有留言模板管理一致。
- **實作**：讀取時 `getMetaCommentTemplateByCategory(brand_id, category)`，若無則 fallback 現有常數；遷移時於 DB 寫入四筆預設內容與現有常數一致即可。
- 本輪維持常數實作，上述作為後續優化選項。

---

## 圖片型私訊防呆（僅圖片、無文字）— 實作摘要

當使用者**只傳圖片、沒有文字**時，不進入一般 AI / Vision 售後承諾流程，改為先回 **IMAGE_DM_GENERIC**（= `SAFE_IMAGE_ONLY_REPLY`）：

- **行為**：LINE 與 Messenger 收到純圖片時，回覆通用補充版並寫入一則 AI 訊息，**不呼叫 Vision**。
- 驗收：傳送一則純圖片，確認回覆為通用補充版且未出現退款／認責字眼。

---

## 實跑紀錄（classifier 實跑結果）

以下為對三則測試訊息執行 `classifyMessageForSafeAfterSale` 的實際輸出（執行 `npx tsx script/run-dm-classifier-check.ts`）：

```json
{
  "title": "classifyMessageForSafeAfterSale 實跑結果",
  "run_at": "2026-03-05T04:47:07.826Z",
  "cases": [
    {
      "case_name": "他平台訂單",
      "input": "我在蝦皮買的怎麼還沒到",
      "result": {
        "matched": true,
        "keyword": "蝦皮",
        "type": "external_platform",
        "suggest_hide": false,
        "suggest_human": false
      }
    },
    {
      "case_name": "詐騙／冒用",
      "input": "我被假客服騙了，對方要我轉帳",
      "result": {
        "matched": true,
        "keyword": "假客服",
        "type": "fraud_impersonation",
        "suggest_hide": true,
        "suggest_human": true
      }
    },
    {
      "case_name": "來源不明／查無訂單",
      "input": "查不到我的訂單，我要退款",
      "result": {
        "matched": true,
        "keyword": "訂單",
        "type": "safe_confirm_order",
        "suggest_hide": false,
        "suggest_human": false
      }
    }
  ]
}
```

---

## 實跑紀錄（LINE / Messenger 端到端，請測試環境執行後填寫）

請在**測試環境**依序以 LINE 文字、Messenger 文字傳送下列訊息，並將實際結果填入下表（至少各跑一次）。

| 通道 | 實際輸入 | classifier 結果（type） | 實際回覆內容（節錄） | 是否命中 safe_confirm_template | 是否無承諾性字眼 |
|------|----------|--------------------------|------------------------|----------------------------------|------------------|
| LINE 文字 | 我在蝦皮買的怎麼還沒到 | （應為 external_platform） | _請貼上後台該則 AI 回覆_ | _是／否_ | _是／否_ |
| LINE 文字 | 我被假客服騙了，對方要我轉帳 | （應為 fraud_impersonation） | _請貼上後台該則 AI 回覆_ | _是／否_ | _是／否_ |
| LINE 文字 | 查不到我的訂單，我要退款 | （應為 safe_confirm_order） | _請貼上後台該則 AI 回覆_ | _是／否_ | _是／否_ |
| Messenger 文字 | 我在蝦皮買的怎麼還沒到 | （應為 external_platform） | _請貼上後台該則 AI 回覆_ | _是／否_ | _是／否_ |
| Messenger 文字 | 我被假客服騙了，對方要我轉帳 | （應為 fraud_impersonation） | _請貼上後台該則 AI 回覆_ | _是／否_ | _是／否_ |
| Messenger 文字 | 查不到我的訂單，我要退款 | （應為 safe_confirm_order） | _請貼上後台該則 AI 回覆_ | _是／否_ | _是／否_ |

- **是否命中 safe_confirm_template**：在後台該聯絡人「AI Log」中，該則回覆的 `tools_called` 是否含 `safe_confirm_template`，或 `result_summary` 是否為對應模板 category。
- **是否無承諾性字眼**：回覆中不得出現「我們會為您退款」「我們會負責」「是我們的疏失」等認責或承諾用語。

---

## 圖片型私訊簡短驗收（四則各跑一次）

請在測試環境依序執行下列四種情境，記錄實際回覆與是否符合預期。

| # | 情境 | 操作 | 預期 | 實際回覆（節錄） | 是否符合 |
|---|------|------|------|------------------|----------|
| 1 | **圖片 only** | 傳送一則純圖片（無文字） | 回覆 IMAGE_DM_GENERIC（通用補充版），要求補充類型與訂單／商品／手機；不進 Vision | _填寫_ | _是／否_ |
| 2 | **圖片＋短文字** | 先傳一圖，再傳「幫我看」或「這個怎麼辦」 | 回覆補充模板（通用或依 hint）；result_summary 含 `image_short_caption \| <模板名>`；不進一般 AI | _填寫_ | _是／否_ |
| 3 | **圖片＋明確他平台文字** | 先傳一圖，再傳「我在蝦皮買的怎麼還沒到」 | 對文字跑 classifier → external_platform；回覆他平台訂單安全確認（reply_private）；result_summary 含 `safe_confirm_template` 且可含 `image_clear_caption` | _填寫_ | _是／否_ |
| 4 | **圖片＋明確詐騙文字** | 先傳一圖，再傳「我被假客服騙了，對方要我轉帳」 | 對文字跑 classifier → fraud_impersonation；回覆詐騙蒐證引導；設為 awaiting_human；無承諾字眼 | _填寫_ | _是／否_ |

---

## 圖片型私訊驗收第五則：連續兩次無效圖片／補充

**目的**：確認連續無效時不再反覆補問、改為轉人工。

**操作步驟**（同一聯絡人、同一對話）：

1. 傳送**第一則純圖片**（無文字）→ 應回覆 IMAGE_DM_GENERIC（通用補充版）。
2. 再傳送**第二則純圖片**（無文字）→ 再回一次補充模板（目前 threshold=2，故第二則仍為補充）。
3. 再傳送**第三則純圖片**（無文字）→ 本次應**不再**回補充模板，改為：
   - 回覆：「**已為您轉接專人檢視，請稍候。**」
   - 聯絡人狀態標記為 **awaiting_human**
   - 有 **case notification**（待檢視／待人工）
   - AI Log 寫入：`tools_called: ["image_dm_only"]`，`result_summary: "image_only | escalated_awaiting_human"`，`transfer_triggered: true`

**替代操作**（若以「圖片＋短文字」測）：先傳一圖＋「幫我看」、再傳一圖＋「你看一下」各得一次補充，第三輪再傳圖或短文字 → 應升級為上述轉人工回覆與 log。  
（若產品需求為「第二則無效就升級」、不再補問第二次，可將 `IMAGE_SUPPLEMENT_ESCALATE_THRESHOLD` 改為 1。）

| 項目 | 預期 | 實際（請填寫） |
|------|------|----------------|
| 第三則回覆文案（或第二則若 threshold 改為 1） | 已為您轉接專人檢視，請稍候。 | _節錄_ |
| 聯絡人狀態 | awaiting_human | _是／否_ |
| case notification | 有 | _有／無_ |
| tools_called | ["image_dm_only"] | _貼上_ |
| result_summary | image_only \| escalated_awaiting_human | _貼上_ |
| transfer_triggered | true | _貼上_ |

---

## 售後 LINE 未設定時（fallback）

若該品牌／粉專尚未設定 `line_after_sale`，模板中的 `{after_sale_line_url}` 會替換為 **「請私訊官方 LINE（由客服提供）」**，不會輸出空連結。  
日誌會出現：`[SafeAfterSale] 售後 LINE 未設定（待補資料）` 並附 page_id 或 contact_id／brand_id，方便營運補設定。
