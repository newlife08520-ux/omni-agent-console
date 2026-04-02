# Phase 1.5 Router 主導性

採用 A（router-aware plan bridge）加 B（route-governed deterministic 閘門）。

Plan bridge：buildReplyPlan 前以 computePhase15HardRoute 產生 phase1PreRoute；product_consult 等若具單號與查單語境可升格 order_lookup。flags 關閉時 phase1PreRoute 為 null。

Deterministic 閘門：phase1OrderDetourOk 為 false 時（Phase1 開且情境非 ORDER_LOOKUP）跳過多筆查單捷徑與查單上下文注入。

LLM：preComputedHard 避免重算；mockLlmRawResponse 僅測試用。
