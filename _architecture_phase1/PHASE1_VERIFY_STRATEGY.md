# 驗證策略

- **必留**：phase34（訂單護欄）。
- **新增**：`phase1-agent-ops-verify.ts`（無 API、可 CI）。
- **既有 phase25–33**：依 `VERIFY_TRUTH_MATRIX.md` 逐步修復命名漂移；本輪未全數重跑（避免超出範圍），以 phase34 + check:server + build 為 gate。
