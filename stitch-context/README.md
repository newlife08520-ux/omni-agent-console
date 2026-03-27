# Stitch UI Context — Omni-Agent Console

本包為 **純前端脈絡**：給 Stitch 做高保真介面優化用。  
**不含**後端、`node_modules`、建置產物、DB、env、token、API key、cookie 內容。

## 產品一句話

**AI 客服／全通路中控台**：客服與主管在網頁上處理即時對話、案件狀態、訂單脈絡，並在獨立頁調整 AI／知識庫設定。

## 檔案一覽（請依序餵給 Stitch）

| # | 檔案 | 用途 |
|---|------|------|
| 1 | `README.md` | 本說明 |
| 2 | `DESIGN.md` | 視覺語言與**不可違反**規則 |
| 3 | `ROUTES.md` | 側欄與路由結構 |
| 4 | `TARGET-PAGES.md` | 優先優化頁與 CTA |
| 5 | `judgment-home.md` | 即時客服頁（列表＋對話）說明 |
| 6 | `judgment-home-ui.txt` | 該頁 UI 結構精簡版（可讀程式脈絡） |
| 7 | `support-workbench.md` | AI 與知識庫頁說明 |
| 8 | `support-workbench-ui.txt` | 該頁 UI 結構精簡版 |
| 9 | `shared-ui.txt` | 共用元件與 shadcn 要點 |
| 10 | `app-shell.txt` | 登入後 shell、頂欄、權限 |
| 11 | `judgment-home-current.png` | 即時客服整體示意（**非截圖**，供構圖參考） |
| 12 | `judgment-home-fold1.png` | 左欄列表首屏示意 |
| 13 | `support-workbench-current.png` | 知識庫頁整體示意 |
| 14 | `support-workbench-fold1.png` | 知識庫頁首屏示意 |

## 圖片聲明

PNG 為 **結構示意**（wireframe 風格），非生產環境截圖。正式改版前請以本機 `npm run dev` 截圖替換。

## 原始碼真身（repo 內）

- 即時客服：`client/src/pages/chat.tsx`
- 知識庫：`client/src/pages/knowledge.tsx`
- Shell：`client/src/App.tsx`、`client/src/components/app-sidebar.tsx`

## 給 Stitch 的使用方式

請將 **本資料夾根目錄 14 個檔案** 依上表順序貼上／上傳（**不要**只餵 zip）。  
同目錄的 **`stitch-context.zip`** 僅供備份與傳檔，解壓後即為本包。

## 第二輪可選（`/performance` 客服績效）

路徑：`extra/`（共 4 個檔案，接在首輪 14 檔之後餵給 Stitch 即可）

| 檔案 | 用途 |
|------|------|
| `extra/support-diagnostics.md` | 績效／戰情頁說明與不可刪區塊 |
| `extra/support-diagnostics-ui.txt` | 版面與 Tabs／圖表結構精簡版 |
| `extra/support-diagnostics-current.png` | 儀表板整頁構圖示意 |
| `extra/support-diagnostics-fold1.png` | 首屏 KPI 列示意 |
