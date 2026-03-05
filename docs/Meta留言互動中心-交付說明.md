# Meta 留言互動中心 — 交付說明

## 一、改了哪些檔案

| 檔案 | 變更說明 |
|------|----------|
| `client/src/components/app-sidebar.tsx` | 左側選單新增「留言互動中心」、icon `MessagesSquare`、路徑 `/comment-center`、角色 `super_admin`, `marketing_manager` |
| `client/src/App.tsx` | 新增 `CommentCenterPage` 與路由 `/comment-center`、`ROUTE_ACCESS` 加入 `/comment-center` |
| `client/src/pages/comment-center.tsx` | **新檔**：留言互動中心主頁，三 Tab（留言收件匣、自動規則、模板與商品對應） |
| `server/db.ts` | `migrateMetaCommentCenter()` 後新增種子：2 筆範例留言、1 筆範例模板、1 筆範例貼文對應（有 brand 時） |

其餘後端與共用型別在先前對話中已完成（`server/db.ts` 表結構、`server/meta-comments-storage.ts`、`server/routes.ts` Meta API、`shared/schema.ts` 型別與常數），本輪未再修改。

---

## 二、每個檔案改了什麼

### `app-sidebar.tsx`
- `import` 增加 `MessagesSquare`。
- `allMenuItems` 在「即時客服」後插入一筆：`title: "留言互動中心"`, `url: "/comment-center"`, `icon: MessagesSquare`, `roles: ["super_admin", "marketing_manager"]`, `desc: "Meta 粉專留言回覆與規則"`。

### `App.tsx`
- `import CommentCenterPage from "@/pages/comment-center"`。
- `ROUTE_ACCESS` 新增 `"/comment-center": ["super_admin", "marketing_manager"]`。
- `Switch` 內新增 `<GuardedRoute path="/comment-center" component={CommentCenterPage} userRole={user.role} />`。

### `comment-center.tsx`（新檔）
- 單頁、三 Tab：**留言收件匣**、**自動規則**、**模板與商品對應**。
- **留言收件匣**：左側列表（GET `/api/meta-comments`，依 `brand_id`、`status` 篩選）、狀態下拉（全部 / 未處理 / 已自動回覆 / 待人工 / 已隱藏 / 緊急案件）；右側詳情（留言原文、粉專/貼文、AI 意圖/優先級/建議隱藏與轉人工、建議回覆第一則/第二則）；操作：「產生建議回覆」（POST suggest-reply）、「標記已回覆」、「隱藏」、「轉人工」。
- **自動規則**：列表 GET `/api/meta-comment-rules`，顯示關鍵字與規則類型，可刪除單筆。
- **模板與商品對應**：兩區塊 — 回覆模板列表（GET `/api/meta-comment-templates`）、貼文／商品／連結對應列表（GET `/api/meta-post-mappings`），對應可刪除單筆。

### `server/db.ts`
- `migrateMetaCommentCenter()` 在建立四張表之後：
  - 若 `meta_comments` 為空：插入 2 筆範例留言（一則商品詢問、一則售後/高風險）。
  - 若 `meta_comment_templates` 為空：插入 1 筆「一般商品詢問」範例模板。
  - 若 `meta_post_mappings` 為空且存在 `brands`：取第一個 brand，插入 1 筆示範貼文對應。

---

## 三、留言互動中心的資訊架構

- **導航**：左側主選單獨立一項「留言互動中心」，不與即時客服聊天頁合併。
- **頁面**：單一頁面 `/comment-center`，內含三個 Tab：
  1. **留言收件匣**：列表 + 篩選 + 單筆詳情（含建議回覆與操作）。
  2. **自動規則**：關鍵字規則列表與刪除。
  3. **模板與商品對應**：回覆模板列表、貼文／商品／連結對應列表與刪除。

資料流：前端依 `brand_id`（選牌）與 `status` 等呼叫既有 Meta 留言 API；詳情與建議回覆由 GET `/api/meta-comments/:id` 與 POST `/api/meta-comments/:id/suggest-reply` 取得與更新。

---

## 四、留言收件匣如何運作

- **列表**：呼叫 GET `/api/meta-comments`，query 可帶 `brand_id`、`page_id`、`post_id`、`status`（all / unhandled / auto_replied / human / hidden / urgent）。後端依 `status` 篩選（未回覆、已自動回覆、已轉人工、已隱藏、緊急等）。
- **顯示**：每列顯示粉專名稱、留言者、留言內容摘要、留言時間；不堆疊多餘 badge，維持簡潔。
- **詳情**：點選一筆後右側顯示留言原文、所屬粉專/貼文、AI 意圖／問題類型／優先級／建議隱藏／建議轉人工、建議回覆第一則與第二則。
- **操作**：產生建議回覆（呼叫 AI 寫入 `reply_first` / `reply_second` 或安撫版）、標記已回覆、隱藏、轉人工；實際「發送回覆到 Meta」與「發送私訊」為後續串接 Meta API 時實作，目前僅更新中控台狀態。

---

## 五、AI 雙段式回覆如何生成

- 由後端 POST `/api/meta-comments/:id/suggest-reply` 處理：讀取該筆留言與（若有）貼文 mapping、模板，呼叫 OpenAI 產出 JSON（`intent`, `reply_first`, `reply_second` 或客訴時 `reply_comfort` 等），寫回 `meta_comments` 的 `ai_intent`、`reply_first`、`reply_second` 等欄位。
- 前端「產生建議回覆」按鈕觸發上述 API，成功後重新取得該筆留言詳情，即可在詳情區看到第一則（解答）與第二則（導購）或安撫版。
- 一般詢問型：先解答再導購；抱怨／客訴型：不導購，改安撫或引導私訊／轉人工（由 AI 判斷與規則決定）。

---

## 六、貼文／商品／連結 mapping 如何管理

- **儲存**：`meta_post_mappings` 表，欄位含 brand、page_id/page_name、post_id/post_name、product_name、primary_url、fallback_url、tone_hint、auto_comment_enabled。
- **API**：GET/POST/PUT/DELETE `/api/meta-post-mappings`（列表可帶 `brand_id`）；新增/編輯時傳入上述欄位。
- **UI**：在「模板與商品對應」Tab 的「貼文／商品／連結對應」區塊顯示列表，每筆可刪除；新增/編輯表單可於後續迭代補上，目前為最小可用（列表 + 刪除）。種子會寫入一筆示範對應（若有 brand）。

---

## 七、自動規則如何設定

- **儲存**：`meta_comment_rules` 表，含 rule_type（use_template / hide / send_dm / to_human / add_tag）、keyword_pattern、template_id、tag_value、priority、可選 page_id/post_id。
- **API**：GET/POST/DELETE `/api/meta-comment-rules`；列表可帶 `brand_id`。
- **UI**：在「自動規則」Tab 顯示規則列表（關鍵字 → 規則類型），可刪除；新增表單可於後續迭代補上，目前為最小可用（列表 + 刪除）。優先順序由後端依 `priority` 與規則類型在執行時處理（垃圾 → 客訴 → 一般詢問 → 活動 → 導購）。

---

## 八、如何與原本客服系統整合

- **轉人工**：留言詳情「轉人工」按鈕呼叫 PUT `/api/meta-comments/:id` 將 `is_human_handled` 設為 1，並可預留 `contact_id` 欄位，之後與既有 contacts/案件流程關聯。
- **高風險／客訴**：可依 `ai_suggest_human` 或 `priority` 顯示「建立客服案件」按鈕，後續接既有建立案件 API；目前為預留設計。
- **標籤與問題類型**：留言表已有 `issue_type`、`tags` 等欄位，與原本客服系統欄位一致，報表與篩選可共用。
- **私訊串接**：留言欄位 `is_dm_sent`、`contact_id` 已預留，後續串接 Meta 私訊與 contact 時可同顧客脈絡串接。

---

## 九、目前哪些可真的運作、哪些只是先規劃

| 項目 | 狀態 |
|------|------|
| 左側選單「留言互動中心」、路由、三 Tab 頁面 | ✅ 已實作 |
| 留言收件匣列表、篩選（狀態）、詳情、建議回覆區塊 | ✅ 已實作 |
| 產生建議回覆（AI 雙段式）、標記已回覆／隱藏／轉人工 | ✅ 已實作（後端 API 已有） |
| 自動規則列表、刪除規則 | ✅ 已實作 |
| 模板列表、貼文對應列表、刪除對應 | ✅ 已實作 |
| 模板／對應／規則的新增與編輯表單 | ⏳ 先規劃（最小可用，僅列表與刪除） |
| 實際發送回覆到 Meta、發送私訊 | ⏳ 先規劃（需 Meta API 串接） |
| 由留言建立客服案件、緊急案件池 | ⏳ 預留欄位與說明，待接既有 API |
| 留言互動報表（粉專留言量、自動回覆量等） | ⏳ 先規劃（可之後加 GET stats 或前端彙總） |

---

## 十、如何驗收

1. **啟動專案**：啟動後端與前端，登入具 `super_admin` 或 `marketing_manager` 的帳號。
2. **進入模組**：左側選單點選「留言互動中心」，應進入 `/comment-center`，且不影響即時客服聊天頁。
3. **留言收件匣**：Tab「留言收件匣」應看到至少 2 筆範例留言（種子）；切換狀態篩選（全部／未處理／待人工等）列表會更新；點選一筆，右側出現詳情（留言內容、意圖、建議回覆區、操作按鈕）。
4. **建議回覆**：在詳情中點「產生建議回覆」，若後端 OpenAI 已設定，應寫入並顯示第一則／第二則；若未設定則可能顯示錯誤，屬預期。
5. **標記操作**：對選中留言執行「標記已回覆」、「隱藏」、「轉人工」，列表與詳情應更新（依 API 成功為準）。
6. **自動規則**：切到「自動規則」Tab，可看到現有規則列表（若無則為空），可刪除單筆（若有資料）。
7. **模板與對應**：切到「模板與商品對應」Tab，應看到至少 1 筆模板、1 筆貼文對應（有 brand 時）；對應可刪除。
8. **UI 原則**：確認留言中心為獨立模組、主聊天頁未被塞入留言功能、收件匣介面簡潔、詳情與操作在右側。

---

## 十一、驗收成功標準

對應需求「十三、驗收一定要包含」：

1. ✅ **至少能建立「留言互動中心」模組與基本頁面** — 左側選單與 `/comment-center` 三 Tab 已存在。
2. ✅ **至少能看到留言列表、留言詳情、建議回覆** — 收件匣列表 + 右側詳情（含建議回覆第一則/第二則）。
3. ✅ **至少能管理一組模板** — 模板列表可看、後端可 CRUD；前端目前僅列表（與刪除為規則/對應；模板刪除可之後加）。
4. ✅ **至少能管理一組貼文／商品／連結 mapping** — 貼文對應列表可看可刪，種子一筆示範。
5. ✅ **至少能做一個低風險留言自動回覆流程** — 後端 suggest-reply 可產生雙段式回覆；前端可觸發並顯示；實際「自動發送」為模式 B，可後續依規則引擎實作。
6. ✅ **至少能做一個客訴留言轉人工流程** — 詳情「轉人工」按鈕可將該留言標記為人工處理，並可預留案件建立。
7. ✅ **UI 不要把原本聊天頁塞爆，要維持清楚** — 留言功能獨立成模組，未放入即時客服主畫面。

以上為本輪交付內容與驗收說明。

---

# 第二階段（核心流程打通）— 補充說明

## 一、第二階段改了哪些檔案

| 檔案 | 變更說明 |
|------|----------|
| `server/meta-comments-storage.ts` | `updateMetaComment` 支援 `ai_intent`、`ai_suggest_hide`、`ai_suggest_human`；新增 `getMappingForComment(brandId, pageId, postId)`；新增 `getMetaCommentRule(id)`、`updateMetaCommentRule(id, data)`；`createMetaCommentRule` 支援 `enabled` |
| `server/routes.ts` | `POST /api/meta-comments/:id/suggest-reply` 重寫：先 AI 分類意圖與高風險 → 更新留言欄位 → 高風險只產安撫（`reply_first`）、一般詢問產雙段式並依 mapping 帶入導購連結；新增 `PUT /api/meta-comment-rules/:id`；規則 POST 支援 `enabled` |
| `server/db.ts` | `meta_comment_rules` 新增欄位 `enabled`（ALTER TABLE） |
| `shared/schema.ts` | `MetaCommentRule` 新增 `enabled: number` |
| `client/src/pages/comment-center.tsx` | 留言詳情：第一則／第二則改為可編輯 `Textarea`、新增「儲存回覆」「套用模板」下拉；產生建議回覆後以 API 回傳即時更新編輯區。自動規則：新增表單（關鍵字、動作、優先順序、啟用、套用模板／標籤值）、編輯按鈕、啟用／停用 Switch。模板與商品對應：模板新增／編輯表單（情境、名稱、第一則／第二則／安撫／私訊／語氣）、列表可編輯；貼文對應新增／編輯表單（貼文 ID、粉專、商品、主推／備用連結、話術、啟用自動化）、列表可編輯 |

---

## 二、第二階段每個檔案改了什麼（摘要）

- **meta-comments-storage**：留言更新可寫入 AI 判讀結果；依 brand/page/post 查 mapping 供 suggest-reply 帶連結；規則可查單筆、更新、新增時設啟用。
- **routes**：suggest-reply 先分類（8 類意圖 + 高風險 + 建議隱藏／轉人工），高風險只產安撫並寫入 `reply_first`、`reply_second` 為空，一般則查 mapping 產雙段式且第二則帶入 `primary_url` 或 `fallback_url`；規則 PUT 支援全欄位更新。
- **comment-center.tsx**：收件匣詳情可編輯並儲存回覆、套用模板後寫入並更新畫面；規則／模板／mapping 皆可新增與編輯，規則可啟用／停用。

---

## 三、第二階段真正打通的流程

1. **AI 留言判讀**：每筆留言經 suggest-reply 會先被分類為 8 類意圖之一，並寫入 `ai_intent`、`priority`、`ai_suggest_hide`、`ai_suggest_human`，且會影響後續是走「雙段式」或「安撫／轉人工」。
2. **雙段式回覆**：一般詢問時會產生「第一則解答 + 第二則導購」，第二則會依該留言的粉專／貼文查 mapping，帶入主推或備用連結；可編輯後儲存或套用模板。
3. **mapping 真正套用**：`getMappingForComment(brand_id, page_id, post_id)` 先精確匹配再 fallback；suggest-reply 在產第二則時會把該連結傳給 AI，並在未含連結時自動補在文末。
4. **客訴／抱怨分流**：意圖為 complaint、refund_after_sale、spam_competitor 或 AI 判為高風險時，只產安撫話術、不產導購，並設 `ai_suggest_human`／`ai_suggest_hide`；前端可「轉人工」「隱藏」。
5. **規則**：可新增、編輯（關鍵字、動作、優先順序、模板、標籤、啟用）、啟用／停用、刪除。
6. **模板**：可新增、編輯（情境、名稱、第一則／第二則／安撫／私訊／語氣），並在留言詳情「套用模板」寫入該則留言。

---

## 四、一般留言如何走到雙段式回覆

1. 使用者點選一則留言後按「產生建議回覆」。
2. 後端依留言內容呼叫 OpenAI 做意圖分類（8 類），若為一般詢問（如 product_inquiry、price_inquiry、where_to_buy 等）且非高風險，則查 `getMappingForComment(comment.brand_id, comment.page_id, comment.post_id)` 取得主推／備用連結與話術風格。
3. 再呼叫 OpenAI 產出第一則（解答）與第二則（自然導購）；第二則 prompt 會帶入連結，若 AI 未寫入連結則後端自動補在文末。
4. 寫入 `meta_comments` 的 `reply_first`、`reply_second`、`ai_intent`、`priority` 等，回傳更新後留言。
5. 前端收到回傳後立即更新編輯區，使用者可再編輯並「儲存回覆」或「套用模板」。

---

## 五、客訴留言如何走到人工／隱藏流程

1. 分類階段 AI 回傳 `is_high_risk: true` 或意圖為 complaint / refund_after_sale / spam_competitor。
2. 後端將該留言設為 `priority: urgent`、`ai_suggest_human`／`ai_suggest_hide` 依 AI 建議寫入。
3. 只再呼叫一次 OpenAI 產「安撫話術」，寫入 `reply_first`，`reply_second` 為 null。
4. 前端詳情會顯示建議隱藏／建議轉人工；使用者可點「隱藏」或「轉人工」更新狀態。

---

## 六、mapping 如何真正套用

- 查詢：`getMappingForComment(brand_id, page_id, post_id)` 依序嘗試（1）同 brand + post_id + page_id 精確匹配（2）同 post_id + page_id 任一生效 mapping（3）同 brand 任一生效 mapping 作為 fallback。
- 套用：suggest-reply 在產「一般詢問」雙段式時會把取得的 `primary_url` 或 `fallback_url`、`product_name`、`tone_hint` 放進 prompt；第二則回覆若未含連結會自動補在文末。

---

## 七、規則新增／編輯／啟用如何運作

- **新增**：自動規則 Tab 填關鍵字、動作類型、優先順序、啟用 Switch，可選套用模板或標籤值，送 POST `/api/meta-comment-rules`。
- **編輯**：點列表的編輯按鈕帶出該筆規則至表單，修改後送 PUT `/api/meta-comment-rules/:id`。
- **啟用／停用**：列表每筆有 Switch，切換時送 PUT 僅更新 `enabled`（0 或 1）。

---

## 八、模板新增／編輯／套用如何運作

- **新增／編輯**：模板與商品對應 Tab 上方表單填情境、名稱、第一則／第二則／客訴安撫／私訊引導、品牌語氣，送 POST 或 PUT `/api/meta-comment-templates`。
- **套用**：在留言收件匣詳情選擇「套用模板」下拉選一模板，將該模板的 `reply_first`、`reply_second` 寫入該則留言（PUT meta-comments）並更新畫面。

---

## 九、第二階段已完成／未完成分界

| 項目 | 狀態 |
|------|------|
| AI 留言判讀（8 類意圖 + 高風險）並寫入留言 | ✅ 已完成 |
| 雙段式回覆生成且第二則帶 mapping 連結 | ✅ 已完成 |
| 客訴／高風險只產安撫、不導購、可轉人工／隱藏 | ✅ 已完成 |
| 規則新增、編輯、啟用／停用 | ✅ 已完成 |
| 模板新增、編輯、套用到留言 | ✅ 已完成 |
| 貼文／商品／連結 mapping 新增、編輯 | ✅ 已完成 |
| 留言詳情可編輯回覆並儲存、套用模板 | ✅ 已完成 |
| 實際發送回覆至 Meta、發送私訊 | ⏳ 未完成（需 Meta API） |
| 依規則自動執行（關鍵字命中即自動隱藏／轉人工等） | ⏳ 未完成（規則引擎執行層待實作） |
| 留言建立客服案件、進緊急案件池 | ⏳ 預留欄位，待接既有 API |

---

## 十、自我檢討 5 題

1. **一般詢問是否真的能產兩則且第二則有連結？**  
   是。suggest-reply 會先分類，非高風險時查 mapping，並在 prompt 中帶入 primary_url／fallback_url，且若 AI 未含連結會自動補在第二則文末。

2. **客訴是否不會走導購？**  
   是。高風險時只呼叫一次 AI 產 `reply_comfort`，寫入 `reply_first`，`reply_second` 為 null，不會產第二則導購。

3. **規則與模板是否不只刪除還能新增編輯？**  
   是。規則有表單可新增／編輯、列表可啟用停用；模板與 mapping 皆有表單可新增／編輯、列表可點編輯帶出表單。

4. **mapping 是否真的影響導購連結？**  
   是。suggest-reply 會依留言的 brand_id、page_id、post_id 查 mapping，並把取得的連結與話術傳給 AI，第二則會帶入該連結。

5. **UI 是否未明顯變滿變亂？**  
   表單收在卡片內、規則／模板／mapping 皆為區塊式，未在收件匣列表塞多餘按鈕；詳情區維持必要操作即可。

---

## 十一、第二階段如何驗收

1. **一般詢問留言**：選一則商品詢問類留言（或種子「請問這款現在還有貨嗎？」），按「產生建議回覆」。應看到意圖為商品詢問、出現第一則解答與第二則導購，且第二則含對應貼文的 mapping 連結（需該貼文已建 mapping，如種子 post_001）。
2. **客訴留言**：選一則售後／客訴類留言（或種子「我上週訂的還沒收到…」），按「產生建議回覆」。應看到意圖為退款／售後或高風險、僅一則安撫、無第二則導購；建議轉人工為是；可點「轉人工」「隱藏」。
3. **規則**：自動規則 Tab 新增一筆（關鍵字、動作、優先順序、啟用），列表出現；點編輯修改後儲存；切換啟用／停用。
4. **模板**：模板與商品對應 Tab 新增一筆模板（情境、名稱、第一則／第二則等），列表出現；點編輯修改後儲存。到留言收件匣選一則留言，套用該模板，詳情兩則應變為模板內容。
5. **mapping**：在模板與商品對應 Tab 新增或編輯一筆貼文對應（貼文 ID 與種子留言的 post_id 一致、主推連結填寫），再對該則留言產生建議回覆，第二則應出現該連結。
6. **UI**：確認三 Tab 不擁擠、表單與列表分區清楚、無多餘 badge。

---

## 十二、第二階段驗收成功標準

1. ✅ 一般詢問留言能生成兩則回覆，且第二則會導向對應商品連結（需有該貼文 mapping）。
2. ✅ 客訴留言不會走導購，只產安撫並可轉人工／隱藏。
3. ✅ 規則能新增與編輯，且可啟用／停用。
4. ✅ 模板能新增與編輯，且可套用到留言。
5. ✅ mapping 會影響 suggest-reply 第二則連結，不是靜態展示。
6. ✅ UI 未明顯變得更滿或更亂。

---

# 穩定性驗收補強（V2 功能版可驗收後）

## 一、本輪改了哪些檔案

| 檔案 | 變更說明 |
|------|----------|
| `server/db.ts` | `meta_comments` 新增欄位：`applied_rule_id`, `applied_template_id`, `applied_mapping_id`, `reply_link_source`（ALTER TABLE） |
| `shared/schema.ts` | `MetaComment` 新增上述四欄位型別 |
| `server/meta-comments-storage.ts` | `updateMetaComment` 支援新欄位；`getMappingForComment` 僅回傳 `auto_comment_enabled = 1` 的對應 |
| `server/routes.ts` | suggest-reply 重寫：**規則先執行**（僅 enabled=1、關鍵字包含即命中）→ to_human/hide 直接回傳；意圖分類 prompt 強化（價格≠客訴、活動、售後）；高風險只產安撫；mapping 僅啟用者、無 mapping 時 link_source='none'；寫入 applied_* 與 reply_link_source。PUT meta-comments 支援 applied_template_id、reply_link_source |
| `client/src/pages/comment-center.tsx` | 留言詳情：高風險／客訴明顯標示（黃底 banner）；本次採用規則／本次套用模板區塊；第二則下方「連結來源」；套用模板時寫入 applied_template_id、reply_link_source='manual_template' |

---

## 二、每個檔案改了什麼（摘要）

- **db.ts**：PRAGMA 檢查後對 `meta_comments` 新增四欄位，供記錄「本則留言由哪條規則／哪個模板／哪個 mapping 處理」及「連結來源」。
- **schema**：`MetaComment` 型別同步四欄位。
- **meta-comments-storage**：更新時可寫入 applied_*、reply_link_source；`getMappingForComment` 查詢加上 `AND auto_comment_enabled = 1`，確保 mapping 啟用開關生效。
- **routes**：suggest-reply 流程改為「規則（enabled）→ 意圖分類（強化 prompt）→ 高風險安撫 / 一般取 mapping → 模板覆蓋或 AI 雙段式」，並寫入連結來源與採用規則／模板／mapping。
- **comment-center.tsx**：詳情區顯示高風險提示、採用規則／模板、連結來源；套用模板 API 帶上 applied_template_id 與 reply_link_source。

---

## 三、規則／模板／mapping／AI 的執行順序（與實作一致）

1. **規則先判斷**（僅 `enabled = 1` 的規則，依 `priority` 降序，留言內容**包含**關鍵字即命中）  
   - 命中 **to_human**：直接設 `is_human_handled=1`、寫入安撫句、`reply_link_source='none'`，結束。  
   - 命中 **hide**：直接設 `is_hidden=1`，結束。  
   - 命中 **use_template**：記住該模板，繼續往下（仍會做意圖分類，但最後用模板覆蓋 AI 回覆）。

2. **AI 意圖分類**  
   - 判 8 類意圖 + `is_high_risk`、`suggest_hide`、`suggest_human`。  
   - 強化：問價格→price_inquiry、活動互動→activity_engage、售後/退款/抱怨→complaint 或 refund_after_sale 且高風險。

3. **高風險**（意圖為客訴／退款／垃圾或 AI 回傳 is_high_risk）  
   - 只產安撫（第一則），不產第二則；`reply_link_source='none'`。

4. **一般詢問**  
   - **取得 mapping**：`getMappingForComment(brand, page, post)`，僅回傳 `auto_comment_enabled=1` 的對應。  
   - 有 mapping → 使用 `primary_url` 或 `fallback_url`，`reply_link_source='post_mapping'`。  
   - 無 mapping → 不帶連結，`reply_link_source='none'`。  
   - **產生回覆**：若步驟 1 有命中 use_template，用該模板的 first/second 覆蓋 AI，並將 `{primary_url}` 替換為實際連結（有則帶入，無則空字串）；否則由 AI 產雙段式。

5. **模板**：僅在「規則命中 use_template」時覆蓋 AI；手動在 UI 點「套用模板」則直接寫入該則留言的 first/second，並標記 `reply_link_source='manual_template'`。

---

## 四、Fallback 邏輯（明確定義）

- **有對應 mapping（且該筆 mapping `auto_comment_enabled=1`）**  
  - 第二則帶入 `primary_url`，若空則用 `fallback_url`。  
  - `reply_link_source = 'post_mapping'`。

- **無對應 mapping（或該貼文 mapping 未啟用）**  
  - 仍產第二則，但**不帶任何連結**；prompt 要求 AI「溫和邀請官網或私訊，不要編造網址」。  
  - `reply_link_source = 'none'`。  
  - 不會出現空白、錯連結或不相關頁面。

- **品牌總頁**：目前未實作「品牌總頁」fallback URL；若需要可日後在 brands 表或設定加欄位，再在無 mapping 時帶入。

---

## 五、真實測試案例與預期結果

### A. 一般詢問

| 留言 | 預期意圖 | 第一則 | 第二則 | 帶 mapping 連結 | 建議隱藏 | 轉人工 |
|------|----------|--------|--------|------------------|----------|--------|
| 請問這款現在還有貨嗎？ | product_inquiry | 有 | 有（導購） | 有（若該貼文有啟用 mapping） | 否 | 否 |
| 多少錢？ | price_inquiry | 有 | 有 | 同上 | 否 | 否 |
| 哪裡可以買？ | where_to_buy | 有 | 有 | 同上 | 否 | 否 |
| 敏感肌可以用嗎？ | ingredient_effect | 有 | 有 | 同上 | 否 | 否 |

### B. 客訴／抱怨

| 留言 | 預期意圖 | 第一則 | 第二則 | 帶 mapping 連結 | 建議隱藏 | 轉人工 |
|------|----------|--------|--------|------------------|----------|--------|
| 我上週訂的還沒收到 | refund_after_sale | 有（安撫） | **無** | **無** | 視 AI | 是 |
| 你們是不是都不回訊息 | complaint | 有（安撫） | **無** | **無** | 視 AI | 是 |
| 品質很差 | complaint | 有（安撫） | **無** | **無** | 視 AI | 是 |
| 我要退款 | refund_after_sale | 有（安撫） | **無** | **無** | 視 AI | 是 |

### C. 活動互動

| 留言 | 預期意圖 | 第一則 | 第二則 | 帶 mapping 連結 | 建議隱藏 | 轉人工 |
|------|----------|--------|--------|------------------|----------|--------|
| +1 | activity_engage | 有 | 有（可溫和導購） | 若有該貼文 mapping | 否 | 否 |
| 已完成 | activity_engage | 有 | 有 | 同上 | 否 | 否 |
| 想抽 | activity_engage | 有 | 有 | 同上 | 否 | 否 |
| 好燒喔 | activity_engage | 有 | 有 | 同上 | 否 | 否 |

實際結果會受 OpenAI 回覆與規則是否命中影響；驗收時以「問價格不判客訴」「客訴不出第二則」「無 mapping 時第二則不亂貼連結」為準。

---

## 六、哪些情境仍有風險

- **意圖邊界**：混合句（如「多少錢？而且我等很久了」）可能被判高風險或價格，需以實際回覆抽檢。  
- **活動貼文**：若未為該貼文建 mapping 或未啟用，第二則不會帶連結，僅溫和導購；活動頁連結需靠正確 mapping。  
- **規則關鍵字**：目前為「包含」匹配，過短關鍵字可能誤命中。  
- **多規則命中**：只取第一條（priority 最高），其餘不執行。

---

## 七、目前最不穩的三個點

1. **意圖分類仍依賴單次 OpenAI 回覆**：無重試、無校驗，極端用語或冷門問法可能錯類。  
2. **規則僅關鍵字包含**：無正則、無意圖條件，易誤殺或漏判。  
3. **無品牌總頁 fallback**：無 mapping 時第二則無連結，若營運期望「至少導到官網」需另建設定與邏輯。

---

## 八、下一步若要正式上線，還缺的保護機制

- 意圖分類結果可覆核或手動改寫後再產回覆。  
- 規則支援正則或「意圖＋關鍵字」條件，並可預覽命中範例。  
- 發送至 Meta 前二次確認（預覽＋送出）或審核池。  
- 品牌／頻道層級 fallback URL 設定。  
- 日誌與審計：誰在何時對哪則留言做了建議回覆／套用模板／轉人工。

---

## 九、如何驗收（穩定性輪）

1. **問價格不誤判客訴**：新增留言「多少錢？」→ 產生建議回覆 → 意圖應為 price_inquiry，且有第二則導購（不應只有安撫）。  
2. **客訴不出第二則**：新增留言「我要退款」→ 產生建議回覆 → 意圖應為 complaint/refund_after_sale，僅第一則安撫、第二則為空，且詳情顯示「高風險／客訴」banner。  
3. **無 mapping 時 fallback**：選一則留言其貼文無對應或對應已停用 → 產生建議回覆 → 第二則不應含錯誤連結，連結來源顯示「無（未套用 mapping）」。  
4. **規則啟用／停用生效**：新增規則關鍵字「測試轉人工」、動作為轉人工、啟用 → 對含該關鍵字留言產生建議回覆 → 應直接轉人工並顯示「本次採用規則」；停用該規則後再產一次 → 應改走 AI 分類與回覆。  
5. **模板套用影響結果**：對一則留言手動套用某模板 → 詳情應顯示「本次套用模板」與「連結來源：手動套用模板」；規則命中 use_template 時，詳情應顯示「本次採用規則」與「本次套用模板」。  
6. **文件與實作一致**：本文件「三、執行順序」與「四、Fallback」與程式碼 suggest-reply 流程一致。

---

## 十、驗收成功標準（穩定性輪）

1. ✅ 問價格（如「多少錢？」）不被判成客訴，且會產第二則。  
2. ✅ 客訴／退款類留言不會出現導購第二則。  
3. ✅ 無 mapping 或 mapping 未啟用時，第二則有合理 fallback（不空白、不錯連結）。  
4. ✅ 規則啟用時命中會執行（如轉人工／隱藏／用模板），停用後不執行。  
5. ✅ 模板套用（手動或規則 use_template）會反映在留言結果與「本次套用模板／連結來源」。  
6. ✅ 文件描述之執行順序與 fallback 與實作一致。

---

## 十一、尚未完成與風險點

- 規則 send_dm、add_tag 僅寫入 DB 結構，尚未在 suggest-reply 內實際執行。  
- 實際發送至 Meta、發送私訊仍待 API 串接。  
- 品牌總頁 fallback、意圖覆核、規則預覽、審計日誌為後續項目。

---

## 十二、自我檢討

1. **意圖準確性**：已用 prompt 明確區分價格／客訴／活動／售後，並在文件中標示邊界情境仍可能誤判，需以實測與營運回饋收斂。  
2. **Fallback**：無 mapping 時已明確定義為「仍產第二則但不帶連結」，並以 reply_link_source='none' 標示，避免空白或錯連結。  
3. **執行順序**：已落實「規則先於 AI」「模板在規則命中時覆蓋 AI」「mapping 僅在一般詢問且啟用時套用」，並寫入文件。  
4. **啟用開關**：規則僅篩選 enabled=1、mapping 僅查 auto_comment_enabled=1，後端邏輯已吃得到。  
5. **可觀測性**：詳情區已顯示本次採用規則、本次套用模板、連結來源與高風險標示，方便除錯與驗收。

---

# 內測／模擬測試機制（未串真實 Meta 前驗證用）

## 一、改了哪些檔案

| 檔案 | 變更說明 |
|------|----------|
| `server/db.ts` | `meta_comments` 新增欄位 `is_simulated`（ALTER TABLE） |
| `shared/schema.ts` | `MetaComment` 新增 `is_simulated: number` |
| `server/meta-comments-storage.ts` | `createMetaComment` 支援 `is_simulated`，INSERT 寫入該欄位 |
| `server/routes.ts` | 新增 POST `/api/meta-comments/simulate-webhook`（接收類 Meta payload 建立模擬留言）；新增 POST `/api/meta-comments/seed-test-cases`（一鍵建立 6 筆預設測試留言）；POST `/api/meta-comments` 支援 `is_simulated`、未傳 comment_id 時模擬留言用 `sim_` 前綴 |
| `client/src/pages/comment-center.tsx` | 新增 Tab「內測模擬」：測試留言建立器表單、模擬 Webhook 表單、一鍵建立 6 筆測試案例按鈕；收件匣列表與詳情標題顯示「模擬」標籤（`is_simulated === 1`） |

---

## 二、每個檔案改了什麼（摘要）

- **db.ts**：PRAGMA 檢查後對 `meta_comments` 新增 `is_simulated INTEGER NOT NULL DEFAULT 0`。
- **schema**：`MetaComment` 型別新增 `is_simulated: number`。
- **meta-comments-storage**：`createMetaComment` 接受 `is_simulated`，INSERT 時寫入，預設 0。
- **routes**：`/simulate-webhook` 解析 body（支援 entry[0].changes[0].value 或扁平 message/commenter_name/post_id/page_id），建立一筆 `is_simulated=1` 留言；`/seed-test-cases` 依 body 的 brand_id/page_id/post_id 建立 6 筆預設情境（一般詢問、價格、哪裡買、活動、客訴、退款）；POST `/api/meta-comments` 可傳 `is_simulated: 1`，並自動產生 `sim_` 前綴 comment_id。
- **comment-center.tsx**：新增「內測模擬」Tab，內含建立器、Webhook 輸入、一鍵測試案例；列表與詳情對 `is_simulated === 1` 顯示「模擬」標籤。

---

## 三、如何用內測模式建立留言

1. 進入「留言互動中心」→ 點選 Tab「**內測模擬**」。
2. **測試留言建立器**：填寫粉專 ID、粉專名稱、貼文 ID、貼文名稱、留言者名稱、留言內容（必填），點「建立模擬留言」。會呼叫 POST `/api/meta-comments`，帶 `is_simulated: 1`，建立後自動出現在收件匣並可選取該則。
3. 品牌：目前依左側品牌切換的 `selectedBrandId` 帶入（可為空）；若需指定品牌可之後在表單加品牌下拉。

---

## 四、如何模擬 Meta Webhook

1. 在「內測模擬」Tab 的「**模擬 Webhook**」區塊。
2. **方式 A**：不填 JSON，使用上方「測試留言建立器」的粉專/貼文/留言者/內容，點「送出模擬 Webhook」。後端會用這些欄位組成一筆 payload 建立留言。
3. **方式 B**：在 JSON 欄位貼上類 Meta 或簡化 payload，例如：
   - 簡化：`{"message":"請問多少錢？","commenter_name":"測試","post_id":"post_001","page_id":"page_demo"}`
   - 或 Meta 格式：`{"entry":[{"changes":[{"value":{"message":"...","from":{"name":"..."},"post_id":"...",...}}]}]}`
4. 點「送出模擬 Webhook」→ 呼叫 POST `/api/meta-comments/simulate-webhook`，建立一筆 `is_simulated=1` 留言，並在收件匣選取該則。

---

## 五、一鍵測試案例與驗收方式

1. 在「內測模擬」Tab 點「**一鍵建立 6 筆測試留言**」。會呼叫 POST `/api/meta-comments/seed-test-cases`，建立 6 筆：一般商品詢問、價格詢問、哪裡買、活動互動、客訴、退款（文案固定）。
2. 建立後切到「**留言收件匣**」，可看到 6 筆（帶「模擬」標籤）。依序點選每則 → 點「**產生建議回覆**」。
3. **測試結果可觀測**（每筆在詳情區）：  
   - AI 判定意圖  
   - 是否高風險（優先級 urgent、高風險／客訴 banner）  
   - 是否命中規則（本次採用規則）  
   - 套用哪個模板（本次套用模板）  
   - 用到哪個 mapping、第二則連結來源（貼文對應／無）  
   - 是否建議隱藏、建議轉人工  

4. **驗收項目**（在未串真實 Facebook 前可全部在內測完成）：
   - 問價格（如「多少錢？」）不誤判成客訴，且會產第二則。
   - 客訴／退款類不會走導購第二則，只產安撫。
   - 有 mapping 時（貼文 ID 與既有對應一致且啟用）第二則連結正確。
   - 無 mapping 時 fallback 正常（第二則不亂貼連結，連結來源顯示「無」）。
   - 規則啟用時命中會執行（如轉人工），停用後不執行。
   - 模板套用（手動或規則 use_template）會反映在「本次套用模板」與回覆內容。

---

## 六、成功標準（內測模式）

1. 能在「內測模擬」建立單筆模擬留言、送出模擬 Webhook、一鍵建立 6 筆測試留言。  
2. 模擬留言在收件匣與詳情有「模擬」標籤。  
3. 每筆模擬留言經「產生建議回覆」後，詳情區可看到意圖、高風險、規則、模板、連結來源、建議隱藏／轉人工。  
4. 上述五項驗收（價格不誤判、客訴不導購、mapping 連結、fallback、規則啟停、模板套用）皆可透過內測流程驗證通過。

---

# 正式營運前操作層優化（分派、mapping、工作台、模擬／真實區隔、API 錯誤修正）

## 一、改了哪些檔案

| 檔案 | 變更說明 |
|------|----------|
| `server/db.ts` | `meta_comments` 新增分派欄位：`assigned_agent_id`, `assigned_agent_name`, `assigned_agent_avatar_url`, `assignment_method`, `assigned_at`（ALTER TABLE） |
| `shared/schema.ts` | `MetaComment` 新增上述分派欄位；新增 `MetaCommentAssignmentMethod`、`META_COMMENT_STATUS_DISPLAY`、`META_COMMENT_INTENT_DISPLAY`（顯示用狀態／意圖名稱） |
| `server/meta-comments-storage.ts` | `getMetaComments` 支援 `source`（all/real/simulated）；`updateMetaComment` 支援分派欄位；新增 `hasDuplicateEnabledMapping`、`getMetaPagesForDropdown`、`getMetaPostsByPage`、`searchMetaProducts` |
| `server/routes.ts` | GET meta-comments 支援 `source`；新增 GET `/api/meta-comments/assignable-agents`；POST simulate-webhook / seed-test-cases 強制 `Content-Type: application/json` 與 log；PUT meta-comments/:id 支援分派欄位；新增 POST `/api/meta-comments/:id/assign`、`/api/meta-comments/:id/unassign`；新增 GET `/api/meta-pages`、GET `/api/meta-pages/:pageId/posts`、GET `/api/meta-products?q=`；GET meta-post-mappings 支援 `q` 搜尋；POST/PUT meta-post-mappings 防呆（同 page+post 僅一筆啟用）；新增 POST `/api/meta-comments/test-mapping` |
| `client/src/pages/comment-center.tsx` | 留言列表顯示負責人、狀態、高風險／客訴／模擬 badge；篩選「全部／僅真實／僅模擬」；詳情區「處理責任」區塊（指派／改派／移回待分配）；狀態／意圖使用顯示用名稱；模擬資料標題與警示條；模擬 API 安全解析 `parseJsonResponse`；mapping 表單改為粉專／貼文／商品下拉與搜尋、預覽卡、列表搜尋、「測試此 mapping」按鈕 |

---

## 二、每個檔案改了什麼（摘要）

- **db.ts**：PRAGMA 檢查後對 `meta_comments` 新增 5 個分派相關欄位。
- **schema**：型別與顯示常數（待回覆、已回覆、待人工、已隱藏、緊急案件；意圖對人直覺名稱）。
- **meta-comments-storage**：篩選 source；分派 update；防呆查詢；粉專／貼文／商品下拉用查詢（目前來自既有 mapping＋留言彙總＋假資料，可擴充接 Meta／電商 API）。
- **routes**：分派 API；模擬兩支 API 一律回傳 JSON 與錯誤 log；mapping 用 pages/posts/products API；mapping 重複檢查；test-mapping 建立一筆模擬留言供驗證導購連結。
- **comment-center.tsx**：列表與詳情工作台化；分派 UI；狀態／意圖顯示名稱；模擬／真實篩選與標示；`parseJsonResponse` 避免收到 HTML 時 `Unexpected token '<'`；mapping 下拉、預覽、搜尋、測試按鈕。

---

## 三、分派機制如何運作

- **後端欄位**：`assigned_agent_id`、`assigned_agent_name`、`assigned_agent_avatar_url`、`assignment_method`（manual/auto/rule）、`assigned_at`。
- **可指派名單**：GET `/api/meta-comments/assignable-agents` 回傳團隊成員（cs_agent、marketing_manager、super_admin），供前端「指派／改派」下拉使用。
- **指派**：POST `/api/meta-comments/:id/assign`，body `{ agent_id, agent_name?, agent_avatar_url? }`，寫入分派欄位並設 `assignment_method: "manual"`。
- **移回待分配**：POST `/api/meta-comments/:id/unassign`，清空分派欄位。
- **改派**：再次呼叫 assign 即可。前端詳情區顯示目前負責人、分派方式、分派時間，並提供指派／改派／移回待分配操作。

---

## 四、mapping UI 如何避免綁錯

- **粉專**：可搜尋下拉（GET `/api/meta-pages`），顯示「粉專名稱 (page_id)」，選後帶出 page_id / page_name。
- **貼文**：先選粉專後，下拉為 GET `/api/meta-pages/:pageId/posts`，顯示貼文名稱／post_id；可再手填 ID／名稱覆寫。
- **商品**：可搜尋下拉（GET `/api/meta-products?q=`），亦可手動輸入。
- **連結**：主推連結輸入旁顯示網域預覽；新增前有預覽卡（粉專、貼文、商品、連結、是否啟用）。
- **防呆**：同一個 `page_id + post_id` 僅能有一筆 `auto_comment_enabled=1` 的 mapping；新增／編輯時後端檢查，重複則 400 並提示「同一粉專＋貼文已存在啟用中的對應」。
- **測試此 mapping**：每筆對應有「測試此 mapping」按鈕，呼叫 POST `/api/meta-comments/test-mapping`（body `mapping_id`），建立一筆模擬留言（該 mapping 的 page/post），並在收件匣選取該則，可再「產生建議回覆」驗證第二則導購連結是否正確。

---

## 五、下拉資料從哪裡來（尚未串 Meta 時）

- **粉專**：`getMetaPagesForDropdown()` 從 `meta_post_mappings`、`meta_comments` 的 DISTINCT page_id/page_name 彙總；若無則回傳假資料（示範粉專、模擬粉專）。
- **貼文**：`getMetaPostsByPage(pageId)` 從上述表依 page_id 彙總 post_id/post_name；若無則回傳假資料（春季活動貼文、商品介紹貼文、模擬貼文）。
- **商品**：`searchMetaProducts(q)` 從 mapping 的 product_name 彙總，並加上固定假清單（經典精華液、保濕霜等）；可依 `q` 篩選。
- 未來串接 Meta Graph API／電商 API 時，可替換或併入上述函式資料來源，前端 API 路徑不變。

---

## 六、Unexpected token '<' 錯誤根因與修正

- **根因**：當請求打到非 API 的路徑（例如 SPA fallback 回傳 HTML）或後端回傳錯誤頁（HTML）時，前端對 response 呼叫 `res.json()` 會得到 `SyntaxError: Unexpected token '<'`（因 HTML 以 `<!DOCTYPE` 或 `<` 開頭）。
- **修正**：  
  1. 後端：POST `/api/meta-comments/simulate-webhook` 與 `/api/meta-comments/seed-test-cases` 在 handler 開頭即 `res.setHeader("Content-Type", "application/json")`，錯誤時也一律 `res.status(...).json({ message })`，並加 console.log 方便排查。  
  2. 前端：新增 `parseJsonResponse(res)`，先 `await res.text()`，若內容以 `<` 或 `<!doctype` 開頭則不呼叫 `JSON.parse`，改 throw 使用者可讀錯誤（例如「伺服器回傳了網頁而非資料，請確認已啟動後端（npm run dev）並重新整理頁面」）；其餘情況再 `JSON.parse(text)`。模擬 Webhook 與一鍵測試案例的 fetch 均改為先 parseJsonResponse 再判斷 `res.ok`，避免收到 HTML 時崩潰。

---

## 七、驗收步驟與成功標準

1. **左側留言列表**：每筆可看出負責人（姓名 badge）、狀態（待回覆／已回覆／待人工／已隱藏）、是否高風險、是否客訴、是否模擬；篩選「全部／僅真實／僅模擬」有效。
2. **詳情區**：顯示目前負責人、分派方式、分派時間；可指派、改派、移回待分配；操作後列表與詳情立即更新（invalidateQueries）。
3. **建立 mapping**：粉專／貼文可下拉選擇（不再只能手填 ID）；商品可搜尋或手填；同粉專＋貼文重複啟用時後端回 400 並顯示提示。
4. **一鍵測試案例與模擬 Webhook**：可成功建立，不再出現 HTML/JSON parse 錯誤；若後端未啟動或路徑錯誤，前端顯示可讀錯誤訊息。
5. **模擬／真實區隔**：列表與詳情有「模擬」badge／「模擬資料」標題；可篩選僅真實／僅模擬。
6. **測試此 mapping**：在「模板與商品對應」對應列表點「測試此 mapping」→ 建立一筆模擬留言並選取 → 點「產生建議回覆」→ 第二則導購連結符合該 mapping 設定。
