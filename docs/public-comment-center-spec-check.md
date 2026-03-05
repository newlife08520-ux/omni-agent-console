# 公開留言分流中心 — 完整盤點與 Spec-Check（上線版）

本文件依**現有程式碼與資料結構**盤點現況，不憑空假設。完成盤點後再進行實作規劃。

---

## 一、留言 Webhook / Payload 現況

### 1.1 目前實際可拿到的欄位（來源：程式碼）

**重要結論：目前專案「沒有」接上 Meta 公開留言的 Webhook。**

- **Facebook Webhook**（`POST /api/webhook/facebook`）只處理 **Page 的 messaging 事件**（私訊），程式碼僅迭代 `body.entry[].messaging`，**完全未處理** `entry.changes`（留言事件）。
- 留言進入系統的途徑只有：
  - **模擬**：`POST /api/meta-comments/simulate-webhook`（可帶類 Meta payload）
  - **手動**：`POST /api/meta-comments`、`POST /api/meta-comments/seed-test-cases`、`POST /api/meta-comments/test-mapping`

因此「目前實際可拿到的欄位」以 **simulate-webhook 與 createMetaComment 參數** 為準：

| 需求欄位 | 現況 | 備註 |
|----------|------|------|
| page_id | ✅ 有 | 寫入 meta_comments.page_id |
| page_name | ✅ 有 | 模擬/手動帶入，非從平台抓 |
| post_id | ✅ 有 | value.post_id ?? body.post_id |
| comment_id | ✅ 有 | value.comment_id \|\| value.id \|\| 產生 |
| comment message | ✅ 有 | value.message \|\| body.message |
| commenter_name | ✅ 有 | from.name \|\| body.commenter_name |
| commenter_id | ✅ 有 | from.id \|\| body.commenter_id |
| parent_comment_id | ❌ 無 | 表與 API 皆無 |
| permalink / post link | ❌ 無 | 表與 API 皆無 |
| post message / caption / title | ❌ 無 | 僅 post_name（手動/mapping），非平台抓 |
| attachment / media / product | ❌ 無 | 表與 API 皆無 |
| timestamp | ⚠️ 僅 created_at | 寫入時 server 時間，非平台 event 時間 |

### 1.2 若接上 Meta 留言 Webhook，理論上可取得（依 Meta 文件）

依 Meta Page Webhook（訂閱 comment 相關）文件，`entry.changes` 的 value 可包含：

- **comment_id**（數字字串）
- **post_id**
- **message**
- **created_time**（int32）
- **from**（id, name）
- **parent_id**（回覆時）
- **verb**（動作類型）
- 貼文標題/內文 **不會** 在 comment webhook 裡直接給，需另用 Graph API 以 `post_id` 查詢貼文（需權限 `pages_read_engagement` 等）。

結論：**要「貼文標題/內文」必須在收到 comment 後，用 Graph API 再打一次取得貼文內容（或依 post_id 查內部 mapping）。**

---

## 二、資料表 / Schema 對照需求

### 2.1 meta_comments

| 需求欄位 | 現有 | 說明 |
|----------|------|------|
| brand_id / brand_name | brand_id ✅；brand_name ❌ | 列表 API 可 JOIN 回傳 brand_name，目前單筆 GET 未強制帶 |
| page_id / page_name | ✅ | 有 |
| post_id / post_title / post_name | post_id, post_name ✅；post_title ❌ | 無獨立 post_title，僅 post_name |
| product_name / product_id | ❌ | 在 mapping 表有 product_name，留言表本身無「判定後商品」欄位 |
| primary_url / backup_url | ❌ | 在 mapping 表；留言表無 |
| target_line_channel / line_oa_id / line_type | ❌ | 全專案無「粉專→導流用 LINE 連結」設定表 |
| reply_status | ⚠️ | 用 replied_at / is_human_handled / is_hidden 推導，無獨立 reply_status 欄 |
| hidden_status | ✅ | is_hidden |
| escalation_status | ⚠️ | 用 priority + ai_suggest_human 推導，無獨立欄 |
| assigned_staff | ✅ | assigned_agent_id/name/avatar_url, assignment_method, assigned_at |
| intent / priority / sensitivity / tags | ai_intent, priority, tags ✅；sensitivity ❌ | 無獨立 sensitivity |
| auto_replied_at / auto_hidden_at / auto_routed_at | ❌ | 僅 replied_at（任何回覆都寫），無區分自動/手動時間 |
| reply_error / platform_error | ❌ | 無，失敗無法寫回 |

### 2.2 meta_post_mappings

| 需求欄位 | 現有 | 說明 |
|----------|------|------|
| brand_id, page_id, page_name, post_id, post_name | ✅ | 有 |
| product_name, primary_url, fallback_url | ✅ | 有（fallback_url） |
| target_line_channel / line_oa_id | ❌ | 無 |
| preferred_flow | ✅ | 有（product_link / activity_link / line_redirect / support_only） |

### 2.3 meta_comment_rules

| 需求欄位 | 現有 | 說明 |
|----------|------|------|
| brand_id, page_id, post_id | ✅ | 有 |
| rule_type, keyword_pattern, template_id, tag_value, priority, enabled | ✅ | 有 |
| 導哪個 LINE / 是否自動隱藏 / 是否自動回覆 | ❌ | 規則無「導哪個 LINE」；hide/to_human 有，但未接「真正執行」 |

### 2.4 brands / channels

| 需求 | 現有 | 說明 |
|------|------|------|
| 品牌名稱 | ✅ brands.name | 有 |
| 粉專→品牌 | ❌ | 無「粉專與品牌通道」表；僅 channels 為 Messenger/LINE「對話用」bot，bot_id 可對 Page ID（私訊用） |
| 一般導購 LINE / 售後 LINE | ❌ | 無欄位存「導流用 LINE URL 或 OA 代號」 |

**結論：缺少「粉專 → 品牌 → 導流用 LINE（一般/售後）」的獨立設定層與欄位；缺少留言維度的 reply_error/platform_error、商品判定結果、自動執行時間戳。**

---

## 三、自動流程現況：是否「真正執行」

| 流程 | 是否真正執行 | 卡在哪 |
|------|--------------|--------|
| 自動公開回覆 | ❌ 否 | 無呼叫 Graph API 發佈留言回覆。suggest-reply 只產 reply_first/reply_second 寫 DB；前端僅「儲存回覆」到後端 DB，未「發送到 Meta」。 |
| 自動隱藏留言 | ❌ 否 | 無呼叫 Graph API 隱藏留言。前端可標記 is_hidden=1，僅更新 DB。 |
| 自動導流 LINE | ❌ 否 | 僅在建議回覆文案中放入 LINE 話術（reply_dm_guide 等），無「導哪個 LINE」設定，也無記錄「已導流」到哪。 |
| 自動私訊 | ❌ 否 | 無呼叫 Meta 私訊 API；is_dm_sent 可被更新，但沒有實際送私訊的程式。 |
| 自動標記狀態 | ✅ 部分 | suggest-reply 會寫入 ai_intent, priority, reply_flow_type, applied_rule_id 等；replied_at 需人工「標記已回覆」或未來由「真正發送成功」後寫入。 |
| 自動指派 | ✅ 有 API | assign API 存在，但無「規則觸發自動指派」流程。 |

**卡點總結：**

1. **API**：未串接 Meta Graph API 的「回覆留言」「隱藏留言」；現有 Facebook 串接僅用於私訊（messaging）。
2. **權限 / Token**：channels 表存的是 Page Access Token（私訊用）；留言回覆/隱藏需 Page Token 且權限需含 `pages_manage_engagement`、`pages_read_engagement` 等。
3. **流程**：suggest-reply 只做「建議並寫 DB」，沒有「符合條件就呼叫平台 API 執行」的管線；也沒有 auto_reply_enabled / auto_hide_sensitive_enabled 等開關驅動「自動執行」。
4. **資料結構**：無 reply_error/platform_error，無法區分「已執行／執行失敗／未執行」。

---

## 四、需求對照與缺口整理（對應您 A～N 的檢查）

- **A. 來源辨識**：列表/詳情已有 page_id, page_name, post_id, post_name；缺「品牌名稱」常駐顯示、缺「對應商品」「判定來源」、缺 fallback 文案（未取得貼文標題時顯示「未取得貼文標題」等）。
- **B. 貼文標題**：Webhook 不會帶貼文標題；需「收到 comment 後用 post_id 打 Graph API 取貼文」或「僅依 mapping/post_name」。目前無補抓貼文 API。
- **C. 商品判定**：僅有 mapping（post→商品）；無「貼文內容關鍵字」「留言內容關鍵字」「粉專預設商品」多層邏輯，無「判定來源」欄位與顯示。
- **D. 粉專→品牌→LINE**：無獨立「粉專與品牌通道設定」表；無一般/售後 LINE、自動開關、預設模板等。
- **E. 真正自動回覆**：目前無「符合條件即呼叫 Meta API 發佈回覆」；需新增執行管線 + 開關 + 錯誤寫回。
- **F. 敏感件 SOP**：僅 guardrail 關鍵字→建議安撫+導 LINE，無「自動執行隱藏→安撫→導 LINE→標記」流程。
- **G. 收件匣戰情**：列表有基本狀態篩選，但缺首頁 KPI、缺「逾時/幾分鐘未處理」、缺統一狀態標籤（如回覆失敗、無 mapping）、詳情缺摘要區（品牌/粉專/貼文/商品/判定來源/執行結果）。
- **H. 防漏**：缺首頁 KPI 區塊、缺「回覆失敗/無 mapping/無法判定商品」篩選與不可沉底邏輯、缺 SLA/逾時提示。
- **I. 規則升級**：規則目前有關鍵字、page/post、template、to_human、hide 等，但無「導哪個 LINE」「是否啟用自動隱藏/自動回覆」等條件，且規則未驅動「真正執行」。
- **J. 模板與 mapping**：模板與 mapping 有列表與部分編輯；mapping 缺「預設導流 LINE」、留言詳情缺「反查命中 mapping/模板/導去哪個 LINE」的完整顯示。
- **K. UI 原則**：需重排資訊層級（來源最前、狀態明顯、敏感高亮、成功/失敗分開）。
- **L～N**：驗收、測試案例、風險需在實作後依上述缺口補齊。

---

## 五、實作前必須先決事項

1. **留言來源**：是否會接上 Meta 公開留言 Webhook（訂閱 comment 相關 changes）？若會，payload 解析與寫入 meta_comments 的欄位要對齊本文件 1.2；若暫不接，維持模擬/手動輸入，則上線時無法處理「真實」留言。
2. **Meta API 權限與 Token**：確認 Page Token 是否具備「回覆留言」「隱藏留言」權限；若同一 Token 兼私訊與留言，需確認權限涵蓋。
3. **貼文標題**：若採用「補抓」，需新增「依 post_id 取貼文」的後端 API 與權限；並決定 fallback（mapping 名稱 / post_id）。
4. **粉專→品牌→LINE**：新增「粉專與品牌通道」設定表與 UI，決定「一般導購 LINE」「售後 LINE」欄位格式（URL / OA ID / 僅顯示用）。
5. **自動執行開關**：在「粉專/品牌」或全域設定中新增 auto_reply_enabled、auto_hide_sensitive_enabled、auto_route_line_enabled；並在「留言入庫或定時掃描」流程中，依規則與開關呼叫 Meta API，並寫入執行結果與錯誤碼。

---

## 六、建議實作階段（不先改畫面，先做 spec-check）

- **Phase 0（本文件）**：✅ 完成盤點與 spec-check。
- **Phase 1**：資料與 API 基礎  
  - 新增/擴充：留言表 reply_error、platform_error、product_resolved、product_source；貼文補抓 API；粉專→品牌→LINE 設定表與 CRUD。  
  - 商品判定多層邏輯（mapping → 貼文關鍵字 → 留言關鍵字 → 預設 → 未判定）與「判定來源」寫入。
- **Phase 2**：Meta 留言串接與執行  
  - 若接 Webhook：解析 entry.changes 寫入 meta_comments；必要時補抓貼文。  
  - 實作「回覆留言」「隱藏留言」Graph API 呼叫，並在建議流程後可觸發「真正執行」或由排程/事件觸發；寫回成功或 reply_error/platform_error。
- **Phase 3**：自動化與防漏  
  - 依規則與開關執行自動回覆/隱藏/導流；敏感件 SOP 一鍵執行；狀態機（未處理→已自動回覆/已隱藏/回覆失敗等）；首頁 KPI、篩選、逾時、異常件不可沉底。
- **Phase 4**：UI 戰情與體驗  
  - 收件匣與詳情改版（來源最前、狀態標籤、摘要區、敏感高亮、成功/失敗分開）；規則與模板/mapping 管理補齊；驗收與測試案例、風險說明。

以上為依現有程式碼與資料結構完成的**完整盤點與 spec-check**；實作時請依此文件與先決事項進行。

---

## 七、實作完成時需產出（對應您 L～N）

1. **完成狀態**：各 Phase 完成項清單。
2. **現況盤點**：本文件為基準，實作後更新「已補齊」欄位/API/流程。
3. **新增/修改的資料表與欄位**：依 Phase 1/2 列出 ALTER TABLE、新表。
4. **新增/修改的 API**：貼文補抓、粉專通道 CRUD、執行回覆/隱藏、Webhook 解析等。
5. **新增/修改的 UI 頁面**：收件匣、詳情、規則/模板/mapping、KPI、篩選。
6. **自動回覆/隱藏/導流實作方式**：呼叫哪些 Graph API、何時觸發、開關位置、錯誤寫回。
7. **外部 API 與限制**：Meta Graph API 端點、權限、rate limit、錯誤碼處理。
8. **驗收步驟**：逐步操作清單（含模擬與真實留言情境）。
9. **測試案例**：至少涵蓋您提供的 M 節（一般詢問、導購、敏感、抓不到貼文、無法判定商品、多粉專不同 LINE、API 失敗）。
10. **自我檢查/風險說明/未完成項目**：上線前檢查表、已知風險、暫不實作項。
