# 檔案變更對照

- `server/services/intent-router.service.ts`：新增 Hybrid Router
- `server/services/tool-scenario-filter.ts`：新增情境 tool 過濾
- `server/services/phase1-types.ts`：型別
- `server/services/phase1-brand-config.ts`：JSON flags 解析
- `server/services/ai-reply.service.ts`：串接 router、whitelist、trace、assemble 參數
- `server/services/prompt-builder.ts`：情境組裝、`shippingHintOverride`、知識長度參數
- `server/openai-model.ts`：`resolveOpenAIRouterModel`
- `server/db.ts`：migration brands + ai_logs
- `server/storage.ts`：`createAiLog` 擴充
- `shared/schema.ts`：`Brand`、`AiLog` 型別
- `package.json`：`verify:phase1-ops`
- `server/phase1-agent-ops-verify.ts`：本地行為驗證
