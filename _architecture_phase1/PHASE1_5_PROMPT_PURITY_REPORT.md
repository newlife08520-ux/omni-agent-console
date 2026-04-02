# Phase 1.5 Prompt 純度報告

## 情境專屬流程區塊
- iso 模式下以 buildScenarioFlowBlock(scenario) 取代混合式 buildFlowPrinciplesPrompt。
- 驗證：AFTER_SALES 與 GENERAL 區塊不含「有單號直接查」等全情境查單句；ORDER_LOOKUP 保留查單與工具指引。
- legacy：flags 關閉或非 iso 時仍使用原 buildFlowPrinciplesPrompt，行為不變。

## 品牌 system_prompt 污染
- 措施：iso 時改為 buildBrandPersonaPromptIsoThin（約 1400 字截斷，並提示優先遵守情境流程）。
- 仍保留：全域 buildGlobalPolicyPrompt 仍為完整 DB 字樣；若品牌於 system_prompt 內寫死跨情境 SOP，摘要截斷後仍可能殘留部分語意。後續可改 DB 分拆或以 scenario_overrides.prompt_append 補強。

## scenario 覆寫
- phase1_agent_ops_json.scenario_overrides 的 prompt_append 可附加品牌細則，不取代 iso 流程區塊。
