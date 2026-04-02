# Hybrid Router 規格

1. **硬規則**：訂單編號樣式、手機與查單語境、物流關鍵字、售後關鍵字、商品規格關鍵字。
2. **LLM**：僅在規則未高信心命中時；輸入最新訊息與 `recentUserTexts` 末段；輸出 JSON `intent` 與 `confidence`；模型來自 `resolveOpenAIRouterModel()`（環境變數 `OPENAI_ROUTER_MODEL` 或 `settings.openai_router_model`）。
3. **Fallback**：`legacy_fallback`，對照 `plan.mode` 與 `issue_type`／`primary_intent`。
