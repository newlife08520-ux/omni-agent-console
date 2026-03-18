# Phase 2.7 驗收

| 需求 | 驗證方式 |
|------|----------|
| API 單筆 product+phone deterministic | phase27-verify + routes 實作 |
| 契約 version + domain | `isValidOrderDeterministicPayload`、phase27-verify |
| Fast path normalizer | routes 關鍵字 + flag |
| ai_log 新欄位 | DB migration + createAiLog INSERT |
| queue_wait | worker payload + run-ai-reply body |
| Latency parser | phase27 執行 query-latency-stats 於 sample log |
| Ultra-lite 獨立 + 長度 | order-ultra-lite 模組 + verify &lt; 1200 chars |
| Feature flags | order-feature-flags.ts |

**結論**：`npm run verify:phase27` 全綠即可視為本輪自動驗收通過。
