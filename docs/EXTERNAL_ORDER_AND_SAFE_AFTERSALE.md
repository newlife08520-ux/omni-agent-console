# 外部訂單／非本店／待確認訂單與安全售後

## 一、目標

- **不確定是否本店／他平台／詐騙情境**：先走「安全確認」流程，**不要過早承認責任**。
- 平台關鍵字、詐騙／冒用關鍵字、訂單問題但來源不明時，一律用安全確認型模板，不套標準售後承諾。
- **留言與私訊共用同一套判定**，僅行為依通道不同（留言：可隱藏+導 LINE；私訊：不隱藏、回覆安全模板）。

---

## 二、共用判定邏輯（留言與私訊皆用）

判定集中於 **`server/safe-after-sale-classifier.ts`**，由以下使用端呼叫：

- **公開留言**：`meta-comment-guardrail.ts` 的 `checkSafeConfirmByRule()`（內部呼叫 `classifyMessageForSafeAfterSale`）、`meta-comment-auto-execute.ts`、`routes.ts` suggest-reply。
- **私訊（Facebook/IG/LINE 等）**：`routes.ts` 的 contact 自動回覆流程（`classifyMessageForSafeAfterSale(userMessage)`）。

**不要留言一套、私訊一套**；關鍵字與優先順序皆以此模組為準。

### 2-1. 平台關鍵字

命中時視為**他平台訂單或待確認來源**，走安全確認／導正方向，不直接承諾售後。

- 蝦皮、淘寶、momo、pchome、露天、yahoo購物、yahoo、amazon、博客來、東森、康是美、屈臣氏  
- 常數：`PLATFORM_KEYWORDS`（`server/safe-after-sale-classifier.ts`）

### 2-2. 詐騙／冒用關鍵字

命中時走**蒐證引導**，不承認責任；留言建議 **hide + route_line + to_human**；私訊建議 **to_human**。

- 詐騙、冒用、假客服、匯款、轉帳、驗證碼、連結、付款後沒下文、被騙、盜用、假官方、騙錢、詐欺  
- 常數：`FRAUD_IMPERSONATION_KEYWORDS`（同上）

### 2-3. 訂單問題但來源不明

內容含**訂單／售後相關關鍵字**，且**沒有「本店」提示**時，先走待確認訂單來源，不直接承諾退款／換貨。

- 訂單、退款、退貨、沒收到、漏寄、改地址、發票、扣款、品質、瑕疵、過敏、客服不回  
- 本店提示（任一出現則不走待確認）：官網、官方、官網下單、官方通路、你們家、你們官網  
- 常數：`ORDER_SOURCE_AMBIGUOUS_KEYWORDS`、`OUR_STORE_HINTS`（同上）

---

## 三、規則類型／分類（對應 intent 與模板）

| 分流結果 type | ai_intent | 模板 category | 說明 |
|---------------|-----------|----------------|------|
| fraud_impersonation | fraud_impersonation | fraud_impersonation | 疑似詐騙／冒用，蒐證引導 |
| external_platform | external_or_unknown_order | external_platform_order | 他平台訂單，導正方向 |
| safe_confirm_order | external_or_unknown_order | safe_confirm_order | 待確認訂單來源（通用） |

系統會依 `type` 選用對應模板，並替換 `{after_sale_line_url}` 為粉專設定的售後 LINE。

---

## 四、命中時的動作

### 非本店／待確認來源（safe_confirm_order / external_platform）

- **reply** = yes（使用安全確認模板）
- **hide** = 視情況（情緒大、客訴感強、公開風險高可設為建議隱藏）
- **route_line** = yes（`reply_flow_type: comfort_line`，解析後導售後 LINE）
- **route_line_type** = after_sale
- **to_human** = 視需要（external_platform 預設不強制；safe_confirm_order 預設不強制）
- **template** = 對應安全確認／他平台模板

### 他平台訂單明確命中（external_platform）

- **reply** = yes  
- **hide** = 視情況  
- **route_line** = yes（可選，導正方向為主）  
- **template** = 他平台訂單｜導正方向

### 詐騙／冒用（fraud_impersonation）

- **reply** = yes  
- **hide** = yes（建議）  
- **route_line** = yes，route_line_type = after_sale  
- **to_human** = yes  
- **template** = 疑似詐騙／冒用｜蒐證引導  

---

## 五、留言 vs 私訊行為（共用判定、分開處理）

### A. 公開留言

- **純負評／純亂入** → 可隱藏。
- **售後／訂單問題**（且非安全確認命中）→ 安撫 + 隱藏 + 導 LINE。
- **非本店／他平台／詐騙**（安全確認命中）→ 使用安全確認模板，不先承認責任；必要時隱藏 + 導 LINE。

### B. 私訊

- 私訊**不隱藏**，但套用**同一套**安全確認判定。
- **非本店／他平台／待確認來源** → 不直接當標準售後承諾；改用安全確認型模板（私訊版 `reply_private`），引導提供官方通路訂單資訊。
- **詐騙／冒用** → 不承認責任；引導提供截圖／證據；視需要轉人工（`suggest_human` 時設為 awaiting_human）。
- **一般售後／一般詢問** → 正常售後流程或正常 AI 回覆。

---

## 六、安全確認型模板（留言版 + 私訊版）

以下模板已寫入 `meta_comment_templates`。  
- **留言**：使用 `reply_first`、`reply_second`，佔位符 `{after_sale_line_url}` 替換為粉專售後 LINE。  
- **私訊**：使用 `reply_private`（私訊版文案，語氣可較直接）；若無則 fallback `reply_first`。

| category | 名稱 | 適用情境 |
|----------|------|----------|
| safe_confirm_order | 待確認訂單來源｜安全確認（通用） | 訂單／售後問題，但不確定是否本店或可能他平台 |
| safe_confirm_emotional | 待確認訂單來源｜情緒客訴版 | 對方情緒大、說你們不回，但來源尚未確認（可手動或規則選用） |
| external_platform_order | 他平台訂單｜導正方向 | 明確提到蝦皮／淘寶／momo 等平台 |
| fraud_impersonation | 疑似詐騙／冒用｜蒐證引導 | 對方說被詐騙、假客服、冒用、付款後沒下文等 |

---

## 七、哪些情況不應先承認責任

- 留言提到**他平台**（蝦皮、淘寶等）→ 不承諾「我們會為您處理出貨／退款」，改為導正到該平台或請其提供官方訂單資訊。  
- 留言提到**詐騙／冒用／假客服**→ 不承認是己方責任，改為蒐證引導（截圖、付款證明、對方帳號）並建議報警／通知平台。  
- **僅提到退款／訂單／沒收到**且無官網／官方等本店提示 → 不直接承諾退款／換貨，先走「請提供訂單編號／是否官方通路」安全確認。

---

## 八、敏感件未隱藏成功時不得算完成

已實作防呆：若為**敏感件**（`ai_suggest_hide === 1` 或 `matched_rule_bucket === 'hide_and_route'`），且**最終未隱藏**（`is_hidden !== 1`），則**不**將主狀態設為 `auto_replied`，改為 `routed_line`（或依邏輯保留在例外列表），以便人工追蹤。  
邏輯位置：`computeMainStatus`（`server/meta-comment-auto-execute.ts`）。

---

## 九、驗收案例（留言 + 私訊分開）

### 留言驗收

| # | 情境 | 範例 | 預期 |
|---|------|------|------|
| 1 | 他平台訂單留言 | 「我在蝦皮買的怎麼還沒到」 | 不走標準售後承諾；使用安全確認／導正方向模板；可導 LINE |
| 2 | 詐騙情境留言 | 「我被你們客服詐騙了」 | 不承認責任；蒐證引導模板；建議 hide + route_line；保留例外或待人工 |
| 3 | 待確認來源留言 | 「我要退款」（無本店來源提示） | 先安全確認，不直接承諾退款；視情況導售後 LINE |

### 私訊驗收

| # | 情境 | 範例 | 預期 |
|---|------|------|------|
| 4 | 他平台訂單私訊 | 「我在蝦皮買的怎麼還沒到」 | 走安全確認型回覆（reply_private）；不承諾本店售後 |
| 5 | 詐騙／冒用私訊 | 「我被假客服騙了」 | 安全確認模板；不承認責任；建議轉人工（awaiting_human） |
| 6 | 找不到訂單的私訊 | 「查不到我的訂單」（無官網等本店提示） | 先安全確認、不直接承諾退款；引導提供訂單資訊或確認是否官方通路 |

### 共通

- 留言與私訊**共用同一套**關鍵字與判定（`safe-after-sale-classifier`）；僅行為依通道不同（留言可隱藏+導 LINE，私訊不隱藏、回安全模板）。
- 本店正常售後（例：「我上週官網下單的還沒收到」）→ 有官網提示，不走待確認，走原售後流程。

詳細顯示邏輯見 `docs/INBOX_DISPLAY_RULES.md`；商品判定與安全降級見 `docs/PRODUCT_DETECTION_AND_SAFETY.md`。

---

## 十、目前哪些已涵蓋私訊、哪些僅留言

| 項目 | 留言 | 私訊 |
|------|------|------|
| 共用判定（平台／詐騙／待確認來源） | ✅ 使用 `safe-after-sale-classifier` | ✅ 使用 `safe-after-sale-classifier` |
| 安全確認模板（第一則／第二則） | ✅ reply_first / reply_second | ✅ reply_private（或 fallback reply_first） |
| 隱藏 | ✅ 依規則／建議 | ❌ 不適用（私訊無隱藏） |
| 導 LINE | ✅ comfort_line / after_sale | ❌ 私訊即為一對一，以模板內引導為主 |
| 轉人工 | ✅ ai_suggest_human | ✅ suggest_human 時設 awaiting_human |
| 建議回覆 API（suggest-reply） | ✅ 含 Step 0a 安全確認 | — |
| 自動執行（auto-execute） | ✅ 含安全確認分支 | — |
| Contact 自動回覆 | — | ✅ 命中安全確認時直接回傳模板、不進一般 OpenAI |

---

## 十一、粉專未設定售後 LINE 時之 fallback（防呆 1）

當 `meta_page_settings.line_after_sale` 為空或未設定時：

- **不輸出空連結**：模板內 `{after_sale_line_url}` 會替換為固定安全文案，而非空白。
- **Fallback 文案**：`FALLBACK_AFTER_SALE_LINE_LABEL` = 「請私訊官方 LINE（由客服提供）」  
  - 常數定義：`server/safe-after-sale-classifier.ts`  
  - 留言（auto-execute、suggest-reply）與私訊（contact 自動回覆）皆使用同一 fallback。
- **日誌／營運標記**：使用 fallback 時會寫入 console：  
  `[SafeAfterSale] 售後 LINE 未設定（待補資料）` 並附 `page_id` 或 `brand_id` / `contact_id`，方便營運補設定。

---

## 十二、私訊回覆入口與 classifier 執行狀況（防呆 2）

目標：**任何私訊只要命中「外部訂單／平台／詐騙／待確認來源」，都先走安全確認模板，不進標準售後承諾或一般 AI 流程。**

| 入口 | 路徑／觸發 | 回覆前是否呼叫 classifyMessageForSafeAfterSale | 備註 |
|------|------------|--------------------------------------------------|------|
| LINE 文字訊息 | `POST /api/webhook/line` → `autoReplyWithAI(contact, mergedText, ...)` | ✅ 是 | 在 `autoReplyWithAI` 開頭、高風險偵測之後立即執行 |
| Messenger 文字訊息 | `POST /api/webhook/messenger`（或 FB 對應 endpoint）→ `autoReplyWithAI(contact, mergedText, ...)` | ✅ 是 | 同上，同一函式 |
| 聯絡人僅傳圖片（無文字） | LINE / Messenger 圖片 → 安全中性模板回覆 | ✅ 防呆已補 | 不進 Vision／一般 AI；回覆 `SAFE_IMAGE_ONLY_REPLY`，請對方補充文字與訂單資訊，避免誤承諾 |
| 管理員代發訊息 | `POST /api/contacts/:id/messages`（後台代發） | ❌ 不適用 | 為人工發送，非 AI 回覆入口 |

結論：目前**所有會產生「AI 自動回覆」的私訊入口**（LINE 文字、Messenger 文字）皆在回覆前執行 `classifyMessageForSafeAfterSale`，命中即走安全確認模板；**圖片型私訊**見下節。

---

## 十三、圖片型私訊：哪條邏輯、哪些只回補充、哪些套安全確認

- **僅圖片、無文字**：不進 Vision／一般售後；回 **IMAGE_DM_GENERIC**（通用補充版），要求補充類型與訂單／商品／手機等資訊。
- **圖片＋極短／模糊文字**（如「幫我看」「這個怎麼辦」「是不是被騙」）：不當已確認情境；回 **getImageDmReplyForShortCaption(text)** 選一則補充模板（通用／訂單物流／詐騙付款／商品問題），不進一般 AI。
- **圖片＋明確文字**：對文字跑 **classifyMessageForSafeAfterSale**；命中則套既有安全確認模板（他平台／詐騙／待確認訂單）；未命中則可進一般訂單查詢／售後。

新增常數（`server/safe-after-sale-classifier.ts`）：**IMAGE_DM_GENERIC**、**IMAGE_DM_ORDER_SHIPPING**、**IMAGE_DM_FRAUD_PAYMENT**、**IMAGE_DM_PRODUCT_ISSUE**。詳見 `docs/DM_ACCEPTANCE_STEPS.md`。
