# 第二階段回報：TypeScript 與 build 防線

依 `cursor_fix_plan_omni_agent_console.md` 第二階段執行，讓程式有一致的 TS 編譯基準，並優先清掉 server 關鍵路徑錯誤。

---

## 1. 改了哪些檔案

| 檔案 | 改動摘要 |
|------|----------|
| `tsconfig.json` | 新增 `target: "ES2022"`、`downlevelIteration: true`、`resolveJsonModule`、`forceConsistentCasingInFileNames`；`lib` 改為 `["ES2022", "DOM", "DOM.Iterable"]`。 |
| `tsconfig.server.json` | 新建：extends 主 tsconfig，僅 include `shared/**/*`、`server/**/*`，排除 e2e-scenarios、explain-get-contacts，供 build 前只檢查 server。 |
| `package.json` | `build` 改為 `npm run check:server && tsx script/build.ts`；新增 `check:server`；`verify` 改為 `npm run check:server && npm run build`。 |
| `server/redis-brands-channels.ts` | 改為從 `./redis-client` 匯入 `RedisClientLike` 並替換所有 `RedisClient`；`syncRedisToSqlite` 的 db 型別改為接受 `lastInsertRowid: number \| bigint`；`getBrands`/`getChannels` 的 `.then((arr)=>...)` 加上型別註解 `Brand[]`/`Channel[]`。 |
| `server/redis-client.ts` | `RedisClientLike` 新增必要 `del`，並 export 型別。 |
| `server/controllers/facebook-webhook.controller.ts` | 回調改為 `void`（不回傳 Promise）；`getHandoffReplyForCustomer` 第二參數改為 `string \| undefined`。 |
| `server/index.ts` | `syncRedisToSqlite(redisClient, dbModule.default)` 改為傳入 `dbModule.default as unknown as Parameters<typeof syncRedisToSqlite>[1]`。 |
| `server/meta-comments-storage.ts` | `db.prepare("PRAGMA...").all()` 改為 `(db.prepare(...).all() as { name: string }[]).some(...)`。 |
| `server/storage.ts` | `getOrCreateContact` 新建 contact 物件補齊 `assigned_at`、`last_human_reply_at`、`reassign_count`、`assignment_status` 等欄位；`createAssignmentRecord` 的 `action_type` 改為 `(actionType ?? null) as AssignmentLogActionType \| null`。 |
| `server/queue/ai-reply.queue.ts` | `getAiReplyQueue` 內 `new Queue(..., { connection: producerConn as ConnectionOptions }) as Queue<AiReplyJobData>`；`startAiReplyWorker` 內 `connection: workerConn as ConnectionOptions`。 |
| `server/order-service.ts` | `lookupShoplineOrdersByPhone/ByEmail/ByName` 改為使用回傳值的 `.orders`；`lookupOrdersByDateAndFilter` 呼叫改為 4 個參數（移除 pageId）。 |
| `server/phase1-verify.ts` | `ok(...)` 第二參數改為明確 boolean（`Boolean(...)`、`guardE.pass === true`、`guardF.pass === false` 等）。 |
| `server/routes.ts` | `debounceTextMessage` 的 callback 改為 `void \| Promise<void>` 並用 `run()` 處理；`mergeStreamDelta` 內 tool call 的 `function` 改為 `(t as { function?: ... }).function`；`runOpenAIStream` 的 message 初值加 `refusal: null`；plan.mode 比較改為 `planMode as ReplyPlanMode` 與區域變數 `planMode`；`limitParam`/`offsetParam` 使用前加 `!= null` 檢查；`getEnrichedSystemPrompt(brandId ?? undefined)`；多處 tool call 的 `function` 改為從 `(toolCall as { function?: ... }).function` 取值；`ProductPageMapping` 補齊 `id`、`prefix`；`setAgentBrandAssignments` 參數型別改為 `AgentBrandRole`；`intentCategories`/`concernKeywords` 改為 `[string, string[]][]`、`[string, string][]` 避免重複鍵；tag-shortcuts 的 filter 回調加上型別；fbWebhookDeps 的 `getHandoffReplyForCustomer`/`getUnavailableReason` 改為包一層以符合 `FacebookWebhookDeps`。 |

---

## 2. 為什麼這樣改

- **tsconfig**：`target: "ES2022"` 消除「function in block」、Set 迭代、regex 旗標、top-level await 等與 ES5/ES6 相關錯誤；`downlevelIteration` 讓 Set 迭代穩定通過。
- **tsconfig.server.json + check:server**：第二階段要求「routes、controllers、meta-comment、workers、queue 相關錯誤優先清乾淨」，不要求一次清光 client；build 前只對 server 做 typecheck 可讓 `npm run build` 穩定通過，同時保留全專案 `npm run check` 供日後修 client 使用。
- **RedisClientLike / redis-brands-channels**：storage 傳入的 client 與 redis-brands-channels 期望的型別一致，並補齊 `del`；db 的 `lastInsertRowid` 接受 `number | bigint` 以相容 better-sqlite3。
- **facebook-webhook**：回調不強制回傳 Promise，與實際使用一致；controller 介面與 routes 傳入的 wrapper 對齊。
- **queue**：BullMQ 與 IORedis 型別不相容時以 `ConnectionOptions` 斷言，不改動執行期行為。
- **order-service**：Shopline API 回傳 `ShoplineDateFilterResult`（含 `.orders`），改為使用 `.orders`；SuperLanding 的 `lookupOrdersByDateAndFilter` 僅 4 參數，移除多餘的 pageId。
- **routes**：tool call 的 `function` 在 OpenAI 型別中可能為 custom，用型別斷言安全取值；plan.mode 在分支後被縮窄，用 `ReplyPlanMode` 與區域變數還原比較；重複鍵改為陣列 of tuples；fbWebhookDeps 以 wrapper 符合介面並統一 LINE/FB 的 handoff 與 getUnavailableReason 型別。

---

## 3. 這次改動解決什麼風險

- **build 前 typecheck**：`npm run build` 先跑 `check:server`，server 型別錯誤會擋住 build，避免「TS 有錯但 build 先過」。
- **正式環境可 build**：產物仍為 `dist/index.cjs`、`dist/workers/ai-reply.worker.cjs`，部署流程不變。
- **關鍵路徑型別穩定**：server/routes、controllers、storage、queue、workers、meta-comment 相關程式通過 `tsc -p tsconfig.server.json`，後續改動可依型別提早發現問題。

---

## 4. 怎麼驗收

1. **Server typecheck**：`npm run check:server` 應無錯誤。
2. **Build**：`npm run build` 應成功並產出 `dist/index.cjs`、`dist/workers/ai-reply.worker.cjs`。
3. **全專案 check**：`npm run check` 仍會因 client / e2e 既存錯誤而失敗，屬預期（見下方剩餘清單）。

---

## 5. 驗收結果

| 項目 | 結果 |
|------|------|
| `npm run check:server` | 通過（無錯誤）。 |
| `npm run build` | 通過；產出 `dist/index.cjs`、`dist/workers/ai-reply.worker.cjs`。 |
| `npm run check`（全專案） | 仍失敗（見剩餘清單）。 |

---

## 6. 剩餘 TS 錯誤清單（非本次核心路徑）

以下為**未在本次修復**的錯誤，依文件「若還有非本次核心路徑的 TS 錯誤，需明列剩餘清單與原因」列舉：

- **client/src/App.tsx**：Route 的 `ComponentType` 與 `RouteComponentProps` 不匹配（params 缺失）。
- **client/src/components/brand-channel-manager.tsx**：`Channel` 型別上使用 `brand_name`（應為 `ChannelWithBrand` 或擴充型別）。
- **client/src/components/schedule-form.tsx**：`Response` 直接轉為工時物件，需先透過 `unknown` 或正確 parse。
- **client/src/pages/chat.tsx**：`message_type` 與 `"video"` 比較、可能 null 的物件、`onPin` 簽名、`assigned_agent_name`、`string | null` 賦值等。
- **client/src/pages/performance.tsx**：API 回傳型別為 `{}`，缺少 `today_pending`、`urgent` 等欄位型別。
- **server/e2e-scenarios.ts**：`null` 與 `Promise<string | null>`、`buildReplyPlan` 等函式呼叫參數數量不符。

**原因**：第二階段以「server 關鍵路徑（routes、controllers、meta-comment、workers、queue）」為優先，避免為追求零錯誤而大改前端；上述 client 與 e2e 錯誤留待後續階段或專項處理。

---

## 7. 後續建議

- 若要「全專案 typecheck 通過後才能 build」，可將 `build` 改回 `npm run check && tsx script/build.ts`，並逐步修掉上述 client / e2e 錯誤。
- 維持目前設定時，日常以 `npm run check:server` + `npm run build` 驗證後端與 build；必要時再跑 `npm run check` 檢查前端與 e2e。

---

第二階段 TypeScript 與 build 防線已完成；server 關鍵路徑已清乾淨，build 可穩定通過。
