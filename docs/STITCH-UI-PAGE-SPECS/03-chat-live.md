# 即時客服（對話工作台）

## 1. 頁面用途
- **做什麼**：依聯絡人處理即時對話、檢視/查詢訂單與客戶欄位、指派與案件操作。
- **給誰**：`super_admin`、`marketing_manager`、`cs_agent`。
- **情境**：日常回覆、查單、轉人工、改派、標記追蹤等。

## 2. 進入方式
- **route**：`/`。
- **從哪進**：側欄「即時客服」、通知連結、側欄快捷（同 path 換 view）。
- **權限**：全員可進；部分按鈕僅 `isManager`。

## 3. 首屏必須看到的內容
1. **SSE/輪詢警示條**（斷線時頂部琥珀橫條 + 重新整理）。
2. **左欄 300px**：搜尋 `input-search-contacts`、view 按鈕（全部/我的案件/待我回覆/緊急/待追蹤）、平台篩選（全部/LINE/FB）、目前品牌文案、虛擬化列表或空狀態。
3. **中欄**：未選聯絡人時空狀態「選擇一位聯絡人」；已選時訊息串 + 下方輸入列。
4. **右欄**（已選時）：標題列含指派/改派/解除指派（依狀態）、`tab-info` 客戶資訊 / `tab-orders` 訂單查詢。
5. **composer**：`button-send-message`（傳送）與輸入框 `input-message` 同區可見。

## 4. 區塊排列順序
- **左→中→右** 三欄；中欄上下分「訊息區」與「composer」。
- 右欄內 Tabs：客戶資訊 | 訂單查詢；訂單內再含查詢模式與結果區（**待確認**：所有子區塊名稱以 `chat.tsx` 為準）。

## 5. 按鈕盤點
### A. 主按鈕
- **`button-send-message`「傳送」**：完成回覆；composer 右側 emerald。
- **選取聯絡人**：整列可點（非單一 named button），屬主互動。
### B. 次按鈕
- `button-assign`、`button-reassign`、`button-view-orders`、`button-search-order`、`button-product-search`、`button-adv-search`、快捷回覆 `button-quick-reply`、附件 `button-attach-file`。
### C. 危險
- `button-unassign`（解除指派）、`button-transfer-human`（轉人工）、結案/高風險操作（**部分待確認**完整列表）。
- `button-restore-ai`（恢復 AI）與轉人工應成對可辨識。
### D. 輔助
- `button-copy-menu`、`button-more-actions`（評價卡片等 LINE）、`button-add-tag`、釘選（ContactListItem 內）。

## 6. 篩選 / 控制
- **search**：左欄頂。
- **viewMode**：`button-view-*`。
- **platformFilter**：`button-filter-all|line|messenger`。
- **品牌**：依側欄全域 `selectedBrandId`，左欄顯示「目前品牌：…」。
- 列表底：**載入更多**、SSE/輪詢、`vite` build 提示列——**診斷資訊，首屏可見於列表下方**。

## 7. 狀態 / badge / warning
- 列表列語意色：`STATUS_SEMANTIC`（danger/warning/assigned/normal/muted）。
- 訂單付款/履行標籤（`getPaymentStatusLabel` 等）。
- 人工/AI 模式區塊（頂部工具列附近）。
- **不可**把 SSE 斷線條或列表診斷列完全隱藏。

## 8. 可收合但不能消失
- 快捷回覆 dropdown、更多選單可收合；入口按鈕须保留。
- 右欄訂單查詢子 Tab 可視覺整合但**三種查單模式**語意须保留。

## 9. 最不能被 AI 誤改
- 三欄布局語意；composer 與傳送。
- 查單結果區不可深埋到僅圖示才開。
- 轉人工 / 恢復 AI 與模式顯示。

## 10. Stitch 用摘要
即時客服為三欄：左 300px 搜尋+view+平台篩選+聯絡人虛擬列表（含載入更多與連線狀態列）；中為訊息+底部輸入與傳送（主 CTA）；右為客戶資訊/訂單查詢 Tabs 與指派改派等。次按鈕含快捷回覆、附件、查單。危險含解除指派、轉人工。斷線琥珀條與列表底診斷列不可刪。視覺可優化密度與圓角，但不可改單欄失能流程、不可藏傳送與查單結果。
