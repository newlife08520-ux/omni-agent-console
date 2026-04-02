# Router 邊界案例

- 純英數 6～25 字無空格：可能被視為單號（與既有慣例一致）。
- 同時命中多規則：以函式內優先順序（單號、手機、物流、售後、商品）。
- LLM 回傳非 JSON 或含 markdown fence：`parseLlmIntent` 嘗試抽取程式碼區塊；失敗則 fallback。
- 無 API key：跳過 LLM，直接 fallback。
- `hybrid_router` 為 false：不呼叫 `runHybridIntentRouter`，僅 `mapPlanToPhase1Scenario`。
