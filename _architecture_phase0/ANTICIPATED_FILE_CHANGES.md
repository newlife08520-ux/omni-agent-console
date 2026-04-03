# 進入實作階段時，最可能修改的檔案／表／API／頁面

**聲明**：Phase 0 **未修改**下列檔案；本清單為 **預估**。

---

## 後端（高機率）

| 區域 | 路徑 |
|------|------|
| AI 主流程 | `server/services/ai-reply.service.ts` |
| Prompt | `server/services/prompt-builder.ts` |
| Tools 定義／篩選 | `server/openai-tools.ts`（或新增 `tool-policy.ts`） |
| Tool 執行 | `server/services/tool-executor.service.ts` |
| 計畫／路由銜接 | `server/reply-plan-builder.ts`、`server/conversation-state-resolver.ts` |
| 查單政策 | `server/order-lookup-policy.ts`（硬規則 router 可能呼叫） |
| Handoff | `server/services/handoff.ts` |
| Log | `server/db.ts`（`ai_logs` 欄位）、寫入 ai-reply 路徑 |
| 設定 API | `server/routes/settings-brands.routes.ts`、`server/controllers/*` |
| Webhook | `server/*webhook*`（若需傳遞新 context） |

---

## Schema／DB

- `ai_logs`：新增 JSON 或欄位（`router_*`、`scenario`、`allowed_tools`）。  
- `knowledge_files`：已有或將有 metadata／tag 欄位（以 `db.ts` migration 為準）。  
- 可選：`brand_feature_flags` 小表或 `settings` key 命名規範（`brand:{id}:...`）。  

---

## 前端

| 區域 | 路徑 |
|------|------|
| 品牌／渠道 | `client/src/pages/*brand*`、`brand-channel-manager*` |
| 知識 | `client/src/pages/*knowledge*` |
| 設定 | `client/src/pages/settings*` |
| 除錯／營運 | 新增 Lite Admin 頁或掛在既有 `performance`／`analytics`（待 IA） |

---

## 文件與驗證

- `docs/multi-brand-agent-ops/*` 更新與實作對齊。  
- `server/r1-verify.ts`：補 **fixture 檔**或調整路徑。  
- 新增或擴充 `npm run verify:*` 劇本（若引入 scenario 矩陣）。  
