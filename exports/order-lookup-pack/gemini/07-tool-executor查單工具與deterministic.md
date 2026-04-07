# 07 — `tool-executor.service.ts`：查單工具與 Deterministic

## 工具名稱（亦見 `openai-tools.ts`）

- `lookup_order_by_id`  
- `lookup_order_by_phone`  
- `lookup_order_by_product_and_phone`  
- `lookup_order_by_date_and_contact`  
- （另有分頁／Shopline 專用等，實作同檔內搜尋 `lookup_`）

## 共同模式

1. 參數驗證（單號、手機、日期區間等）。  
2. 呼叫 `order-service` / `shopline` / 本地 `order-index`。  
3. 組 **`orderSummaries`**（每筆含 `payment_status` kind、`payment_status_label`、結構化欄位）。  
4. **`formatOrderOnePage`** → `one_page_summary` 或 `one_page_full`。  
5. **`toolJson(...)`** = `finalizeLlmToolJsonString(toolName, JSON.stringify(payload))`（送 LLM 前清洗）。

## Deterministic（略過第二輪 LLM）

- **契約**：`deterministic-order-contract.ts` 定義 `deterministic_contract_version` / `deterministic_domain`。  
- **有效 payload**：`isValidOrderDeterministicPayload` 需 `deterministic_skip_llm === true` 且 `deterministic_customer_reply` 非空等。  
- **`lookup_order_by_id` 單筆**：付款 kind 為 `success` | `cod` | `pending` 且摘要長度 > 50 等條件成立時，帶 `packDeterministicSingleOrderToolResult`。  
- **`lookup_order_by_phone` 單筆**：`renderer: deterministic_phone_single`；條件含 **`!local_only`**、付款 kind、**`one_page_summary.trim().length > 50`**；並打 **`[DEBUG_PHONE_DETERMINISTIC]`** 日誌除錯。  
- **多筆手機（≤3 筆）**：可整段 deterministic 回傳（內文為多張卡片拼接）。

## 為何要 Deterministic

實務上 LLM 會 **過度摘要**（例如只留訂單號+收件人），違反「完整一頁格式」；程式直出可強制 **格式與欄位完整**。

## Local only

`data_coverage === "local_only"` 時單筆可能只回 **`formatLocalOnlyCandidateSummary`**（非最終定案），**不應**開 deterministic 全卡，避免誤導。

下一篇：**08** `openai-tools` 與 `ai-reply` 工具迴圈。
