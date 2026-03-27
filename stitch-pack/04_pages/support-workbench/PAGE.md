# support-workbench — AI 與知識庫

**對應路由**：`/knowledge`  
**原始碼**：`client/src/pages/knowledge.tsx`

## 1. 頁面用途

管理 **AI 行為、知識庫、與對話相關之前台設定**（實際欄位以檔案為準）。

## 2. 主要使用者

超級管理員、行銷經理（cs_agent **無權** 進入，見 `ROUTE_ACCESS`）。

## 3. 首屏必須看到的區塊

- 頁面標題與 **儲存／預覽** 區塊。
- 主要設定分區（例如：全域 prompt、品牌、知識來源等 — 以 `knowledge.tsx` 為準）。

## 4. 主操作按鈕

- **儲存**、**預覽 prompt**（若存在 `data-testid` 可搜尋 `button-preview-prompt`）。

## 5. 次操作按鈕

- 重設、匯入／匯出（若有）、分頁切換。

## 6. 危險操作

- 覆寫 production prompt、清空知識庫：需強警示。

## 7. 重要但目前可能亂

- 長表單無分段；可 **錨點導覽** 或 **左側子導航**，不可刪設定項。

## 8. 可收合但不能消失

- 進階選項、API 說明、警告區塊。

## 9. 頁面狀態

loading / empty（無品牌？）/ partial / success / error — 見 `states/*.json`。
