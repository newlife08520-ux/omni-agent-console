# 設計語言與元件層級

來源：`client/src/index.css`（CSS 變數）、`tailwind.config.ts`、`App.tsx`／`app-sidebar.tsx` 實際 class。

## 產品視覺語言

- **主背景**：淺暖灰 `#faf9f5`（`App` 主內容區）。
- **側欄**：深色 `stone-800` 底、白字；**強調色**常見 `emerald`（在線、正向）、`amber`／`red`／`sky` 做狀態區分。
- **頂欄**：白底、底邊 `stone-200`、輕 backdrop blur。
- **整體**：偏 **營運後台、高資訊密度**，非消費型行銷頁。

## 色彩／字級／間距／圓角／陰影

- **CSS variables**：`--primary`、`--destructive`、`--radius`（預設約 `.5rem`）、`--chart-*` 等（見 `index.css` `:root`）。
- **Tailwind**：與 shadcn **new-york**、`neutral` base、`cssVariables: true`（`components.json`）。
- **語意色（chat 內）**：`STATUS_SEMANTIC` — 紅＝高風險／逾時、橘＝待處理、藍＝已分配、綠＝正常、灰＝待分配等（見 `chat.tsx` 開頭常數）。

## 元件層級

| 層級 | 說明 | 典型元件 |
|------|------|----------|
| 主按鈕 | 主要行動 | `Button` default / primary |
| 次按鈕 | 次要、並列操作 | `Button variant="outline"`、`ghost`、`secondary` |
| 危險 | 刪除、不可逆 | `destructive` |
| 卡片 | 區塊分組 | `Card` |
| 表格／列表 | 高密度資料 | `Table`、chat 內自組列表列 |
| Badge | 狀態濃縮 | `Badge`、自訂顏色 class |

## 全站共用（shadcn／ui）

目錄：`client/src/components/ui/*` — Button、Card、Badge、Table、Tabs、Dialog、Sheet、Drawer、Select、Input、ScrollArea、Dropdown、Avatar、Toast 等。

## 高資訊密度頁（不可過度簡化）

- **`/` 即時客服**：列表多欄位、徽章、對話時間序、右側訂單／付款／履行狀態。
- **留言中心**：規則與表格並存。
- **知識庫**：長表單與分區設定。
- **績效／數據**：多指標與篩選。

## Icon

- **lucide-react** 為主（側欄、按鈕、狀態）。
- **Logo**：由設定 `logo_url` 動態載入（頂欄／側欄），打包內無固定檔案時見 `06_reference_assets/README.md`。
