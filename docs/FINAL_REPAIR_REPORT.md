# 最終補修報告（FINAL_REPAIR_REPORT）

依 `final_cursor_repair_spec_2026-03-16.md` 執行，本輪完成 P0 五項，並產出交付文件。

---

## A. 本輪完成項目

1. **P0-1 全面修復亂碼污染**：修正 `server/routes.ts` 內 LEGAL_RISK_KEYWORDS、FRUSTRATED_ONLY_KEYWORDS、RETURN_REFUND_KEYWORDS、ISSUE_TYPE_KEYWORDS 為正確中文關鍵字；修正 getTransferUnavailableSystemMessage 文案；修正登入/權限等 API 錯誤訊息。
2. **P0-2 prompt preview 內容判斷正規化**：`server/services/prompt-builder.ts` 改為回傳 `EnrichedPromptResult`（full_prompt、sections、includes）；穩定 section key 為 `--- CATALOG ---`、`--- KNOWLEDGE ---`、`--- IMAGE ---`；`/api/debug/prompt-preview` 改為使用 `includes.catalog / knowledge / image`，不再用亂碼字串判斷。
3. **P0-3 worker_unavailable 真實降級策略**：heartbeat 過期時改為**不 enqueue**，先記錄 `blocked:worker_unavailable`，再 **fallback inline** 呼叫 `autoReplyWithAI`；`/api/debug/runtime` 新增 `degraded_mode`。
4. **P0-4 統一 DB source-of-truth**：新增 `docs/PACKAGING_AND_DB_SOURCE_OF_TRUTH.md`；`.gitignore` 排除 `data_coldstart/`；明確定義唯一正式 DB 為 `${DATA_DIR}/omnichannel.db`，交付包不得含 DB 快照。
5. **P0-5 DB schema 與 code 對齊**：`server/db.ts` 新增 `assertRequiredSchema()`，檢查必要表（channels, contacts, messages, system_alerts, ai_logs, ai_reply_deliveries, meta_comments, meta_page_settings, schema_info, brands, users, settings）與 `schema_info.schema_version`；缺表或缺 version 時**明確 throw**，不靜默啟動。

---

## B. 每項改動檔案

| 項目 | 檔案 | 改了什麼 | 原因 |
|------|------|----------|------|
| P0-1 | server/routes.ts | LEGAL_RISK_KEYWORDS、FRUSTRATED_ONLY_KEYWORDS、RETURN_REFUND_KEYWORDS、ISSUE_TYPE_KEYWORDS 改為正確中文；getTransferUnavailableSystemMessage 四句文案；登入/權限/錯誤訊息 | 亂碼會誤判高風險、退換貨、轉接與 API 回傳 |
| P0-2 | server/services/prompt-builder.ts | assembleEnrichedSystemPrompt 改回傳 EnrichedPromptResult；buildCatalogPrompt 加 --- CATALOG ---；buildKnowledgePrompt 改 --- KNOWLEDGE ---；buildImagePrompt 改 --- IMAGE --- | 預覽需可靠 includes，不得用亂碼字串判斷 |
| P0-2 | server/routes.ts | getEnrichedSystemPrompt 改取 result.full_prompt；prompt-preview 改為使用 result.includes 與 result.sections | 配合 builder 回傳結構 |
| P0-3 | server/routes.ts | wrappedEnqueueDebouncedAiReply / wrappedAddAiReplyJob 在 heartbeat 過期時不 enqueue，改呼叫 autoReplyWithAI 並 return | 策略 1：degraded fallback inline |
| P0-3 | server/routes.ts | /api/debug/runtime 新增 degraded_mode | 維運需知是否處於降級模式 |
| P0-4 | docs/PACKAGING_AND_DB_SOURCE_OF_TRUTH.md | 新增 | 打包與 DB 單一真相規範 |
| P0-4 | .gitignore | 新增 data_coldstart/ | 避免多份 DB 進版控 |
| P0-5 | server/db.ts | 新增 assertRequiredSchema()、REQUIRED_TABLES，initDatabase 結束時呼叫 | 啟動時 schema 不符應直接報錯 |

---

## C. 驗收輸出

### npm run check:server

```
> rest-express@1.0.0 check:server
> tsc -p tsconfig.server.json

（無輸出）
```
**結果：通過（exit code 0）**

### npm run build

```
> rest-express@1.0.0 build
> npm run check:server && tsx script/build.ts
...
✓ built in 8.36s
building server...
  dist\index.cjs  2.5mb
  dist\workers\ai-reply.worker.cjs  111.8kb
[build] worker built: dist/workers/ai-reply.worker.cjs
```
**結果：通過（exit code 0）**

### npm run check:all

**結果：未通過（exit code 2）**  
失敗檔案：client/src/App.tsx, client/src/components/brand-channel-manager.tsx, client/src/components/schedule-form.tsx, client/src/pages/chat.tsx, client/src/pages/performance.tsx, server/e2e-scenarios.ts

### grep（節錄）

- `blocked:worker_unavailable`：server/routes.ts（wrapper 內 recordAutoReplyBlocked）、server/queue/ai-reply.queue.ts（註解）
- `prompt-preview`：server/routes.ts（GET /api/debug/prompt-preview、GET /api/sandbox/prompt-preview）
- `normalizeHandoffReason` / `applyHandoff`：server/routes.ts、server/controllers/line-webhook.controller.ts 多處

### runtime / prompt-preview 範例說明

- **GET /api/debug/runtime**：回傳 `worker_alive`、`worker_last_seen_at`、`worker_heartbeat_age_sec`、`queue_mode`、`degraded_mode`、`queue_*_count`、`last_blocked_reason`、`last_blocked_at`、`last_successful_ai_reply_at`、channels（含 last_inbound_at、last_outbound_at）。
- **GET /api/debug/prompt-preview?brandId=1**：回傳 `full_prompt`、`total_prompt_length`、`sections`（key, title, length）、`includes`（catalog, knowledge, image, global_policy, brand_persona, human_hours, flow_principles）、`model`。

---

## D. 未解項目

| 項目 | 說明 | 風險 |
|------|------|------|
| 亂碼殘留 | routes.ts 內仍有部分註解與 API 字串為 `??`（如 Phase 1 註解、部分錯誤訊息），未全數替換 | 顯示與搜尋仍可能見亂碼；不影響關鍵字判斷邏輯（已修） |
| check:all 未過 | client 與 e2e 共約 24 個 TS 錯誤 | 無法宣稱 full-project typecheck 完成 |
| P1 未做 | P1-1～P1-5（runtime 每 channel 欄位、outbound delivery 追蹤、核心頁面 TS、prompt 內容治理、留言狀態機）本輪未實作 | 依規格為重要但可下一輪補 |
| 交付 ZIP | 本輪僅產出文件與程式修改；實際「乾淨 source ZIP」需由您依 PACKAGING_AND_DB_SOURCE_OF_TRUTH 自行打包 | 交付時須排除 .git、node_modules、dist、.env、所有 DB |

---

## E. 最終判定

**server deploy gate 可簽收，full-project 未完成**

- `npm run check:server`、`npm run build` 通過；P0 五項均已依補修單修改並驗收。
- `npm run check:all` 未通過，**禁止**寫「full-project 可簽收」或「完整 typecheck 完成」。

---

## 交付文件清單

- `docs/FINAL_REPAIR_REPORT.md`（本檔）
- `docs/SMOKE_TEST_CHECKLIST.md`（沿用既有，必要時可依新行為補勾選）
- `docs/PACKAGING_AND_DB_SOURCE_OF_TRUTH.md`（新增）
- 乾淨 source ZIP：請依 PACKAGING_AND_DB_SOURCE_OF_TRUTH 與 .gitignore 自行打包，勿含 .git、node_modules、dist、.env、任何 DB。
