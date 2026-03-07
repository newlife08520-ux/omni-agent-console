# P0-A 人工驗收最短步驟（照著點即可）

## 前置

1. 在 repo 根目錄執行：`npm run dev`（或貴司啟動指令）。
2. 瀏覽器打開對應網址（例如 `http://localhost:5000`），並**登入**（任一身分：cs_agent / marketing_manager / super_admin）。

---

## 一、4 個新 path 怎麼驗

| 步驟 | 操作 | 預期 |
|------|------|------|
| 1 | 點左側 sidebar **「留言收件匣」** | URL 變為 `/comment-center/inbox`，畫面為收件匣（戰情摘要、狀態篩選、留言列表）。 |
| 2 | 點 **「留言規則與導向」** | URL 變為 `/comment-center/rules`，畫面可切換「自動規則」「模板與商品對應」「留言風險與導流規則」三區。 |
| 3 | 點 **「粉專與 LINE 設定」** | URL 變為 `/comment-center/channel-binding`，畫面為粉專與 LINE 導向設定表。 |
| 4 | 點 **「內測模擬」** | URL 變為 `/comment-center/simulate`，畫面為模擬留言／Webhook／一鍵測試。 |

每步確認：網址列與上述 path 一致、內容與改版前相同（非空殼）。

---

## 二、舊 hash 怎麼驗

| 步驟 | 操作 | 預期 |
|------|------|------|
| 5 | 在網址列**手動輸入** `.../comment-center`（結尾無 hash），Enter | 自動跳成 `.../comment-center/inbox`。 |
| 6 | 手動輸入 `.../comment-center#page-settings`，Enter | 自動跳成 `.../comment-center/channel-binding`，且**網址列沒有 `#...`**。 |
| 7 | 手動輸入 `.../comment-center#risk-rules`，Enter | 自動跳成 `.../comment-center/rules`，網址列無 hash。 |
| 8 | 手動輸入 `.../comment-center#simulate`，Enter | 自動跳成 `.../comment-center/simulate`，網址列無 hash。 |

---

## 三、標題與權限（可抽驗）

- **標題**：在上述四頁分別看瀏覽器分頁標題，應為「留言收件匣」「留言規則與導向」「粉專與 LINE 設定」「內測模擬」+ 「 | AI 客服中控台」。
- **權限**：未登入時造訪 `.../comment-center/inbox` 應被導向登入或 401；登入後四頁皆可進入、無 403／404／白屏。

---

## 建議截圖（附在 PR 用）

1. **四頁各一張**（網址列要入鏡）：  
   - `/comment-center/inbox`  
   - `/comment-center/rules`  
   - `/comment-center/channel-binding`  
   - `/comment-center/simulate`  
2. **選配**：一張「輸入 `#page-settings` 後變成 `/comment-center/channel-binding`」的 before/after 或短片。

---

## 可直接貼進 PR comment 的驗收段落（見下方）
