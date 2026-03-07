# P0-A：Comment-center 拆頁與 Sidebar 導航重構（route-level）

## PR 說明

本輪為 **route-level 拆分**，不是完整 **component-level refactor**。

- **有做**：新增四條獨立 path（`/comment-center/inbox`、`/comment-center/rules`、`/comment-center/channel-binding`、`/comment-center/simulate`），sidebar 與頁內導航改為上述 path，舊 hash 進站時 client 端自動導向新 path，頁面標題（document.title）與導航命名一致。
- **沒做**：未將 `comment-center.tsx` 拆成多個 Page 元件檔；仍為單一 `CommentCenterPage` 依 path 決定顯示區塊。未改動 API、未拆後端 routes、未搬 settings/team/brands。

**刻意未動**：Chat 即時客服、Settings/Team/Brands 頁面與路由、後端 routes.ts、API 路徑與 response shape、留言中心內部業務邏輯（僅由 hash 切 tab 改為由 path 切頁）。

**下一輪建議**：P0-B（settings / brands-channels / team 職責切分）；本 PR 合併且驗收證據齊全前不開始 P0-B。

---

## 路徑與命名（正式名稱）

| 顯示名稱         | Path                               |
|------------------|------------------------------------|
| 留言收件匣       | `/comment-center/inbox`            |
| 留言規則與導向   | `/comment-center/rules`            |
| 粉專與 LINE 設定 | `/comment-center/channel-binding`  |
| 內測模擬         | `/comment-center/simulate`         |

粉專與 LINE 設定頁僅使用 **`/comment-center/channel-binding`**（無 `routing`）。

---

## 舊 hash 導轉（相容性）

| 造訪 URL | 導向結果 |
|----------|----------|
| `/comment-center`（無 hash） | → `/comment-center/inbox` |
| `/comment-center#inbox` | → `/comment-center/inbox` |
| `/comment-center#rules` | → `/comment-center/rules` |
| `/comment-center#mapping` | → `/comment-center/rules`（同頁「模板與商品對應」子區） |
| `/comment-center#page-settings` | → `/comment-center/channel-binding` |
| `/comment-center#risk-rules` | → `/comment-center/rules`（同頁「留言風險與導流規則」子區） |
| `/comment-center#simulate` | → `/comment-center/simulate` |

導轉在 client 端由 `CommentCenterRedirect` 完成；進入新 path 後會清除 hash，避免雙重來源。

---

## 本地驗收結果

### 已透過建置／程式檢查驗證

- [x] **建置**：`npm run build`（client）通過，無 P0-A 相關錯誤。
- [x] **路由**：`App.tsx` 已註冊 `/comment-center/inbox`、`/comment-center/rules`、`/comment-center/channel-binding`、`/comment-center/simulate` 及 `/comment-center` → `CommentCenterRedirect`。
- [x] **Redirect 對應**：`CommentCenterRedirect` 內 map 與上表一致（page-settings→channel-binding，risk-rules/rules/mapping→rules，simulate→simulate，空→inbox）。
- [x] **Sidebar**：`allMenuItems` 四項為獨立 path，無 hash；標題為「留言收件匣」「留言規則與導向」「粉專與 LINE 設定」「內測模擬」。
- [x] **comment-center**：由 `useCommentCenterPage()` 依 path 解析 currentPage；`COMMENT_CENTER_PAGE_TITLES` 與上表一致；進站後清除 hash、設定 document.title。

### 需人工在瀏覽器驗證

以下請在本地啟動 app 後逐項操作並打勾：

**1. Sidebar 四入口**

- [ ] 點「留言收件匣」→ 進入 `/comment-center/inbox`，內容為收件匣（戰情摘要、狀態篩選、列表）。
- [ ] 點「留言規則與導向」→ 進入 `/comment-center/rules`，可切換「自動規則」「模板與商品對應」「留言風險與導流規則」。
- [ ] 點「粉專與 LINE 設定」→ 進入 `/comment-center/channel-binding`，內容為 page-settings 表。
- [ ] 點「內測模擬」→ 進入 `/comment-center/simulate`，內容為模擬留言／webhook／一鍵測試。

**2. 根 path 導向**

- [ ] 造訪 `http://localhost:xxxx/comment-center`（無 hash）→ 自動導向 `/comment-center/inbox`。

**3. 舊 hash 導轉**

- [ ] 造訪 `/comment-center#page-settings` → 導向 `/comment-center/channel-binding`，網址列無 hash。
- [ ] 造訪 `/comment-center#risk-rules` → 導向 `/comment-center/rules`，網址列無 hash。
- [ ] 造訪 `/comment-center#simulate` → 導向 `/comment-center/simulate`，網址列無 hash。

**4. 內容與標題**

- [ ] 四頁內容與改版前一致（非空殼導航）。
- [ ] 四頁 document.title 分別為「留言收件匣」「留言規則與導向」「粉專與 LINE 設定」「內測模擬」+ 「 | AI 客服中控台」。

**5. 權限**

- [ ] 未登入：無法進入上述 path（導向登入或 401）。
- [ ] 以 cs_agent / marketing_manager / super_admin 登入：四頁皆可進入，無 403、404 或白屏。

---

## 驗收證據（請附於 PR）

請擇一或都附：

1. **四頁路徑截圖**  
   - `/comment-center/inbox`（留言收件匣）  
   - `/comment-center/rules`（留言規則與導向，可含一子區）  
   - `/comment-center/channel-binding`（粉專與 LINE 設定）  
   - `/comment-center/simulate`（內測模擬）  

2. **短片**  
   - 從 sidebar 點選上述四項並確認 URL 與內容；  
   - 再示範一次舊 hash 導轉（例如 `/comment-center#page-settings` → `/comment-center/channel-binding`）。

**若無法產圖／錄影**，請依「需人工在瀏覽器驗證」清單執行並在 PR 中註明「已依清單逐項手動驗證通過」。

---

## 風險與未完成項

- **風險**：舊書籤若為 `/comment-center#xxx`，會導向新 path 並清除 hash，之後僅能以 path 深連結。
- **未完成**：P0-B（settings／brands／team）、P0-C（routes 拆分、API 驗證、文件）；chat layout 未動。留言中心仍為單一 `CommentCenterPage`，未拆成多個 Page 元件檔。

---

## 相關文件

- 實作藍圖與 P0-A 執行細節：`docs/P0-IMPLEMENTATION-PLAN.md`
- 產品化審查：`docs/PRODUCTIZATION-REVIEW-REPORT.md`
