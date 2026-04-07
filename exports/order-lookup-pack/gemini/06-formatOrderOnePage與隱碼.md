# 06 — `formatOrderOnePage`、隱碼與對客欄位

## 檔案

`order-reply-utils.ts`

## `formatOrderOnePage` 輸出結構（固定多行文字）

典型欄位順序（有值才顯示的會略過空值，但 **「商品：」永遠有一行**，空則「暫無明細」）：

1. 訂單編號  
2. 收件人（`maskName`）  
3. 電話（`maskPhone`；若 API 無電話可傳 `display_phone_if_missing` 用客人輸入號做隱碼）  
4. 下單時間  
5. 商品（由 `formatProductLinesForCustomer` 解析 JSON／字串）  
6. 金額  
7. 付款（結合 COD 判斷、`displayPaymentMethod`、`customerFacingPaymentLabel`）  
8. 配送／取貨門市或寄送地址（超商 vs 宅配分支）  
9. 物流單號、狀態、出貨時間（有則顯示）

## 隱碼（`tool-llm-sanitize.ts`）

- **`maskName`**：中文姓名中間打星、英文取前兩字 + `***`。  
- **`maskPhone`**：保留前 4、後 3 數字，中間 `***`。  
- **`maskAddress`**：縣市區後 `***`（避免完整地址外洩）。

工具 JSON 送進 LLM 前，`finalizeLlmToolJsonString` 會對訂單類物件做 **PII 遮罩**，與 `formatOrderOnePage` 對客層互補。

## `displayShippingMethod` / `displayPaymentMethod`

- 將 **工程代碼**（`to_home`、`tw_711`、`pickup`）轉成 **中文情境句**（含「取貨付款」與「宅配到府（貨到付款）」等）。  
- 若字串已含中文且無法歸類，可能 **原樣返回**（避免錯殺）。

## 禁止事項（與 Persona 一致）

- 訂單區塊應 **與工具 `one_page_summary` 一致**，不可自行改付款方式（例如把貨到付款講成要線上刷卡）。  
- 多筆訂單時工具可能給 `one_page_full` 與嚴格 `sys_note`（見工具回傳）。

下一篇：**07** `tool-executor` 查單工具與 deterministic。
