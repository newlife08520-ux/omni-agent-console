# Phase 3 留言中心：規則自動執行、敏感件 SOP、防漏與戰情摘要

## 1. 完成狀態

- **A. 規則命中後自動執行**：已接上。留言建立後（Webhook / 模擬 / 一鍵測試）會跑 `runAutoExecution`，依規則與粉專開關執行：自動公開回覆、自動隱藏、導向 LINE 寫入、標記待人工。
- **B. 敏感／客訴 SOP**：已定義並執行。Guardrail 關鍵字或規則命中後，依 `auto_hide_sensitive` / `auto_reply_enabled` 執行：可先公開安撫再隱藏、寫入售後 LINE、優先級 urgent、標記待人工。
- **C. 開關與防重複**：使用既有 `meta_page_settings`（auto_reply_enabled、auto_hide_sensitive、auto_route_line_enabled）；以 `auto_execution_run_at` 做 idempotency，同一則只跑一次自動流程。
- **D. 主狀態**：新增 `main_status` 欄位與 `computeMainStatus()`，reply/hide API 與自動流程會更新；列表與單筆回傳皆帶主狀態。
- **E. 防漏**：篩選支援未處理、敏感、待人工、執行失敗、無 mapping、未判定商品、已完成；失敗件不會被標成完成；摘要含逾時筆數。
- **F. 戰情摘要**：`GET /api/meta-comments/summary`，前端收件匣上方顯示未處理／敏感／待人工／失敗／已完成／逾時。

---

## 2. 規則如何接上自動執行

- **觸發點**：留言寫入 `meta_comments` 後（FB Webhook `entry.changes`、`POST /api/meta-comments/simulate-webhook`、`POST /api/meta-comments/seed-test-cases`）以 `setImmediate` 非同步呼叫 `runAutoExecution(commentId)`，不阻塞回應。
- **流程**：
  1. **僅規則分類（不呼叫 AI）**：先 guardrail（客訴/退款關鍵字）→ 再 line_redirect 關鍵字 → 再一般規則（keyword_pattern 包含即命中，依 priority 降序）。寫入 `ai_intent`、`reply_first`/`reply_second`、`applied_rule_id`、`reply_flow_type`、必要時 `is_human_handled`。
  2. **解析 metadata**：`resolveCommentMetadata`（商品、導向 LINE）；敏感時用 `after_sale` LINE。
  3. **佔用防重複**：`tryClaimAutoExecution(id)`（`UPDATE meta_comments SET auto_execution_run_at = now WHERE id = ? AND auto_execution_run_at IS NULL`）。僅成功佔到才執行平台動作。
  4. **執行**：
     - **敏感／客訴**（guardrail 或 to_human 規則）：若 `auto_hide_sensitive`，可先 `auto_reply_enabled` 時發安撫再呼叫 hide API；寫入 target_line（售後）、priority=urgent、is_human_handled=1。
     - **規則 hide**：若 `auto_hide_sensitive`，呼叫 hide API。
     - **規則 use_template / line_redirect**：若 `auto_reply_enabled` 且有 `reply_first`，呼叫 reply API。
  5. 依執行結果更新 `main_status`（見下）。

---

## 3. 敏感件 SOP 如何定義

- **條件**：以下任一視為敏感／客訴，走 SOP：
  - Guardrail 命中（`meta-comment-guardrail` 內退款/客訴/物流/品質關鍵字）
  - 一般規則 `rule_type === "to_human"`
  - 已有 `priority === "urgent"` 或 `ai_suggest_human === 1`
  - `ai_intent` 為 `complaint` 或 `refund_after_sale`
- **粉專開關**：`meta_page_settings.auto_hide_sensitive`、`auto_reply_enabled`。導向 LINE 取自同表 `line_after_sale`（敏感時）／`line_general`。
- **SOP 步驟**：
  1. 若 `auto_reply_enabled` 且有安撫內容：先呼叫 **公開回覆**（安撫句）。
  2. 若 `auto_hide_sensitive`：呼叫 **隱藏** API。
  3. 寫入 **target_line_type=after_sale**、**target_line_value**（來自粉專設定）。
  4. **priority=urgent**、**is_human_handled=1**。
- **僅導 LINE、不自動公開**：當規則為「只導 LINE」且未命中需安撫的敏感規則時，只寫入 target_line 與狀態，不發公開回覆（除非另有 use_template 且開關允許）。
- **直接待人工**：規則 `to_human` 只標記 `is_human_handled=1` 與安撫文，不強制 hide（hide 由敏感 SOP 與 hide 規則決定）。

---

## 4. 主狀態如何設計

- **欄位**：`meta_comments.main_status`（TEXT，可 NULL；舊資料為 NULL 時由 API 以 `computeMainStatus()` 推算回傳）。
- **枚舉**（`MetaCommentMainStatus`）：  
  `unhandled` | `pending_send` | `auto_replied` | `human_replied` | `hidden` | `routed_line` | `to_human` | `completed` | `failed` | `partial_success`
- **推算邏輯**（`computeMainStatus`）：
  - 有 `reply_error` 或 `hide_error` → 若已有 replied 或 hidden 則 `partial_success`，否則 `failed`。
  - `is_hidden === 1` → `hidden`。
  - `is_human_handled && replied_at` → `human_replied`。
  - 有 `replied_at` → `auto_replied`。
  - `is_human_handled` → `to_human`。
  - 有 target_line 或 reply_flow_type 為 line_redirect/comfort_line → `routed_line`。
  - 有 reply_first/second 但未 replied → `pending_send`。
  - 否則 → `unhandled`。
- **寫入時機**：`runAutoExecution` 結束時、`POST .../reply` / `POST .../hide` 成功或失敗時、`PUT .../meta-comments/:id` 可帶 `main_status`（如「標記已完成」設為 `completed`）。

---

## 5. 如何避免重複執行

- **Idempotency**：`meta_comments.auto_execution_run_at`。  
  `tryClaimAutoExecution(id)` 僅在 `auto_execution_run_at IS NULL` 時寫入當前時間；若已被寫入（本次或前次請求），`changes === 0`，不再執行任何平台動作。
- **執行前檢查**：
  - 公開回覆前：`comment.replied_at` 為空才呼叫 reply API。
  - 隱藏前：`comment.is_hidden !== 1` 才呼叫 hide API。
- **Webhook 去重**：既有 `storage.isEventProcessed(eventId)` / `markEventProcessed` 仍用於同一則 FB 留言事件不重複寫入；寫入後僅觸發一次 `runAutoExecution`。

---

## 6. 新增／修改的 schema、route、service

| 項目 | 說明 |
|------|------|
| **DB** | `meta_comments.main_status`（TEXT）、`meta_comments.auto_execution_run_at`（TEXT）；Phase 3 migration 在 `db.ts`。 |
| **shared/schema.ts** | `MetaComment.main_status`、`MetaComment.auto_execution_run_at`；新增 `MetaCommentMainStatus` 型別。 |
| **meta-comments-storage.ts** | `updateMetaComment` 支援 `main_status`、`auto_execution_run_at`；`tryClaimAutoExecution(commentId)`；`getMetaComments` 支援 status：failed、sensitive、to_human、no_mapping、no_product、completed；新增 `getMetaCommentsSummary()`、`MetaCommentStatusFilter`。 |
| **meta-comment-auto-execute.ts**（新檔） | `runAutoExecution(id)`、`computeMainStatus(c)`；規則分類、解析 metadata、佔用、執行 reply/hide、更新 main_status。 |
| **routes.ts** | 引入 `runAutoExecution`、`computeMainStatus`；FB Webhook / simulate-webhook / seed-test-cases 建立留言後呼叫 `runAutoExecution`；`GET /api/meta-comments/summary`；`GET /api/meta-comments` 支援新 status、回傳補算 main_status；`PUT /api/meta-comments/:id` 可寫入 main_status；`POST .../reply`、`POST .../hide` 成功/失敗後更新 main_status。 |

---

## 7. 防漏 API／查詢能力

- **列表篩選**：`GET /api/meta-comments?status=`  
  `unhandled` | `auto_replied` | `human` | `hidden` | `urgent` | `failed` | `sensitive` | `to_human` | `no_mapping` | `no_product` | `completed`
- **戰情摘要**：`GET /api/meta-comments/summary?brand_id=`  
  回傳：`unhandled`、`sensitive`、`to_human`、`failed`、`completed`、`overdue`、`default_reply_minutes`。
- **失敗件**：`reply_error` / `hide_error` 有值時，`main_status` 為 `failed` 或 `partial_success`，且會落在 status=`failed` 篩選結果中，不會被當成完成。

---

## 8. 驗收步驟

1. **一般詢問**：建立一則命中「use_template」規則的留言（或一鍵測試一般詢問），粉專 `auto_reply_enabled=1` → 應自動公開回覆、main_status 為 auto_replied；再建一則同則不應重複回覆（auto_execution_run_at 已寫入）。
2. **敏感／客訴**：建立「我要退款」或「都不回訊息」等 guardrail 留言，粉專 `auto_hide_sensitive=1`、必要時 `auto_reply_enabled=1` → 應先安撫（若開）再隱藏、導向售後 LINE、priority=urgent、to_human；主狀態為 hidden 或 human_replied。
3. **導購型**：命中 line_redirect 或 use_template 且為導商品/LINE → 應寫入 target_line 或回覆內容，狀態為 auto_replied / routed_line。
4. **API 失敗**：人為讓 reply 或 hide 失敗（如錯誤 token）→ main_status 應為 failed 或 partial_success；列表篩選 status=failed 可撈到該則。
5. **防重複**：同一則留言（同一 comment_id）因 webhook 重送或手動重試，僅第一次應執行平台動作；之後 runAutoExecution 因已佔用而不執行。

---

## 9. 測試案例建議

- 規則：關鍵字「退款」→ to_human；關鍵字「多少錢」→ use_template 某模板；關鍵字「爛透了」→ hide。
- 粉專設定：auto_reply_enabled=1、auto_hide_sensitive=1、line_after_sale 有 URL。
- 案例 1：留言「我要退款」→ 預期：安撫文 + 隱藏 + 售後 LINE + to_human + main_status 正確。
- 案例 2：留言「多少錢」→ 預期：模板回覆送出、main_status=auto_replied。
- 案例 3：留言「爛透了」→ 預期：隱藏、main_status=hidden。
- 案例 4：同一則再觸發 runAutoExecution（或重送 webhook）→ 預期：不再 reply/hide。

---

## 10. 自我檢查與風險

- **風險**：自動執行依賴粉專 Page access token；token 過期或未設定時會寫入 reply_error/hide_error 與 main_status=failed，需由客服從「執行失敗」篩出處理。
- **限制**：目前自動流程僅「規則」分類，未在 pipeline 內呼叫 AI；未命中規則的留言維持未處理，可之後手動「產生建議回覆」或未來接排程/佇列跑 AI 再執行。
- **逾時**：摘要內 `overdue` 以「建立超過 default_reply_minutes（30）且主狀態仍為未處理/待人工/失敗等」計算；僅為最小 SLA 提示，未含通知或升級。

---

## 11. 下一輪建議（Phase 4）

- 排程或佇列：對「未處理」且未跑過 AI 的留言，非同步呼叫分類＋建議回覆，再依開關決定是否自動執行。
- 敏感件 SOP 開關獨立：例如 `sensitive_sop_enabled` 與 `auto_hide_sensitive` 分離，或依品牌設定不同 SOP。
- 單則「快速切換導向」：在詳情頁可改 target_line_type / target_line_value 並寫回，不必只靠粉專設定。
- 通知與升級：逾時或失敗件達條件時發通知或建立待辦給客服。
