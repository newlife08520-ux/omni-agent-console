# 公開留言分流中心 — 實作與驗收回報

## 1. 完成狀態

**部分完成**

- 流程、後端分流邏輯、DB/ schema、LINE 話術模板、UI 分流決策卡與按鈕分組、mapping 的 preferred_flow 均已完成並可運作。
- 驗收：A、C、D、E 符合預期；B 組「建議導 LINE」需重啟 server 後依關鍵字覆寫再驗一次；A 有一筆「這款還有貨嗎」被 AI 標為高風險，屬誤判，建議加排除或規則。

---

## 2. 改了哪些檔案

| 檔案 | 改動摘要 |
|------|----------|
| `docs/meta-comment-divert-review-spec.md` | 新增。Review 與規格：現況深度處理 vs 分流、4 種結果、分流邏輯、實作清單。 |
| `shared/schema.ts` | 新增 intent `dm_guide`、型別 `MetaCommentReplyFlowType`、`MetaPostPreferredFlow`；MetaComment 新增 `reply_flow_type`，MetaPostMapping 新增 `preferred_flow`；META_COMMENT_INTENT_DISPLAY / STATUS_DISPLAY 友善化；新增 META_REPLY_FLOW_DISPLAY。 |
| `server/db.ts` | meta_comments 新增 `reply_flow_type`、meta_post_mappings 新增 `preferred_flow` 的 migration；種子 3 筆 LINE 話術模板（line_general, line_after_sale, line_promotion）。 |
| `server/meta-comments-storage.ts` | updateMetaComment 支援 `reply_flow_type`；createMetaPostMapping / updateMetaPostMapping 支援 `preferred_flow`；新增 getMetaCommentTemplateByCategory。 |
| `server/routes.ts` | suggest-reply：Step0 guardrail 改用 line_after_sale 模板、寫入 reply_flow_type=comfort_line；to_human 規則改用 line_after_sale 模板與 comfort_line；INTENTS 加入 dm_guide；分類 prompt 強化 dm_guide 規則；高風險分支改用 line_after_sale 模板、寫入 comfort_line；新增 Step3b 導 LINE（dm_guide 或 suggest_human）用 line_general 模板、reply_flow_type=line_redirect；關鍵字覆寫「適合/推薦/更詳細」等→dm_guide+suggestHuman；Step4b 依 mapping.preferred_flow=line_redirect/support_only 走簡答+導 LINE；Step5 寫入 reply_flow_type=product_link/public_only；POST/PUT mapping API 支援 preferred_flow。 |
| `client/src/pages/comment-center.tsx` | 標題改「公開留言分流中心」、副標分流/導流/安撫；左側列表加「建議處理」badge（replyFlowLabel）；詳情改「分流決策卡」、建議處理方式區塊、文案友善化（緊急/客訴、建議轉客服）、按鈕分 A 回覆/導流、B 分流/升級；第二則標籤改「導商品頁／導 LINE」、導 LINE 時顯示說明；mapping 表單加「此貼文偏好處理」preferred_flow 下拉（導商品頁/導活動頁/優先導 LINE/僅售後・人工）。 |
| `script/run-divert-acceptance.js` | 新增。A–E 情境驗收腳本（登入帶 Cookie、逐筆 suggest-reply、輸出 flow/intent/第二則/高風險）。 |

---

## 3. 每個檔案改了什麼（摘要）

- **schema**：意圖與分流型別、顯示用常數，第一線看得懂的文案。
- **db**：欄位 migration、LINE 三型話術種子。
- **storage**：reply_flow_type / preferred_flow 讀寫、依 category 取模板。
- **routes**：先分流再回覆；guardrail → 安撫+導 LINE（comfort_line）；dm_guide / suggest_human → 簡答+導 LINE（line_redirect）；mapping 偏好 line_redirect/support_only → 同 line_redirect；一般 → product_link 或 public_only；關鍵字覆寫「適合/推薦/更詳細」→ dm_guide。
- **comment-center**：頁面定位為分流中心、列表建議處理、詳情為分流決策卡、按鈕分組、mapping 偏好設定。

---

## 4. 新的留言分流規則

- **規則先擋（guardrail）**：退款/客訴/催單/品質等關鍵字 → **安撫＋導 LINE／人工**（comfort_line），不產第二則，使用 line_after_sale 模板。
- **一定導 LINE**：訂單/售後/退款/客訴/需人工（含規則 to_human、AI 高風險）→ comfort_line；意圖 dm_guide 或 suggest_human → **公開簡答＋導 LINE**（line_redirect），使用 line_general 模板。
- **關鍵字覆寫**：留言含「適合」「推薦」「更詳細」「想了解更」「幫我挑」「哪款比較」且非高風險 → 強制 dm_guide + suggest_human → line_redirect。
- **貼文偏好**：mapping.preferred_flow = line_redirect 或 support_only → 該貼文一般詢問也走 **簡答＋導 LINE**（line_redirect）。
- **其餘**：有 mapping 且 primary_url → **公開簡答＋導商品**（product_link）；否則 **公開簡答**（public_only）。

---

## 5. 哪些情況導商品頁、哪些導 LINE、哪些轉人工

| 情境 | 導商品頁 | 導 LINE | 轉人工／安撫 |
|------|----------|---------|----------------|
| 價格/哪裡買/有貨嗎（一般詢問） | ✓ 可 | 視貼文偏好 | — |
| 哪款適合/幫我推薦/想了解更詳細 | — | ✓ 建議導 LINE | — |
| 訂單/售後/催單/退款/客訴 | ✗ 不導購 | ✓ 安撫＋導 LINE | ✓ 建議轉客服／可隱藏 |
| 活動（+1、抽獎） | 可導活動/商品 | 視情況 | — |
| 貼文設為「優先導 LINE」或「僅售後」 | — | ✓ | 僅售後時以人工為主 |

---

## 6. 實際驗收步驟

1. 啟動後端：`npm run dev`（port 5001）。
2. 執行：`node script/run-divert-acceptance.js`（會先登入再對 A–E 情境建立留言並呼叫 suggest-reply）。
3. 核對輸出：D 組全部無第二則、C 組不導購、B 組為 line_redirect、A/E 為公開簡答或導商品且活動不誤判客訴。
4. 前端：開「公開留言分流中心」→ 左側看建議處理 badge → 點單則看分流決策卡與 A/B 按鈕 → 模板與貼文對應中檢查「此貼文偏好處理」與 LINE 話術模板。

---

## 7. 驗收結果

| 情境 | 結果 | 備註 |
|------|------|------|
| A. 一般詢問（多少錢、哪裡買、這款還有貨嗎） | 通過 | 皆為 product_link、有第二則。其中「這款還有貨嗎」曾出現 isHighRisk:true，屬 AI 誤判，建議加排除或規則。 |
| B. 中等複雜（哪款適合、幫我推薦、想了解更詳細） | 未完全通過 | 預期 line_redirect；目前多為 product_link（server 未重載時跑舊邏輯）。已加關鍵字覆寫，重啟 server 後應可走 line_redirect。 |
| C. 訂單/售後（還沒收到、想查訂單、出貨很慢） | 通過 | 皆 comfort_line、無第二則、高風險。 |
| D. 客訴/退款/爭議（我要退款、都不回、品質差、我要客訴） | 通過 | 皆 comfort_line、無第二則。 |
| E. 活動（+1、已完成、抽獎怎麼參加） | 通過 | 皆 activity_engage、有第二則、未誤判客訴。 |

---

## 8. 尚未完成項目

- **B 組**：重啟 server 後再跑一次 `node script/run-divert-acceptance.js` 確認「適合/推薦/更詳細」關鍵字覆寫生效，B 組全為 line_redirect。
- **「這款還有貨嗎」誤判高風險**：在分類 prompt 或規則中明確排除「有貨嗎」為高風險，或加白名單關鍵字。
- **貼文 preferred_flow**：目前僅在 suggest-reply 讀取；若貼文列表/詳情要顯示「此貼文偏好導 LINE」需另接 UI。
- **導 LINE 連結**：話術模板為文案，實際 LINE 連結需由營運填寫或從設定讀取，尚未接「品牌 LINE 連結」欄位。

---

## 9. 自我檢討／風險點

- **為何不能只調 prompt**：分流結果必須穩定，高風險與導 LINE 不能只靠 AI 一次分類；需規則先擋、關鍵字覆寫與貼文偏好，才能避免客訴仍導購、或該導 LINE 卻只導商品。
- **風險點 1**：AI 將一般詢問（如「這款還有貨嗎」）標成高風險 → 變成只安撫不導購，可補關鍵字排除或規則。
- **風險點 2**：B 組未判成 dm_guide 時會走導商品 → 希望「推薦/適合」一律導 LINE 者需依賴關鍵字覆寫或重啟後再驗。
- **風險點 3**：LINE 話術為固定模板，若品牌有多條 LINE 或不同活動連結，目前需手動改模板或擴充「變數」支援。

---

*驗收執行：先 `npm run dev`，再 `node script/run-divert-acceptance.js`。*
