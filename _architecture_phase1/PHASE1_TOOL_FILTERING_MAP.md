# Tool 過濾對照

- 過濾發生在 `ai-reply.service.ts` 建立 `allTools` 時，僅當 `enabled && tool_whitelist && phase1Route`。
- Executor 不變；OpenAI 僅看得到子集合，無法呼叫被移除之 function。
