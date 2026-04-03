# 預計會修改／新增的檔案（實作階段參考）

**僅為預估清單**，實作時以 PR 為準。Phase 0 **不改這些檔**。

---

## 高機率修改

| 路徑 | Phase | 理由 |
|------|-------|------|
| `server/db.ts` | 1 | 新表／欄位 migration |
| `server/storage.ts` | 1,3 | CRUD、trace 寫入 |
| `server/services/prompt-builder.ts` | 1,2 | Resolved config 組裝、依 scenario 切片 |
| `server/services/ai-reply.service.ts` | 2,3 | Router hook、tool 子集、trace |
| `server/openai-tools.ts` | 2 | 工具分組常數（optional） |
| `server/conversation-state-resolver.ts` | 2 | 與新 router 銜接或委派 |
| `server/reply-plan-builder.ts` | 2 | 映射或漸進替換 |
| `server/routes/core.routes.ts` | 1,3,4 | 新 API、debug payload |
| `server/routes/settings-brands.routes.ts` | 1,4 | 版本與 draft API |
| `client/src/pages/settings.tsx` | 4 | 全域設定與警告 |
| `client/src/pages/brands-channels.tsx` | 4 | 版本／發布入口 |
| `client/src/pages/chat.tsx` | 3,4 | Debug trace 面板 |
| `shared/schema.ts` | 1 | 型別擴充 |

---

## 中機率修改

| 路徑 | Phase |
|------|-------|
| `server/order-feature-flags.ts` | 1 | 與 per-brand flag 並存或收斂 |
| `server/controllers/line-webhook.controller.ts` | 2,3 |
| `server/controllers/facebook-webhook.controller.ts` | 2,3 |
| `server/routes/meta-comments.routes.ts` | 2+（若對齊 channel override） |
| `client/src/pages/knowledge.tsx` | 1,4 | 情境標籤（若有） |

---

## 可能新增（建議目錄）

| 路徑 | 說明 |
|------|------|
| `server/agent-ops/resolve-config.ts` | merge Global→Brand→Channel→Scenario |
| `server/agent-ops/hybrid-router.ts` | rule + LLM JSON |
| `server/agent-ops/tool-policy.ts` | whitelist |
| `client/src/pages/agent-ops-publish.tsx` | Lite Publish Center（可併入 brands） |
| `docs/multi-brand-agent-ops/*` | 已存在，持續更新 |

---

## 建議不要大動

- `server/services/tool-executor.service.ts`（**行為**保持，僅呼叫端限制工具）
- `server/order-service.ts` / `server/order-index.ts`（查單核心）
- Webhook **HTTP 契約**
