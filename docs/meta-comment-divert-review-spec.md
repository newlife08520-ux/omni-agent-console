# Meta 留言中心：Review & 公開留言分流規格

## 一、現況 Review

### 1. 流程與路由

| 項目 | 現況 | 屬「深度處理」或「分流」 |
|------|------|--------------------------|
| 入口 | `POST /api/meta-comments` 建立留言；`POST /api/meta-comments/:id/suggest-reply` 產生建議 | 分流（建立）＋深度（suggest 一次做完分類+雙段式） |
| suggest-reply 順序 | Step0 規則 guardrail → Step1 關鍵字規則 → Step2 AI 分類 → Step3 高風險只安撫 / Step4–5 mapping + 雙段式 | 混在一起：先擋高風險對，但「一般詢問」一律走雙段式導購，沒有「先分流再決定怎麼回」 |
| 結果形態 | 僅兩種：高風險→安撫第一則；其餘→第一則+第二則（導購或無連結） | 深度：預設在留言區就給雙段式，沒有「公開簡答／導 LINE／導商品」三種分流結果 |

### 2. API

| API | 用途 | 備註 |
|-----|------|------|
| GET/POST /api/meta-comments | 列表／建立 | 列表篩選 status/source 已夠用 |
| GET /api/meta-comments/:id | 單筆 | 需回傳分流結果欄位（見下） |
| PUT /api/meta-comments/:id | 更新 | 需支援 reply_flow_type 等（若新增） |
| POST suggest-reply | 建議回覆 | **要改成：先分流 → 再依分流結果產出** |
| assign / unassign | 指派 | 保留，屬分流／升級操作 |
| GET templates, rules, mappings | 設定 | 保留；mapping 需加 preferred_flow |

### 3. 資料表

| 表 | 現有欄位重點 | 要改／要加 |
|----|----------------|------------|
| meta_comments | message, ai_intent, priority, reply_first, reply_second, reply_link_source, classifier_source, matched_rule_keyword, ai_suggest_human, ai_suggest_hide, assigned_* | 可加 reply_flow_type（public_only / product_link / line_redirect / comfort_line）便於 UI 與報表；非必須，也可用既有欄位推導 |
| meta_comment_templates | category, reply_first, reply_second, reply_comfort, reply_dm_guide | 模板已有 reply_comfort、reply_dm_guide；需**種子／預設**「LINE 導流」三型話術（一般協助、售後客訴、導購型） |
| meta_post_mappings | post_id, primary_url, fallback_url, tone_hint, auto_comment_enabled | **加 preferred_flow**：product_link / activity_link / line_redirect / support_only |

### 4. 規則與 Guardrail

| 項目 | 現況 | 改動 |
|------|------|------|
| meta-comment-guardrail.ts | 關鍵字→高風險，固定安撫一句 | 安撫句改為可套「售後/客訴型」LINE 話術模板 |
| suggest-reply 內規則 | to_human / hide / use_template | 保留；**補一層「LINE 導流」判定**：訂單/售後/退款/客訴/需人工→一定導 LINE；想推薦/想優惠/複雜→可選導 LINE；簡單價格/哪裡買/活動→不一定導 LINE |

### 5. 模板與 Mapping

| 項目 | 現況 | 改動 |
|------|------|------|
| 模板 category | product_inquiry, price_inquiry, … | 新增或沿用 category：line_general / line_after_sale / line_promotion，對應三種 LINE 話術風格 |
| Mapping | 僅 primary_url, fallback_url | **加 preferred_flow**（見上）；suggest-reply 取用：若 preferred_flow=line_redirect 或 support_only，不產第二則導購、改產導 LINE 話術 |

### 6. UI 操作層

| 區塊 | 現況 | 改為（分流思維） |
|------|------|-------------------|
| 頁標題 | 「Meta 留言互動中心」 | 「公開留言分流中心」或保留名稱但副標改為「分流、導流、安撫、標記」 |
| 左側列表 | 狀態、負責人、高風險、客訴、模擬 | **加「建議處理」badge**：公開簡答／導商品／導 LINE／安撫+導 LINE |
| 詳情區 | 留言詳情＋處理責任＋意圖＋一二則＋一排按鈕 | **改為「分流決策卡」**：一眼看出類型、建議處理方式、是否高風險/建議隱藏/轉人工、第二則是導頁還是導 LINE；按鈕分兩組：A 回覆/導流（產生建議、套模板、儲存、標記已回覆）B 分流/升級（指派、轉人工、隱藏、導 LINE） |
| 用詞 | 高風險、refund_after_sale、where_to_buy、建議轉人工 | **前台友善**：緊急案件/客訴優先、售後／退款、哪裡買、建議轉客服、建議導 LINE |

---

## 二、分流結果定義（4 種）

1. **公開簡答** — 價格/哪裡買/有貨嗎/活動怎麼參加/基本商品詢問；簡短回覆，可導活動頁或商品頁，不一定導 LINE。
2. **公開簡答 + 導商品頁** — 明顯購買意圖；第一則簡答，第二則自然導購到商品/活動頁。
3. **公開簡答 + 導 LINE** — 需細節說明/一對一建議/查訂單/要優惠/稍複雜；公開簡答＋引導至 LINE。
4. **安撫 + 導 LINE / 人工** — 退款/客訴/情緒/出貨/瑕疵/爭議；不導購，只安撫第一則＋導 LINE 或私訊/人工；可建議隱藏。

---

## 三、分流邏輯（先分流再決定怎麼回）

- **規則先擋**：現有 guardrail 關鍵字→安撫+導 LINE（flow=comfort_line）。
- **AI 意圖**：商品詢問、價格詢問、哪裡買/下單、活動互動、**需要更多說明/導 LINE**、**訂單/售後/查詢**、退款/客訴/高風險、垃圾/競品/不雅。
- **LINE 導流規則**：
  - **一定導 LINE**：訂單查詢、售後、退款、客訴、需人工、需個資、問題太長/太複雜。
  - **可選導 LINE**：想知道哪款適合、要更多推薦、想拿優惠、想問更細。
  - **不一定導 LINE**：簡單價格、哪裡買、活動規則、有貨嗎。

---

## 四、實作清單

- [ ] DB: meta_post_mappings 加 preferred_flow；meta_comment_templates 種子三種 LINE 話術。
- [ ] server: 分流結果欄位（或由既有欄位推導 reply_flow_type）；suggest-reply 依分流產出「只簡答」「簡答+商品」「簡答+LINE」「安撫+LINE」；LINE 話術從模板取用。
- [ ] client: 標題/副標、列表 badge（建議處理）、詳情分流決策卡、按鈕分組、文案友善化。
- [ ] 驗收：A–E 情境自測並寫入回報。
