# Phase 2 公開留言分流中心 — 完成回報

## 1. 完成狀態

- ✅ **公開留言 Webhook**：在 `POST /api/webhook/facebook` 中新增對 `entry.changes`（field=feed, verb=add）的解析，寫入 meta_comments，並執行 Phase 1 的 resolveCommentMetadata；保留 raw_webhook_payload 供除錯。
- ✅ **Meta 公開留言回覆**：實作 `replyToComment`（server/meta-facebook-comment-api.ts），呼叫 Graph API `POST /{comment-id}/comments`；成功寫回 replied_at、清除 reply_error/platform_error；失敗寫入 reply_error、platform_error 並紀錄於 meta_comment_actions。
- ✅ **Meta 隱藏留言**：實作 `hideComment`，呼叫 Graph API `POST /{comment-id}?is_hidden=true`；成功寫回 is_hidden、auto_hidden_at、清除 hide_error；失敗寫入 hide_error、platform_error 並紀錄。
- ✅ **平台執行結果與錯誤回寫**：新增 meta_comment_actions 表紀錄每次回覆/隱藏動作；meta_comments 具 reply_error、platform_error、hide_error；成功/失敗皆以平台 API 回應為準，不因 function 跑完就標成功。

---

## 2. 哪些 API 已真的串到 Meta

| 動作 | 是否真的呼叫 Meta | 說明 |
|------|-------------------|------|
| 公開留言回覆 | ✅ 是 | POST `https://graph.facebook.com/v19.0/{comment-id}/comments`，body: message + access_token |
| 隱藏留言 | ✅ 是 | POST `https://graph.facebook.com/v19.0/{comment-id}?is_hidden=true&access_token=...` |

---

## 3. 使用的 Graph API endpoint

| 用途 | Method | Endpoint | 說明 |
|------|--------|----------|------|
| 回覆留言 | POST | `/v19.0/{comment-id}/comments` | body: message, access_token |
| 隱藏留言 | POST | `/v19.0/{comment-id}?is_hidden=true&access_token=...` | 需 Page access token |

---

## 4. 需要的 token / 權限 / 環境變數

- **Token 來源**：目前使用既有 **channels** 表。同一粉專的 Page 在 channels 中以 `platform = 'messenger'`、`bot_id = page_id` 儲存，其 **access_token** 即為該 Page 的 Page Access Token。
- **權限**（依 Meta 文件）：
  - 回覆留言：需 **pages_manage_engagement** 或足以在該貼文留言的權限。
  - 隱藏留言：需 **pages_manage_engagement**，且必須使用 Page access token（使用 App token 會錯誤 210）。
- **環境變數**：無新增。沿用既有 Facebook 設定（如 fb_app_secret、FB_VERIFY_TOKEN 等）。Page token 來自後台設定的 channel。

**若缺 token 或權限**：  
- 未設定該粉專 channel 或 token 為空時，回覆/隱藏 API 會回 400，並在 DB 寫入 reply_error 或 hide_error「缺少該粉專的 Page access token」。  
- 權限不足時，平台會回錯誤碼（如 210、190 等），會寫入 reply_error/platform_error 或 hide_error/platform_error，並回傳 502。

---

## 5. 新增 / 修改的 schema / table / route / service

### 資料表

| 變更 | 說明 |
|------|------|
| **meta_comments** | 新增欄位：raw_webhook_payload (TEXT)、hide_error (TEXT) |
| **meta_comment_actions**（新表） | comment_id, action_type, executed_at, success, error_message, platform_response, executor |

### 後端檔案

| 檔案 | 變更 |
|------|------|
| server/db.ts | migrateMetaCommentPhase2()：raw_webhook_payload、hide_error、meta_comment_actions 表 |
| server/meta-facebook-comment-api.ts | **新檔**：replyToComment()、hideComment() |
| server/meta-comments-storage.ts | createMetaComment 支援 raw_webhook_payload；updateMetaComment 支援 hide_error；insertMetaCommentAction() |
| server/routes.ts | ① POST /api/webhook/facebook 內處理 entry.changes（feed 留言）② POST /api/meta-comments/:id/reply ③ POST /api/meta-comments/:id/hide |
| shared/schema.ts | MetaComment 新增 hide_error、raw_webhook_payload |

### API 路由

| 方法 | 路徑 | 說明 |
|------|------|------|
| POST | /api/webhook/facebook | 既有私訊不變；新增處理 entry.changes（feed 留言寫入 meta_comments + resolve + raw 留存） |
| POST | /api/meta-comments/:id/reply | body: { message }，呼叫 Meta 回覆 API，成功/失敗寫回 DB 並寫入 meta_comment_actions |
| POST | /api/meta-comments/:id/hide | 呼叫 Meta 隱藏 API，成功/失敗寫回 DB 並寫入 meta_comment_actions |

---

## 6. 怎麼驗收

1. **公開留言 Webhook**
   - 在 Meta App 訂閱 Page 的 **feed** 欄位，使公開留言觸發 webhook。
   - 對該粉專貼文留一則言，確認 POST /api/webhook/facebook 收到 entry.changes。
   - 確認 meta_comments 新增一筆，且 post_display_name、detected_product_*、target_line_*、raw_webhook_payload 已填（或為 fallback）；created_at 盡量為平台 created_time。

2. **公開回覆**
   - 選一則 comment_id 為「真實 Meta comment ID」的 meta_comment（可來自 webhook 或模擬時手動填真實 id）。
   - 呼叫 POST /api/meta-comments/:id/reply，body: { "message": "測試回覆" }。
   - 成功：該則留言在 Meta 貼文下出現回覆；DB replied_at 有值，reply_error/platform_error 為空；meta_comment_actions 有一筆 success=1。
   - 失敗（如 token 無權限）：DB 寫入 reply_error/platform_error；API 回 502；meta_comment_actions success=0。

3. **隱藏留言**
   - 對同一則（或另一則真實 comment_id）呼叫 POST /api/meta-comments/:id/hide。
   - 成功：該則留言在 Meta 上變為隱藏；DB is_hidden=1、auto_hidden_at 有值、hide_error 空。
   - 失敗：DB 寫入 hide_error；API 回 502；meta_comment_actions 一筆 success=0。

4. **失敗不被標成成功**
   - 故意用錯誤 token 或已刪除的 comment_id 呼叫 reply/hide，確認 DB 不會出現 replied_at 或 is_hidden=1，且必有 reply_error 或 hide_error/platform_error。

---

## 7. 測試案例

| 案例 | 步驟 | 預期 |
|------|------|------|
| Webhook 收留言 | 觸發 feed 留言 webhook（或模擬 body.entry[].changes） | meta_comments 新增一筆，raw_webhook_payload 有值，resolve 欄位已填 |
| 回覆成功 | 有 token 的粉專，POST reply，message 非空 | Meta 有回覆；DB replied_at 有值；reply_error 空；actions 一筆 success=1 |
| 回覆失敗（無 token） | 粉專無 channel 或 token 空，POST reply | 400；DB reply_error 有「缺少…token」；actions success=0 |
| 回覆失敗（權限不足） | token 缺 pages_manage_engagement，POST reply | 502；DB reply_error/platform_error 有平台錯誤；actions success=0 |
| 隱藏成功 | 有 token，POST hide | Meta 留言隱藏；DB is_hidden=1、hide_error 空；actions success=1 |
| 隱藏失敗 | 無 token 或權限不足，POST hide | 400/502；DB hide_error 有值；actions success=0 |

---

## 8. 目前還卡哪些外部限制

- **Webhook 訂閱**：需在 Meta 後台為 App 訂閱 Page 的 **feed**（或對應欄位），才會收到公開留言；僅訂閱 messaging 只會收私訊。
- **Page token 權限**：Token 須具 **pages_manage_engagement** 才能隱藏留言與回覆留言；若僅用於私訊，可能需重新授權取得權限。
- **Comment ID 格式**：回覆/隱藏使用的 comment_id 必須為 Meta 回傳的 ID（通常為數字或 `post_id_comment_id` 格式）；來自模擬的假 id 會導致平台回錯。
- **一則留言一回覆**：Meta 限制一則留言僅能有一則回覆，重複回覆會回 (#10900) Activity already replied to。

---

## 9. 自我檢查

- [x] 公開留言僅在 entry.changes（field=feed, verb=add）處理，不影響 entry.messaging 私訊流程。
- [x] 回覆/隱藏皆以平台 API 回應為準，成功才寫 replied_at / is_hidden。
- [x] 失敗必寫 reply_error 或 hide_error/platform_error，並寫入 meta_comment_actions。
- [x] Token 取自 channels（getChannelByBotId(page_id)），缺 token 時回 400 並寫入錯誤欄位。
- [x] Webhook 寫入時呼叫 resolveCommentMetadata，並寫入 raw_webhook_payload。

---

## 10. 下一輪建議（Phase 3）

- **自動執行**：依 meta_page_settings 的 auto_reply_enabled、auto_hide_sensitive 等，在留言入庫或排程中自動觸發回覆/隱藏（呼叫現有 replyToComment、hideComment），並區分 auto_replied_at / 手動 replied_at。
- **敏感件 SOP**：串接「隱藏 → 安撫 → 導 LINE」一鍵或自動流程，並寫入對應狀態與 actions。
- **防漏與狀態**：回覆失敗/隱藏失敗在收件匣篩選與狀態標籤中可辨識，不沉底。
- **UI**：收件匣可顯示「已回覆/回覆失敗/已隱藏/隱藏失敗」、操作「發佈回覆」「隱藏留言」按鈕呼叫現有 API。
