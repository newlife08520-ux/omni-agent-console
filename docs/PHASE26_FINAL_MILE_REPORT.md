# Phase 2.6 Final-mile 報告

## 目標

將查單流程收斂為：**能 deterministic 則跳過第二輪 LLM**、**最終對客文字經 normalizer**、**可查 log 驗證**、**查單 prompt 改為 ultra-lite**。

## 已實作

### A. Generic deterministic（`server/routes.ts`）

- Tool loop 改為解析任意 tool 的 JSON：只要 `deterministic_skip_llm === true` 且 `deterministic_customer_reply` 非空即採用。
- **同輪多 tool**：以最後一筆（與 `tool_calls` 順序一致）為準。
- Log：`deterministic_tool_reply_selected=true renderer=... tool_name=... second_llm_skipped=true`

### B. 單筆 deterministic

- `server/order-single-renderer.ts`：`packDeterministicSingleOrderToolResult` / `buildSingleOrderCustomerReply`
- 已接單筆：`lookup_order_by_id`、`lookup_order_by_product_and_phone`（local 單筆）、`lookup_order_by_date_and_contact`、`lookup_more_orders`、`lookup_more_orders_shopline`
- Active context 仍統一走 `buildActiveOrderContextFromOrder`

### C. Final-mile normalizer

- `server/customer-reply-normalizer.ts`：`normalizeCustomerFacingOrderReply(text, { mode, replySource, renderer, platform })`
- 接在 guards 之後、`createMessage` / push 之前（含 multi_order、active_order 短路、一般 LLM 路徑）
- Log：`final_normalizer_changed=`、`normalizer_rules=`

### D. Prompt Slimming v2

- `getBrandReplyMeta(brandId)`、`buildOrderLookupUltraLitePrompt`、`buildOrderFollowupUltraLitePrompt`
- `prompt_profile`：`order_lookup_ultra_lite` / `order_followup_ultra_lite`

### E. 延遲觀測

- `[phase26_latency] lookup_ack_sent_ms=...`
- `first_customer_visible_reply_ms`、`final_reply_sent_ms`、`second_llm_skipped`、`final_renderer=llm|deterministic_tool`
- `server/scripts/query-latency-stats.ts`（說明如何從 log 彙整）

### F. 驗證

- `server/phase26-verify.ts`、`npm run verify:phase26`（含 phase24/25、hardening、stats）

## 修改檔案（核心）

| 檔案 | 說明 |
|------|------|
| `server/routes.ts` | Generic deterministic、單筆回傳、normalizer、latency log、ai_log reply_source |
| `server/customer-reply-normalizer.ts` | 新增 |
| `server/order-single-renderer.ts` | 新增 |
| `server/services/prompt-builder.ts` | ultra-lite + getBrandReplyMeta |
| `server/phase26-verify.ts` | 新增 |
| `server/phase25-verify.ts` | 對齊 ultra_lite profile |
| `server/scripts/query-latency-stats.ts` | 新增 |
| `package.json` | `verify:phase26`、`stats:latency-help` |

## 刻意未處理 / 後續

- **佇列延遲**：`queue_wait_ms` 目前 webhook 主路徑 log 為 0；若改 worker 佇列需另接 enqueue 時間戳。
- **多 tool 非 order**：generic 會採用任意帶契約的 tool；若未來需限制僅 order 類 tool，可加 allowlist。
- **fast path**：未強制走 normalizer（多為短句）；若需一致可再包一層輕量 normalize。
