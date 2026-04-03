# Multi-Brand Agent Ops — 文件索引

**定位**：內部約 10 品牌客服中台重構之設計與盤點（非對外 SaaS）。**實作前請先完成 Phase 0 審閱**，再依序 Phase 1→4。

| 階段 | 文件 | 說明 |
|------|------|------|
| **0** | [CURRENT_ARCHITECTURE_AUDIT.md](./CURRENT_ARCHITECTURE_AUDIT.md) | 現況架構盤點 |
| | [CURRENT_BRAND_LOGIC_MAP.md](./CURRENT_BRAND_LOGIC_MAP.md) | 品牌差異散落位置 |
| | [CURRENT_PROMPT_TOOL_FLOW.md](./CURRENT_PROMPT_TOOL_FLOW.md) | Prompt／工具／查單流程 |
| | [TARGET_MULTI_BRAND_ARCHITECTURE.md](./TARGET_MULTI_BRAND_ARCHITECTURE.md) | 目標架構（Shared Core + Overrides） |
| | [MIGRATION_AND_ROLLOUT_PLAN.md](./MIGRATION_AND_ROLLOUT_PLAN.md) | 遷移、feature flag、回滾 |
| | [RISKS_AND_OPEN_QUESTIONS.md](./RISKS_AND_OPEN_QUESTIONS.md) | 風險與未決議題 |
| | [ANTICIPATED_FILE_CHANGES.md](./ANTICIPATED_FILE_CHANGES.md) | 預計會動到的檔案 |
| **1** | [MULTI_BRAND_SCHEMA_DIFF.md](./MULTI_BRAND_SCHEMA_DIFF.md) | Schema 增修建議 |
| | [MULTI_BRAND_DATA_MODEL.md](./MULTI_BRAND_DATA_MODEL.md) | 資料模型（精簡） |
| | [BRAND_OVERRIDE_INHERITANCE.md](./BRAND_OVERRIDE_INHERITANCE.md) | 繼承鏈規格 |
| | [VERSIONING_AND_ROLLBACK_SPEC.md](./VERSIONING_AND_ROLLBACK_SPEC.md) | Draft／Publish／Rollback |
| **2** | [HYBRID_ROUTER_DESIGN.md](./HYBRID_ROUTER_DESIGN.md) | 硬規則 + LLM fallback |
| | [SCENARIO_ISOLATION_SPEC.md](./SCENARIO_ISOLATION_SPEC.md) | 四情境與單輪單主腦 |
| | [TOOL_WHITELIST_SPEC.md](./TOOL_WHITELIST_SPEC.md) | 情境工具白名單 |
| | [ROUTER_EDGE_CASES.md](./ROUTER_EDGE_CASES.md) | 邊界與衝突 |
| **3** | [CONVERSATION_TRACE_SPEC.md](./CONVERSATION_TRACE_SPEC.md) | Trace 後端結構 |
| | [RESPONSE_DECISION_TRACE.md](./RESPONSE_DECISION_TRACE.md) | 決策鏈欄位 |
| | [DEBUG_VIEW_REQUIREMENTS.md](./DEBUG_VIEW_REQUIREMENTS.md) | 對話除錯 UI 需求 |
| **4** | [LITE_ADMIN_INFORMATION_ARCHITECTURE.md](./LITE_ADMIN_INFORMATION_ARCHITECTURE.md) | Lite Admin 資訊架構 |
| | [UI_SCOPE_AND_NON_GOALS.md](./UI_SCOPE_AND_NON_GOALS.md) | 範圍與不做清單 |
| **測試** | [MULTI_BRAND_TEST_MATRIX.md](./MULTI_BRAND_TEST_MATRIX.md) | 驗證矩陣 |
| | [ROUTER_TEST_RESULTS.md](./ROUTER_TEST_RESULTS.md) | Router（待執行填報） |
| | [TOOL_ISOLATION_TEST_RESULTS.md](./TOOL_ISOLATION_TEST_RESULTS.md) | 工具隔離（待執行） |
| | [BRAND_OVERRIDE_TEST_RESULTS.md](./BRAND_OVERRIDE_TEST_RESULTS.md) | Override（待執行） |
| | [REGRESSION_TEST_RESULTS.md](./REGRESSION_TEST_RESULTS.md) | 迴歸（待執行） |

**與現有腦圖**：可交叉參考 `_rescue_archives/01_CURRENT_BRAIN_XRAY.md`（若路徑仍存在）。

**給 Gemini 等僅能讀 10 個檔案的閱讀器**：完整內容已合併至 [`gemini-10-pack/`](./gemini-10-pack/)（十檔、未刪節），請從該目錄 `01_索引與原始檔對照.md` 開始。
