# Phase 1 公開留言分流中心 — 完成回報

## 1. 完成狀態

- ✅ 新增「粉專 → 品牌 → 導流 LINE」設定表與 CRUD API
- ✅ 留言表補齊核心欄位（reply_error, platform_error, auto_*_at, detected_*, target_line_*, post_display_name, detected_post_title_source）
- ✅ 貼文標題 fallback 機制（graph_api → mapping → post_id）與判定來源寫入
- ✅ 商品判定多層邏輯（post_mapping → post_keyword → comment_keyword → page_default → none）與判定來源寫入
- ✅ 建立留言時自動跑 resolver，寫入貼文顯示名、商品、導流 LINE
- ✅ 提供「重新解析」API，可對既有留言重算並更新上述欄位

---

## 2. 新增 / 修改的資料表與欄位

### 新增表

| 表名 | 說明 |
|------|------|
| **meta_page_settings** | 粉專 → 品牌 → 導流 LINE 設定。欄位：id, page_id (UNIQUE), page_name, brand_id, line_general, line_after_sale, auto_hide_sensitive, auto_reply_enabled, auto_route_line_enabled, default_reply_template_id, default_sensitive_template_id, default_flow, default_product_name, created_at, updated_at |
| **meta_product_keywords** | 貼文/留言關鍵字 → 商品。欄位：id, brand_id, keyword, product_name, match_scope ('post' \| 'comment'), created_at |

### meta_comments 新增欄位（Phase 1 migration）

| 欄位 | 類型 | 說明 |
|------|------|------|
| reply_error | TEXT | 回覆失敗原因 |
| platform_error | TEXT | 平台/API 錯誤訊息 |
| auto_replied_at | TEXT | 自動回覆時間 |
| auto_hidden_at | TEXT | 自動隱藏時間 |
| auto_routed_at | TEXT | 自動導流時間 |
| detected_product_name | TEXT | 判定出的商品名稱 |
| detected_product_source | TEXT | 判定來源：post_mapping \| post_keyword \| comment_keyword \| page_default \| none |
| detected_post_title_source | TEXT | 貼文顯示名來源：graph_api \| mapping \| post_id |
| post_display_name | TEXT | 解析後的貼文顯示名稱（供 UI 顯示） |
| target_line_type | TEXT | 導流 LINE 類型：general \| after_sale |
| target_line_value | TEXT | 導流 LINE 連結/值 |

---

## 3. 新增 / 修改的 API

### 粉專設定（meta_page_settings）

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | /api/meta-page-settings | 列表，可選 ?brand_id= |
| GET | /api/meta-page-settings/:id | 單筆 |
| GET | /api/meta-page-settings/by-page/:pageId | 依 page_id 查詢 |
| POST | /api/meta-page-settings | 新增（body: page_id, brand_id, page_name, line_general, line_after_sale, auto_hide_sensitive, auto_reply_enabled, auto_route_line_enabled, default_reply_template_id, default_sensitive_template_id, default_flow, default_product_name） |
| PUT | /api/meta-page-settings/:id | 更新 |
| DELETE | /api/meta-page-settings/:id | 刪除 |

### 商品關鍵字（meta_product_keywords）

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | /api/meta-product-keywords | 列表，可選 ?brand_id= |
| POST | /api/meta-product-keywords | 新增（body: keyword, product_name, match_scope: 'post' \| 'comment', brand_id 選填） |
| DELETE | /api/meta-product-keywords/:id | 刪除 |

### 留言解析

| 方法 | 路徑 | 說明 |
|------|------|------|
| POST | /api/meta-comments/:id/resolve | 對該則留言重新執行貼文 fallback、商品判定、導流 LINE 解析，並寫回 meta_comments |

### 既有 API 行為變更

- **POST /api/meta-comments**、**POST /api/meta-comments/simulate-webhook**、**POST /api/meta-comments/seed-test-cases**、**POST /api/meta-comments/test-mapping**：建立留言時會自動呼叫 `resolveCommentMetadata`，將 post_display_name、detected_post_title_source、detected_product_name、detected_product_source、target_line_type、target_line_value 寫入新留言。

---

## 4. 商品判定邏輯怎麼做

實作於 `server/meta-comment-resolver.ts` 的 `resolveProductDetection`，依序：

1. **第一層：post_id mapping**  
   使用既有 `getMappingForComment(brand_id, page_id, post_id)`，若該貼文在 meta_post_mappings 有對應且為啟用，且 product_name 有值，則回傳該 product_name，來源 `post_mapping`。

2. **第二層：貼文標題/名稱關鍵字**  
   從 `meta_product_keywords` 取 `match_scope = 'post'` 的關鍵字，用「解析後的貼文顯示名」（post_display_text）做子字串比對（包含即命中），命中則回傳該筆的 product_name，來源 `post_keyword`。

3. **第三層：留言內容關鍵字**  
   從 `meta_product_keywords` 取 `match_scope = 'comment'`，用留言 message 做子字串比對，命中則回傳 product_name，來源 `comment_keyword`。

4. **第四層：粉專預設商品**  
   從 `meta_page_settings` 依 page_id 取該粉專的 default_product_name，有值則回傳，來源 `page_default`。

5. **第五層：未判定**  
   以上皆無則 detected_product_name = null，detected_product_source = `none`。

判定結果與來源會寫入 meta_comments 的 detected_product_name、detected_product_source。

---

## 5. 粉專 → 品牌 → LINE 資料怎麼存

- **存於 meta_page_settings 表**，一筆代表一個粉專（page_id UNIQUE）的設定。
- **欄位對應**：
  - page_id：粉專 ID（必填、唯一）
  - page_name：粉專名稱（顯示用）
  - brand_id：所屬品牌（FK brands.id）
  - line_general：一般導購 LINE（URL 或代號，字串）
  - line_after_sale：售後/客訴 LINE
  - auto_hide_sensitive：是否啟用敏感件自動隱藏（0/1）
  - auto_reply_enabled：是否啟用自動回覆（0/1）
  - auto_route_line_enabled：是否啟用自動導 LINE（0/1）
  - default_reply_template_id：預設公開回覆模板（FK meta_comment_templates）
  - default_sensitive_template_id：預設敏感安撫模板
  - default_flow：預設處理偏好（product_link / activity_link / line_redirect / support_only）
  - default_product_name：粉專預設商品（供商品判定第四層）

- **導流 LINE 如何套到留言**：在 `resolveCommentMetadata` 中依 page_id 查 meta_page_settings，再依 is_sensitive_or_complaint 選 line_general 或 line_after_sale，寫入留言的 target_line_type、target_line_value。

---

## 6. 如何驗收

1. **粉專設定**  
   - 呼叫 POST /api/meta-page-settings，帶 page_id、brand_id、line_general、line_after_sale、default_product_name 等。  
   - 再 GET /api/meta-page-settings 與 GET /api/meta-page-settings/by-page/:pageId，確認可建立並查詢。

2. **留言帶出來源與判定**  
   - 建立一筆留言（simulate-webhook 或 POST /api/meta-comments），帶 page_id、post_id、message，且該 post_id 在 meta_post_mappings 有對應商品。  
   - GET 該則留言，確認有 post_display_name、detected_post_title_source、detected_product_name、detected_product_source、target_line_type、target_line_value。

3. **貼文 fallback**  
   - 建立留言時不帶 post_name、且無 mapping 的 post_id，確認 post_display_name 為 post_id、detected_post_title_source 為 post_id。  
   - 有 mapping 的 post_name 時，確認 post_display_name 為 mapping 的 post_name、detected_post_title_source 為 mapping。

4. **商品未判定**  
   - 建立留言的 post_id 無 mapping、且未設定 post/comment 關鍵字與粉專預設商品，確認 detected_product_name 為 null、detected_product_source 為 none。

5. **重新解析**  
   - 對既有留言 POST /api/meta-comments/:id/resolve，再 GET 該則，確認上述欄位已更新。

---

## 7. 測試案例

| 案例 | 步驟 | 預期 |
|------|------|------|
| 粉專設定 CRUD | 新增一筆 page_id=page_korena, brand_id=1, line_general=url1, line_after_sale=url2；再 GET 列表與 by-page/page_korena | 回傳該筆，欄位正確 |
| 留言 + mapping 有商品 | 有 mapping(post_001 → 商品A)；建立留言 post_id=post_001, page_id=page_demo | detected_product_name=商品A, detected_product_source=post_mapping |
| 留言 + 貼文關鍵字 | 新增 meta_product_keywords keyword=精華, product_name=精華液, match_scope=post；建立留言 post_display_name 含「精華」 | detected_product_name=精華液, detected_product_source=post_keyword |
| 留言 + 留言關鍵字 | 新增 keyword=退貨, product_name=售後, match_scope=comment；建立留言 message 含「退貨」 | detected_product_name=售後, detected_product_source=comment_keyword |
| 粉專預設商品 | meta_page_settings 設 default_product_name=預設品；建立留言無 mapping/關鍵字命中 | detected_product_name=預設品, detected_product_source=page_default |
| 未判定商品 | 無 mapping、無關鍵字、無粉專預設 | detected_product_name=null, detected_product_source=none |
| 貼文 fallback | 無 graph、無 mapping 的 post_id | post_display_name=post_id, detected_post_title_source=post_id |
| 重新解析 | POST /api/meta-comments/:id/resolve | 該則留言的 post_display_name、detected_*、target_line_* 更新 |

---

## 8. 自我檢查

- [x] 新表與新欄位皆經 migration，重啟後 DB 可正常建立/更新
- [x] 建立留言四處（simulate-webhook, seed-test-cases, test-mapping, POST meta-comments）皆帶入 resolver 結果
- [x] 貼文 fallback 優先順序為 graph_api → mapping → post_id，且來源有寫入
- [x] 商品判定五層順序正確，且 none 時不寫入錯誤商品
- [x] 粉專設定與商品關鍵字皆可透過 API 維護，不硬編碼
- [x] 未改動既有 UI、未做 KPI/複雜篩選/完整 Meta 發佈

---

## 9. 未完成項目與下一輪建議

- **未做**：Meta 實際發佈回覆/隱藏留言 API、Webhook 接真實留言、自動執行管線（依開關觸發）、KPI 戰情、UI 美化、複雜篩選。
- **下一輪建議**：  
  - Phase 2：接 Meta 留言 Webhook、實作「回覆留言」「隱藏留言」Graph API、寫回 reply_error/platform_error 與 auto_*_at。  
  - 再下一輪：依 meta_page_settings 的 auto_reply_enabled / auto_hide_sensitive 等開關，在留言入庫或定時任務中真正執行自動回覆/隱藏/導流，並補防漏與 UI。
