# P0-A：Comment-center 拆頁與 Sidebar 導航重構

## 本輪範圍說明

此 PR 為 **route-level 拆分**，不是完整 **component-level 拆分**：

- **有做**：新增四條獨立 path（`/comment-center/inbox`、`/comment-center/rules`、`/comment-center/channel-binding`、`/comment-center/simulate`），sidebar 與頁內導航改為上述 path，舊 hash 進站時 client 端自動導向新 path，頁面標題（document.title）與導航命名一致。
- **沒做**：未將 `comment-center.tsx` 拆成多個 Page 元件檔；仍為單一 `CommentCenterPage` 依 path 決定顯示區塊。未改動 API、未拆後端 routes、未搬 settings/team/brands。

---

## 舊 hash 如何導轉（相容性）

| 造訪 URL | 導向結果 |
|----------|----------|
| `/comment-center`（無 hash） | → `/comment-center/inbox` |
| `/comment-center#inbox` | → `/comment-center/inbox` |
| `/comment-center#rules` | → `/comment-center/rules` |
| `/comment-center#mapping` | → `/comment-center/rules`（同頁「模板與商品對應」子區） |
| `/comment-center#page-settings` | → `/comment-center/channel-binding` |
| `/comment-center#risk-rules` | → `/comment-center/rules`（同頁「留言風險與導流規則」子區） |
| `/comment-center#simulate` | → `/comment-center/simulate` |

導轉在 client 端由 `CommentCenterRedirect` 與 path 進入後清除 hash 完成；書籤與舊連結仍可進到對應功能。

---

## 哪些功能未改

- **Chat**：即時客服頁未改。
- **Settings / Team / Brands**：未搬移、未新增 `/brands` 頁。
- **後端**：`routes.ts` 未拆、API path 與 response shape 未改。
- **權限**：與 main 一致（comment-center 四子 path 皆為 `super_admin`、`marketing_manager`、`cs_agent`）。
- **留言中心內部邏輯**：收件匣篩選、規則 CRUD、模板對應、粉專-LINE 設定表、風險規則與測試器、模擬留言／webhook 行為均與改版前相同，僅「由 hash 切 tab」改為「由 path 切頁」。

---

## 路徑與命名統一（正式名稱）

- 粉專與 LINE 設定頁：**`/comment-center/channel-binding`**（文件、sidebar、頁面標題、回報皆以此為準；不使用 `routing` 作為此頁 path）。

---

## 本地驗收結果

（請在合併前由驗收人填寫；可複製以下清單並打勾）

### 路由與導轉

- [ ] 直接造訪 `/comment-center` → 自動導向 `/comment-center/inbox`。
- [ ] 造訪 `/comment-center#page-settings` → 導向 `/comment-center/channel-binding` 且 hash 清除。
- [ ] 造訪 `/comment-center#risk-rules` → 導向 `/comment-center/rules` 且 hash 清除。
- [ ] 造訪 `/comment-center#simulate` → 導向 `/comment-center/simulate` 且 hash 清除。

### Sidebar 與四頁

- [ ] Sidebar「留言收件匣」→ `/comment-center/inbox`，無 hash。
- [ ] Sidebar「留言規則與導向」→ `/comment-center/rules`，無 hash。
- [ ] Sidebar「粉專與 LINE 設定」→ `/comment-center/channel-binding`，無 hash。
- [ ] Sidebar「內測模擬」→ `/comment-center/simulate`，無 hash。
- [ ] 造訪 `/comment-center/inbox`、`/comment-center/rules`、`/comment-center/channel-binding`、`/comment-center/simulate` 各顯示正確內容。

### 功能與權限

- [ ] 留言收件匣：戰情摘要、狀態篩選、列表、回覆／隱藏／導 LINE 行為與改版前一致。
- [ ] 留言規則與導向：自動規則、模板與商品對應、留言風險與導流規則三子區可切換且 CRUD 正常。
- [ ] 粉專與 LINE 設定：page-settings 表顯示與編輯行為與改版前一致。
- [ ] 內測模擬：建立模擬留言、模擬 webhook、一鍵測試案例與改版前一致。
- [ ] 以 cs_agent / marketing_manager / super_admin 登入，上述四頁皆可進入，無 403/404。

### 頁面標題

- [ ] 四頁 document.title 分別為「留言收件匣」「留言規則與導向」「粉專與 LINE 設定」「內測模擬」+ 「 | AI 客服中控台」。

---

## 驗收證據（建議附於 PR）

建議在 PR 中附上以下其中一種，以便審閱：

1. **四頁路徑截圖**：  
   - `/comment-center/inbox`（留言收件匣）  
   - `/comment-center/rules`（留言規則與導向，可含一子區如「自動規則」）  
   - `/comment-center/channel-binding`（粉專與 LINE 設定）  
   - `/comment-center/simulate`（內測模擬）  

2. **或短片**：從 sidebar 點選四項並造訪上述四 path，再示範一次舊 hash 導轉（例如 `/comment-center#page-settings` → channel-binding）。

---

## 相關文件

- 實作藍圖與 P0-A 執行細節：`docs/P0-IMPLEMENTATION-PLAN.md`（本輪已統一 path 名稱為 `channel-binding`）。
