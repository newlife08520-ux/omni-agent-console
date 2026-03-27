# support-workbench — AI 與知識庫（路由 `/knowledge`）

## 用途

管理 **全域 system prompt、品牌語氣、知識檔、行銷規則、圖像素材**，並以 **沙盒**試聊驗證（不取代後端安全檢查）。

## 主要使用者

超級管理員、行銷經理（客服角色 **無權** 進入）。

## 首屏必須看到的區塊

1. 頁面標題與品牌上下文（若有選中品牌）
2. **Tabs**：`prompt` | `images` | `marketing` | `sandbox`
3. 預設 **Prompt** 分頁：全域 `Textarea`、品牌 `Textarea`、儲存按鈕

## 主操作

- **儲存**全域／品牌 prompt
- **預覽組合後 prompt**（若顯示）

## 次操作

- 知識檔上傳／刪除、行銷規則編輯、圖像素材維護、沙盒送訊

## 危險操作

- 覆寫 production 級 prompt、大量刪除知識檔（需強視覺警示與確認）

## 不可刪／不可合併消失

- 四個 **Tabs** 及其 **data-testid**（`tab-prompt`、`tab-images`、`tab-marketing`、`tab-sandbox`）
- 沙盒區（測試對話）— 可摺疊不可移除
- 與 API 無關的 **操作結果 toast** 行為（成功／失敗需可感知）

## 附圖

- `support-workbench-current.png`、`support-workbench-fold1.png`：表單＋分頁構圖參考（示意）。
