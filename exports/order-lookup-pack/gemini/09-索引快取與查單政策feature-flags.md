# 09 — 本地索引、查單政策、Feature Flags、多筆選擇

## `order-index.ts`

- SQLite **`orders_normalized`**（概念）存正規化後的訂單 payload，依 **brand_id + phone / order_id + source** 查詢。  
- `getOrdersByPhone`、`getOrderByOrderId` 等；`cacheKeyPhone` / `cacheKeyOrderId` 區分 `superlanding` / `shopline` / `any`。  
- **加速**：減少每次打外部 API；但可能 **資料較舊** → 故有 `data_coverage: local_only` 與 **live confirm** 等標記（見 `order-service`）。

## `order-lookup-policy.ts`

- **`resolveOrderSourceIntent`**：從使用者句子和最近訊息推斷是否 **偏好官網 Shopline**（關鍵字「官網」等），影響 **先打哪一邊 API**。  
- **`shouldBypassLocalPhoneIndex`**：特定語境下 **跳過本地索引**、強制走即時 API（避免錯單或 stale）。

## `order-feature-flags.ts`

- 環境變數開關，例如：  
  - **`ENABLE_PHONE_ORDER_DETERMINISTIC_REPLY`**（`phoneOrderDeterministicReply`）  
  - **`genericDeterministicOrder`**（與 by id 等路徑共用概念）  
- 關閉時工具仍回傳摘要，但 **不會** `deterministic_skip_llm`，LLM 可能改寫。

## `order-multi-selector.ts` / `order-product-filter.ts`

- 多筆命中時協助 **縮小候選**（商品語意、篩選），減少一次丟給客人過多筆。  
- 與 `tool-executor` 內「>5 筆只列簡表」等策略搭配。

## `order-multi-renderer.ts`

- 打包 **多筆 deterministic** 工具結果（含 `packDeterministicMultiOrderToolResult`），與簡表、失敗付款注意事項拼接。

## `order-ultra-lite.ts`

- 輕量提示用（若管線有引用），與主 prompt 分離，避免 order 規則過長。

下一篇：**10** 安全、捏造防護、Persona、檢查清單。
