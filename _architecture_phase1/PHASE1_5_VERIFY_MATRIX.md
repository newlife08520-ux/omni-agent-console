# Phase 1.5 驗證矩陣

| ID | 項目 | 指令／方式 |
|----|------|------------|
| V1 | TypeScript | `npm run check:server` |
| V2 | 建置 | `npm run build` |
| V3 | phase34 | `npx tsx server/phase34-verify.ts` |
| V4 | Phase1 smoke | `npm run verify:phase1-ops` |
| V5 | Phase15 深度 | `npm run verify:phase15` |
| V6 | DB 取證 | `DATA_DIR` 隔離 + `phase15-evidence-harness` |

## Router
- 硬規則：SKU／優惠碼／KBT／售後+物流
- mock LLM 成功／parse fail→legacy
- plan bridge 有／無單號信號

## Prompt
- AFTER_SALES iso 不含「有單號直接查」；legacy 仍含

## Tool / Trace
- PRODUCT 無 lookup；trace_v2 on/off extras；scenario_overrides 解析
