# Phase 2.7 Launch Hardening 報告

## 完成項目

| 區塊 | 內容 |
|------|------|
| **A** | `lookup_order_by_product_and_phone` API 單筆 → `deterministic_single_product_phone_api` + 契約欄位 |
| **契約** | `deterministic_contract_version: 1`、`deterministic_domain: "order"`；multi/single packer、電話查單多筆/單筆、本地商品+手機 multi 皆帶契約 |
| **B** | Fast path 經 `normalizeCustomerFacingOrderReply`（可 `ENABLE_ORDER_FINAL_NORMALIZER=0` 關閉）；主路徑／multi／active 同理 |
| **C** | `ai_logs` 新增：`used_first_llm`、`used_second_llm`、`reply_renderer`、`prompt_profile`、`first_customer_visible_reply_ms`、`lookup_ack_sent_ms`、`queue_wait_ms` |
| **Queue** | Job 帶 `enqueuedAtMs`；`/internal/run-ai-reply` 收 `enqueueTimestampMs` → `queue_wait_ms` |
| **Telemetry** | 第一輪 LLM 後 `used_first_llm=1`；tool loop 內第二輪 LLM 前 `used_second_llm=1`；deterministic 時第二輪為 0；`used_llm`＝任一輪有呼叫則 1 |
| **D** | `server/prompts/order-ultra-lite.ts` 獨立；`ENABLE_ORDER_ULTRA_LITE_PROMPT=0` 時回退 legacy slice |
| **E** | `server/order-feature-flags.ts`（env 開關） |
| **F** | `server/scripts/query-latency-stats.ts`：讀檔或 stdin，輸出 p50/p95/max 與分桶 |
| **驗證** | `verify:phase27`、`phase27-verify.ts`（12 項） |

## 新增／主要修改檔案

- `server/deterministic-order-contract.ts`
- `server/order-feature-flags.ts`
- `server/prompts/order-ultra-lite.ts`
- `server/phase27-verify.ts`
- `server/db.ts`（migrateAiLogsPhase27Telemetry）
- `server/storage.ts`、`shared/schema.ts`（ai_logs）
- `server/routes.ts`、`server/queue/ai-reply.queue.ts`、`server/workers/ai-reply.worker.ts`
- `server/order-single-renderer.ts`、`server/order-multi-renderer.ts`
- `server/services/prompt-builder.ts`
- `package.json`（`verify:phase27`、`stats:latency`）

## 部分完成／後續

- FB 留言專用策略仍以文件 playbook 為主，程式未另拆 channel 分支。
- Latency parser 依 log 行文字解析，若 log 格式變更需同步調整 regex。
