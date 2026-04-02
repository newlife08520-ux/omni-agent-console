# 測試矩陣（Phase 1）

| ID | 項目 | 方式 | 預期 |
|----|------|------|------|
| T1 | TypeScript | `npm run check:server` | exit 0 |
| T2 | 建置 | `npm run build` | exit 0 |
| T3 | phase34 | `npx tsx server/phase34-verify.ts` | 7/7 OK |
| T4 | Router 硬規則 | `npm run verify:phase1-ops` | 單號→ORDER_LOOKUP 等 |
| T5 | Tool whitelist | 同上 | PRODUCT 無 lookup_order* |
| T6 | Flags off | 預設 brand JSON 空 | 行為同舊（程式路徑不組 iso） |
| T7 | trace_v2 | pilot + 一則 LLM 回覆 | `ai_logs` 新欄位有值 |
