# 商品判定順序與未判定時的安全降級

## 一、目前商品判定順序（層級）

依 `server/meta-comment-resolver.ts` 的 `resolveProductDetection()`，順序為：

| 順序 | 來源 | 說明 |
|------|------|------|
| 1 | **貼文 mapping（post_mapping）** | 依 brand_id + page_id + post_id 查 `meta_post_mappings`，有對應則取該筆的 `product_name`。 |
| 2 | **貼文關鍵字（post_keyword）** | 以「貼文顯示名稱／標題」比對 `meta_product_keywords` 中 `match_scope = 'post'` 的關鍵字，命中則取對應 `product_name`。 |
| 3 | **留言關鍵字（comment_keyword）** | 以「留言內容」比對 `match_scope = 'comment'` 的關鍵字，命中則取對應 `product_name`。 |
| 4 | **粉專預設（page_default）** | 該粉專設定的 `default_product_name`（若存在）。 |
| 5 | **未判定（none）** | 以上皆無則 `detected_product_name = null`、`detected_product_source = 'none'`。 |

貼文顯示名稱的 fallback 順序：Graph API 貼文標題 → mapping 的 post_name → post_id。

---

## 二、若都判不出來，系統會怎麼做

- **商品名稱**：`detected_product_name` 為 null、`detected_product_source = 'none'`；該則會進「待補資料／未判定商品」條件（例外列表、戰情摘要會計入）。
- **回覆內容與連結**：  
  - 產生建議回覆時，**商品連結只來自「貼文 mapping」**（`getMappingForComment`）。  
  - 若該貼文**沒有** mapping，則 `productUrl` 為空，AI 提示為「第二則溫和邀請至官網或私訊詢問，**不要貼任何網址**」，不會用猜的連結。
- **結論**：判不出商品時**不會亂導商品頁**，也不會在回覆裡塞不明連結；僅會出現「待補資料」、邀請官網／私訊等安全話術。

---

## 三、是否會亂導商品頁或亂用商品話術

- **不會亂導商品頁**：實際寫入回覆的連結僅在「有 post_id mapping 且該 mapping 有 primary_url/fallback_url」時才會帶入；無 mapping 時連結為空，不會用 `detected_product_name` 去組連結。
- **商品話術**：AI 雙段式回覆時，若有提供 `productUrl` 才會在第二段帶入連結；無連結時已明確指示「不要編造連結、不要貼任何網址」，因此不會亂用商品話術。

---

## 四、營運輔助：「未判定商品排行榜／最常缺 mapping 的貼文」

**建議下一步（可落地的設計）：**

- **未判定商品／缺 mapping 統計**  
  - 從 `meta_comments` 篩選 `detected_product_source = 'none'` 或 `detected_product_name IS NULL`（可再加「近期」如 7 天內），依 **post_id**（或 post_id + page_id）群組計數。  
  - 產出「**未判定商品筆數最多的貼文 Top N**」或「**最常缺 mapping 的 post_id 排行榜**」，供營運優先補貼文 mapping 或商品關鍵字。  
- **實作方式**  
  - 新增 API 例如 `GET /api/meta-comments/missing-product-stats?brand_id=&days=7&limit=20`，回傳 `{ post_id, page_id, post_display_name, comment_count, last_comment_at }[]`。  
  - 在「留言中心」或「模板與商品對應」旁加一區塊「**待補 mapping 貼文（依留言數排序）**」，點入可跳到該貼文的 mapping 設定。  
- **進階**：可再加「未判定商品」的留言數總計、佔比，方便排優先順序。

此設計可讓員工一眼看到「最有價值的待補 mapping」，本輪僅規劃，實作可排入下一輪。
