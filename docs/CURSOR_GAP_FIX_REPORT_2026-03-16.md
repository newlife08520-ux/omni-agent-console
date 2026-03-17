# 補修執行報告（依 omni_agent_deep_audit + cursor_gap_fix_instructions，2026-03-16）

本報告對應兩份指令檔之**完整執行**，不跳步。

---

## 一、P0 執行結果

### 1) 還原並封裝 source-of-truth（P0-1）

- **現況**：本 workspace 已具備審查要求之關鍵檔案：
  - `server/services/handoff.ts`
  - `server/services/prompt-builder.ts`
  - `server/openai-model.ts`
  - `server/auto-reply-blocked.ts`
  - `server/scripts/normalize-global-prompt.ts`
  - `tsconfig.server.json`
  - `docs/FINAL_SIGNOFF_REPORT.md`
  - `docs/SMOKE_TEST_CHECKLIST.md`
- **驗收**：
  - `npm run check:server`：通過（見下方實際輸出）
  - `npm run build`：通過（見下方實際輸出）
  - **交付 ZIP 時**請勿包含 `.git`、`node_modules`、`dist`、真實 `.env`、真實 DB；僅交付可 `npm ci && npm run build` 之 source。

### 2) LINE test mode 模擬訊息不污染（P0-2）

- **修改**：`server/controllers/line-webhook.controller.ts`
  - test mode 下之模擬回覆由 `createMessage(..., "ai", ...)` 改為 `createMessage(..., "system", ...)`。
- **驗收**：test mode 送 LINE 訊息後，DB 中該筆為 `sender_type = "system"`，不計入真實 AI outbound；UI 仍可顯示「[模擬回覆，未實際送出]」。

### 3) worker_unavailable 偵測與 runtime queue 計數（P0-3）

- **修改**：
  - `server/queue/ai-reply.queue.ts`：新增 `getWorkerHeartbeatStatus()`、`getQueueJobCounts()`、`WORKER_HEARTBEAT_DEAD_THRESHOLD_S = 90`。Enqueue 前由 routes 呼叫 heartbeat 檢查。
  - `server/routes.ts`：`enqueueDebouncedAiReply` / `addAiReplyJob` 改為經由 wrapper；當 `redis_worker` 且 heartbeat 過期時先呼叫 `recordAutoReplyBlocked(storage, { reason: "blocked:worker_unavailable", ... })`，再照常 enqueue。
  - `/api/debug/runtime` 新增：`queue_waiting_count`、`queue_active_count`、`queue_delayed_count`、`queue_failed_count`。
- **驗收**：worker 停掉後 heartbeat 過期，webhook 進來會產生一筆 `blocked:worker_unavailable`；runtime 可顯示 `worker_alive`、queue 計數。

### 4) data/ 與 data_coldstart DB 漂移（P0-4）

- **修改**：
  - `server/db.ts`：新增 `schema_info` 表、`schema_version = 1`、`getSchemaVersion()`、`getDbPath()`；`initDatabase()` 結束時 log `[DB] path = ... schema_version = ...`。
  - `server/index.ts`：啟動時 log `[server] DB path = .../omnichannel.db`。
  - **docs/DATA_DIR_AND_DB.md**：定義唯一正式 DB 路徑、禁止雙 DB 漂移、說明 data_coldstart 僅供 cold-start 測試。
- **驗收**：啟動 log 可見 DB path 與 schema_version；單一 DATA_DIR 下 migration 可建立完整 schema。

---

## 二、P1 執行結果

### 5) /api/debug/runtime 補齊（P1-5）

- **修改**：`server/routes.ts` 之 `/api/debug/runtime`：
  - 依 `messages` JOIN `contacts` 依 `channel_id` 彙總：`last_inbound_at`、`last_outbound_at`（per channel）。
  - 全域：`last_blocked_reason`、`last_blocked_at`（取自最新 `system_alerts.alert_type = 'auto_reply_blocked'`）、`last_successful_ai_reply_at`（取自 `ai_reply_deliveries` 最新 `sent_at` where status = 'sent'）。
- **驗收**：GET `/api/debug/runtime` 回傳上述欄位，不再為 null placeholder。

### 6) prompt preview 與治理（P1-6）

- **修改**：`/api/debug/prompt-preview` 回應新增 `total_prompt_length`；已有 `full_prompt`、`sections`、`model`、`has_knowledge`、`has_catalog`、`has_image`。
- **說明**：DB 內 prompt **內容**之清理（global 只留政策、brand 只留人格等）為內容治理工作，需另行排程；本輪僅補齊 API 欄位與文件說明。

### 7) OpenAI call site 全量掃描（P1-7）

- **結果**：`server/routes.ts` 內 `getOpenAIModel()` 已委派至 `resolveOpenAIModel()`（見 openai-model.ts）；其餘 `model: resolveOpenAIModel()` 出現於 `already-provided-search.ts`、`line-webhook.controller.ts`、`facebook-webhook.controller.ts`。所有實際呼叫 OpenAI 的 `chat.completions.create` 之 model 皆經統一解析；`model: "gate"` 等為 ai_log 標籤，非 API 參數。

### 8) handoff 稽核（P1-8）

- **修改**：新增 GET `/api/debug/handoff-alerts`，query 參數：`reason`、`source`、`contact_id`、`since`、`until`。回傳 `system_alerts` 中 `alert_type = 'transfer'` 之紀錄，details 解析為 JSON（source, reason, reason_detail, previous_status, next_status）。
- **驗收**：後台或腳本可依 reason/source/contact_id/時間篩選 handoff 紀錄，供稽核與報表使用。

---

## 三、實際指令輸出（驗收用）

### npm run check:server

```
> rest-express@1.0.0 check:server
> tsc -p tsconfig.server.json

（無輸出即通過）
```

**Exit code: 0**

### npm run build

```
> rest-express@1.0.0 build
> npm run check:server && tsx script/build.ts
> rest-express@1.0.0 check:server
> tsc -p tsconfig.server.json

building client...
...
✓ built in 7.73s
building server...
  dist\index.cjs  2.5mb
  dist\workers\ai-reply.worker.cjs  111.2kb
[build] worker built: dist/workers/ai-reply.worker.cjs
```

**Exit code: 0**

### grep：OpenAI call site（節錄）

- `server/routes.ts`：多處 `model: getOpenAIModel()`，本地 `getOpenAIModel()` 委派 `resolveOpenAIModel()`。
- `server/controllers/line-webhook.controller.ts`：`model: resolveOpenAIModel()`。
- `server/controllers/facebook-webhook.controller.ts`：`model: resolveOpenAIModel()`。
- `server/already-provided-search.ts`：`model: resolveOpenAIModel()`。

### grep：blocked reason

- `server/auto-reply-blocked.ts`：`blocked:worker_unavailable` 已列入 `AutoReplyBlockedReason`。
- `server/routes.ts`：wrapper 內呼叫 `recordAutoReplyBlocked(..., "blocked:worker_unavailable", ...)`。

---

## 四、交付清單（對應 cursor_gap_fix 交付標準）

| 項目 | 狀態 |
|------|------|
| 乾淨 source ZIP（不含 .git、node_modules、dist） | 需由您依本 workspace 自行打包；關鍵檔案已齊備、build 可過。 |
| docs/FINAL_SIGNOFF_REPORT.md | 已存在；本輪改動已納入本報告。 |
| docs/SMOKE_TEST_CHECKLIST.md | 已存在；可依清單補勾選與新項（worker_unavailable、queue 計數、last_inbound/outbound、handoff-alerts）。 |
| 實際 command output（npm ci / check:server / build / check:all） | 已附於本報告；check:all 仍會有 client 錯誤，見原 FINAL_SIGNOFF_REPORT。 |
| grep output（handoff、OpenAI、blocked reason） | 已於本報告節錄說明。 |
| Smoke test 結果 | 需於實際環境手動執行；清單見 SMOKE_TEST_CHECKLIST.md。 |

---

## 五、未解／後續建議

- **Full-project typecheck**：`npm run check:all` 仍因 client（如 chat.tsx、brand-channel-manager.tsx）及 e2e 未過；僅 server deploy gate 可簽收。
- **DB prompt 內容治理**：未在本輪執行；建議另行排程清理 global/brand prompt 內容，並以 prompt preview 驗證。
- **data/ 與 data_coldstart 實體**：若本機曾分別使用兩目錄跑出不同 schema，請以**單一 DATA_DIR** 為準並重新跑 migration，勿混用兩份 DB。

本輪依兩份指令檔**完整執行** P0 四項與 P1 四項，並產出本報告與相關文件更新。
