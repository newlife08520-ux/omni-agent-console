# 最終簽收報告（FINAL_SIGNOFF_REPORT）

本報告對應審查要求：補完硬傷後產出，附實際指令輸出與 grep 結果，並明確標示**未解項目**與**不得宣稱「全部完成」**之範圍。

---

## 一、改動摘要

| 項目 | 內容 |
|------|------|
| **B. blocked_reason** | `meta_comments` 新增欄位 `blocked_reason`；寫入時存真實原因（no_page_settings / no_channel_token）；API 直接回傳該欄位；留言 blocked 統一走 `recordAutoReplyBlocked`。 |
| **C. test mode 模擬訊息** | LINE test mode 下之模擬回覆改為 `sender_type = "system"` 寫入（原為 "ai"），避免污染真實 outbound 統計。 |
| **D. worker heartbeat** | Worker 每 30 秒寫 Redis heartbeat；`/api/debug/runtime` 回傳 `worker_alive`、`worker_last_seen_at`、`worker_heartbeat_age_sec`、`queue_mode`。 |
| **E+F. handoff** | 新增 `normalizeHandoffReason()`；`applyHandoff` 僅接受 canonical reason；alert 改為 JSON（source, reason, reason_detail, contact_id, previous_status, next_status）；idempotent 時仍寫入新 alert，允許 high_risk 升級。 |
| **A. 腳本與狀態** | 新增 `check:all`、`verify:server`、`verify:full`；`build` 為 `check:server && tsx script/build.ts`。 |
| **H. prompt preview** | 新增 GET `/api/debug/prompt-preview?brandId=...`，回傳組裝後全文、sections、model、has_knowledge 等。 |

---

## 二、Build / Typecheck 真實狀態（A 驗收）

### 2.1 重要說明（必讀）

- **目前 `build` 為 server-only gate**：`npm run build` = `npm run check:server && tsx script/build.ts`。  
- **完整專案 typecheck（`check:all`）尚未通過**：仍有 client 與部分 server（e2e）錯誤。  
- **因此不得宣稱「第 2 階段完整完成」或「full-project build gate 已恢復」**；僅能寫：**server deploy gate 完成，full-project check 仍有待修**。

### 2.2 實際指令輸出

#### `npm run check:server`

```
> rest-express@1.0.0 check:server
> tsc -p tsconfig.server.json

（無輸出即通過）
```

**結果：通過（exit code 0）。**

#### `npm run build`

```
> rest-express@1.0.0 build
> npm run check:server && tsx script/build.ts
> rest-express@1.0.0 check:server
> tsc -p tsconfig.server.json

building client...
vite v7.3.0 building client environment for production...
...
✓ built in 7.63s
building server...
  dist\index.cjs  2.5mb
  dist\workers\ai-reply.worker.cjs  110.9kb
[build] worker built: dist/workers/ai-reply.worker.cjs
```

**結果：通過。**

#### `npm run check:all`

```
> rest-express@1.0.0 check:all
> tsc

client/src/App.tsx(262,29): error TS2322: ...
client/src/components/brand-channel-manager.tsx(637,89): error TS2339: Property 'brand_name' does not exist on type 'Channel'.
client/src/components/brand-channel-manager.tsx(637,109): error TS2339: ...
client/src/components/schedule-form.tsx(24,23): error TS2352: ...
client/src/pages/chat.tsx(267,17): error TS2367: ...
client/src/pages/chat.tsx(417,26): error TS2531: ...
client/src/pages/chat.tsx(1874,24): error TS2531: ...
client/src/pages/chat.tsx(2055,25): error TS2322: ...
client/src/pages/chat.tsx(2152,44): error TS2551: Property 'assigned_agent_name' does not exist ...
client/src/pages/chat.tsx(2155,115): error TS2322: ...
client/src/pages/chat.tsx(2155,226): error TS2551: ...
client/src/pages/chat.tsx(2156,132): error TS2551: ...
client/src/pages/chat.tsx(2158,51): error TS2551: ...
client/src/pages/chat.tsx(2434,113): error TS2322: ...
client/src/pages/performance.tsx(201,56): error TS2339: ... (多筆)
server/e2e-scenarios.ts(131,105): error TS2322: ...
server/e2e-scenarios.ts(180,14): error TS2554: ...
（其餘 e2e 同）
```

**結果：未通過。**  
**未通過檔案（摘要）：**

- **Client 核心頁面**：`client/src/pages/chat.tsx`、`client/src/components/brand-channel-manager.tsx`、`client/src/pages/performance.tsx`、`client/src/App.tsx`、`client/src/components/schedule-form.tsx`
- **Server**：`server/e2e-scenarios.ts`

#### `git ls-files | grep -E '^(node_modules|dist)/'`（或等價 PowerShell）

```powershell
git ls-files | Select-String -Pattern "node_modules|^dist/"
```

**結果：無輸出。** → `node_modules/` 與 `dist/` 未被 git 追蹤。

---

## 三、Handoff 收斂證明（G）

### 3.1 `updateContactHumanFlag(`

| 檔案:行 | 說明 |
|---------|------|
| `server/routes.ts` 2703, 2933, 3747, 3774 | 皆為 `updateContactHumanFlag(id, 0)`：**清除** needs_human（恢復 AI），非寫入轉人工；保留。 |
| `server/services/handoff.ts` 154, 171 | 在 `applyHandoff()` 內呼叫 `updateContactHumanFlag(contactId, 1)`：**唯一寫入 1 的入口**，已收斂。 |
| `server/storage.ts` 36, 526 | 介面與實作定義，非呼叫點。 |

**結論：** 所有「設為需要人工」的寫入皆經 `applyHandoff()`；其餘為清除 flag，合理保留。

### 3.2 `"awaiting_human"` / `"high_risk"`

- **handoff.ts**：型別與狀態判斷、`statusOverride`、升級邏輯；屬 handoff 核心，保留。
- **routes.ts**：validStatuses 陣列、狀態判斷、UI 標籤、SQL 篩選、prompt 字串；皆為讀取或列舉，保留。
- **db.ts**：CHECK 約束與 migration；保留。
- **assignment.ts 172**：`storage.updateContactStatus(contactId, "awaiting_human")` — **解除指派時將案件丟回等候池**，為業務所需，非新 handoff 寫入；保留並註明為「unassign 還原狀態」。
- **facebook-webhook.controller.ts / line-webhook.controller.ts**：讀取狀態判斷是否已在 handoff；保留。
- **idle-close-job.ts、conversation-state-resolver.ts、rating-eligibility.ts、phase2-output.ts**：皆為讀取或判斷；保留。

**結論：** 狀態寫入已收斂至 `applyHandoff()` 與 assignment 的 unassign；其餘為讀取/列舉。

### 3.3 `transfer_to_human`

- **routes.ts**：tool 定義、`fnName === "transfer_to_human"` 分支 — 已改為先 `normalizeHandoffReason` 再呼叫 `applyHandoff`。
- **prompt-builder.ts**：prompt 內說明文字，非程式寫入。

**結論：** 所有 transfer_to_human 觸發皆經 canonical reason + applyHandoff。

---

## 四、OpenAI call site 與 resolveOpenAIModel（I）

- **routes.ts**：多處 `model: getOpenAIModel()` 或 `model: resolveOpenAIModel()`；`getOpenAIModel()` 已委派至 `resolveOpenAIModel()`，故實質皆走統一解析。  
  另有 `model: "gate"`、`model: "risk-detection"`、`model: "safe-after-sale-classifier"`、`model: "reply-plan"` — 為 **createAiLog 的 reply_source 標籤**，非 OpenAI API 的 model 參數，保留。
- **already-provided-search.ts**：`model: resolveOpenAIModel()`，已統一。
- **facebook-webhook.controller.ts / line-webhook.controller.ts**：`model: resolveOpenAIModel()`，已統一。
- **storage.ts**：`model: string` 為型別/欄位定義，非呼叫點。

**結論：** 所有實際呼叫 OpenAI 的 `chat.completions.create` 之 model 參數皆來自 `getOpenAIModel()`/`resolveOpenAIModel()`；其餘為 log 標籤或型別定義。

---

## 五、Smoke Test 清單與結果（J）

- **Smoke 項目**：已列於 `docs/SMOKE_TEST_CHECKLIST.md`（LINE test/正常、FB/Meta、worker、handoff、prompt preview、build/check）。
- **執行方式**：需於實際環境手動執行；本報告不宣稱「已全部執行通過」。
- **簽收前**：請依清單逐項執行並在該文件中勾選或註明結果；若有失敗項，應列於下方「未解項目與剩餘風險」。

---

## 六、未解項目與剩餘風險

1. **Full-project typecheck 未通過**  
   - `npm run check:all` 仍失敗；核心前端頁面（如 `chat.tsx`、`brand-channel-manager.tsx`）及部分 client/server 檔案有 TS 錯誤。  
   - **建議**：若要宣稱「完整 build 防線」，須修復上述檔案並通過 `check:all`。

2. **DB prompt 內容治理**  
   - 目前僅完成 prompt **組裝層**重構與 **effective prompt preview**；DB 內全域/品牌 prompt **內容**尚未系統性清理（流程細節、handoff SOP、決策樹等仍可能混在 prompt 中）。  
   - **normalizeSections()** 僅能去同標題重複，無法保證語意重複或不同標題之重複。

3. **Smoke test 未自動化**  
   - 清單需手動執行；若未全跑過，不得寫「全部驗收通過」。

---

## 七、簽收結論（不得寫「全部完成」）

- **Server 部署與後端防線**：可簽收。`npm run check:server`、`npm run build` 通過；worker 產物、heartbeat、blocked_reason、handoff 收斂、prompt preview 已依審查要求實作並在本文附實際輸出與 grep 說明。
- **Full-project 與內容治理**：**不得宣稱完成**。  
  - Build 目前為 **server-only gate**。  
  - **check:all** 未通過，核心前端與 e2e 仍有 TS 錯誤。  
  - Prompt **內容**清理與 **normalizeSections 侷限**已於本報告明確說明。

完成上述補修並再次執行 smoke 清單後，可更新本報告並標註「server 部分簽收」；待 `check:all` 通過且內容治理達標後，再更新為「full-project 簽收」。
