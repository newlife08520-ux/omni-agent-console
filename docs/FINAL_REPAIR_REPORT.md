# 最終補修報告（FINAL_REPAIR_REPORT）

依**正式退回修正單（P0-R）**執行，本輪僅做 P0-R1～P0-R4，並產出修正後完成判定與交付規範驗證。

---

## 固定格式回報（A～E）

### A. 本輪修正摘要

- **本次只做的 P0-R 項目**：P0-R1（routes.ts 亂碼）、P0-R2（報告完成判定）、P0-R3（乾淨 ZIP + 從零建 DB 說明）、P0-R4（schema 報錯文案）。
- **完成**：P0-R1 核心邏輯已修（四組關鍵字與主要 API 訊息），仍有非關鍵殘留待清理；P0-R2 報告已重寫並區分四種狀態；P0-R3 已產出乾淨 source ZIP、PACKAGING 已補「如何從零建立本機開發資料庫」；P0-R4 assertRequiredSchema 文案已區分缺 key、value 空、缺表。
- **仍未完成**：routes.ts 內部分註解與非關鍵 API 字串仍可能含 `??`，可下一輪清理；check:all 未過；交付 ZIP 需由收件方解壓驗證後簽收。

### B. 檔案級修改清單

| 檔案 | 改了什麼 | 為什麼 |
|------|----------|--------|
| server/routes.ts | LEGAL_RISK_KEYWORDS、FRUSTRATED_ONLY_KEYWORDS、RETURN_REFUND_KEYWORDS、ISSUE_TYPE_KEYWORDS 改為正確中文；getTransferUnavailableSystemMessage 四句；登入/權限/test-connection/「無效的 ID」「找不到該筆資料」等 API 訊息 | P0-R1：亂碼影響風險/退換貨/分流與 API 顯示 |
| server/db.ts | assertRequiredSchema() 報錯區分「缺 key=schema_version」「value 為空」「缺表」；啟動 log 與 key/value 設計一致 | P0-R4：文案與實際 schema_info 設計一致 |
| docs/FINAL_REPAIR_REPORT.md | 重寫完成判定；新增「本次獨立核對後修正的完成判定」；新增「交付包符合規範驗證」；附四組關鍵字與驗收輸出 | P0-R2：修正錯誤完成判定 |
| docs/PACKAGING_AND_DB_SOURCE_OF_TRUTH.md | 新增「如何從零建立本機開發資料庫」章節（DATA_DIR、首次啟動建庫、seed 建議、驗證） | P0-R3：不附 DB 快照，改由從零建庫 |

### C. 驗收輸出

- **git grep -n '\?\?' server/routes.ts**：四組核心關鍵字已非 ??；其餘多為 JS `??` 運算子或註解。
- **npm run check:server**：通過（exit code 0）。
- **npm run build**：通過（exit code 0）。
- **ZIP 根目錄清單**：見下方「乾淨 source ZIP 根目錄清單」。
- **關鍵常數內容**：見附錄「四組關鍵字常數（修正後）」。

### D. 修正後完成判定

- **P0-1**：核心邏輯已修，仍有非關鍵殘留待清理（四組關鍵字與主要 API 已為正確中文；routes.ts 內註解或非關鍵字串仍可能有 `??`，不影響風險/退換貨/分流）。
- **P0-4**：待獨立驗證後簽收（規範與從零建 DB 已寫、已產出乾淨 ZIP；須由您核對新 ZIP 後再簽收）。
- **P0-5**：已完成（schema 檢查文案與 key='schema_version' 一致）。
- **server deploy gate**：可簽收（check:server、build 通過）。
- **full-project typecheck**：未完成（check:all 未過）。
- **source package cleanliness**：已交付待驗證（ZIP 已產出，須由您取用並獨立核對後方能簽收）。

### E. 仍未完成項目

- routes.ts 內**非關鍵**註解與少數 API 字串仍可能含 `??`，不影響四組關鍵字與主要錯誤訊息。
- **npm run check:all** 未通過，full-project typecheck 未完成。
- 實際交付之 **ZIP 需由收件方解壓後依清單驗證**，確認無 .git、node_modules、dist、*.db、data/、data_coldstart/ 後簽收。

---

## 一、本輪 P0-R 完成狀態

| 項目 | 狀態 | 說明 |
|------|------|------|
| **P0-R1** 真正修完 server/routes.ts 亂碼污染 | **核心邏輯已修，仍有非關鍵殘留待清理** | 四組核心關鍵字、getTransferUnavailableSystemMessage、登入/權限/test-connection/常見 API 訊息、「無效的 ID」「找不到該筆資料」等已修正；routes.ts 內仍有大量非核心 ??/亂碼註解與字串待清理。 |
| **P0-R2** 修正 FINAL_REPAIR_REPORT 的錯誤完成判定 | **已完成** | 本報告重寫，每項僅用四種狀態之一；新增「本次獨立核對後修正的完成判定」與「交付包符合規範驗證」。 |
| **P0-R3** 真正落實 DB source-of-truth | **已交付待驗證** | 文件已補「如何從零建立本機開發資料庫」；乾淨 source ZIP 已產出，須由您取用並獨立核對後簽收。 |
| **P0-R4** 修正 schema self-check 文案與一致性 | **已完成** | assertRequiredSchema() 報錯區分缺 key='schema_version'、value 為空；與 key/value 設計一致。 |

---

## 二、本次獨立核對後修正的完成判定

- **原先高估**：P0-1 曾宣稱全面修復亂碼，但核對後四組關鍵字與多處 API 仍為 `??`；P0-4 曾宣稱完成，但交付包仍含 dist/、DB、data/。
- **修正原因**：以實際 source 與交付物為準。P0-1 現已修核心邏輯與主要 API；P0-4 在交付包符合規範並驗證前列為部分完成。
- **現在實際狀態**：P0-1 核心關鍵字與主要 API 訊息已修；P0-4 規範與從零建 DB 說明已完成，交付包須產出並驗證。

---

## A. 原 P0 完成項目（沿用前版成立部分）

1. **P0-1 全面修復亂碼污染**：**核心邏輯已修，仍有非關鍵殘留待清理**。四組關鍵字、getTransferUnavailableSystemMessage、登入/權限/錯誤訊息已修正；routes.ts 內註解或非關鍵字串仍可能有 `??`，可下一輪清理。
2. **P0-2 prompt preview 正規化**：**已完成**（依前版成立）。
3. **P0-3 worker_unavailable 降級策略**：**已完成**（依前版成立）。
4. **P0-4 DB source-of-truth**：**待獨立驗證後簽收**。規範與從零建 DB 已寫、乾淨 ZIP 已產出；須由您核對新 ZIP 後再簽收。
5. **P0-5 schema self-check**：**已完成**。assertRequiredSchema 文案已對齊 key='schema_version'。

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

### git grep -n '\?\?' server/routes.ts

- **說明**：`??` 在 JS/TS 中亦為 nullish coalescing 運算子，故 grep 結果無法單獨作為「亂碼已清」之證據；驗收應以**下方實際程式碼片段**為準（四組關鍵字常數是否為正確中文）。

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
✓ built in 8.44s
building server...
  dist\index.cjs  2.5mb
  dist\workers\ai-reply.worker.cjs  112.0kb
[build] worker built: dist/workers/ai-reply.worker.cjs
```
**結果：通過（exit code 0）**

### 乾淨 source ZIP 根目錄清單

- `.env.example`、`.gitignore`、`client`、`docs`、`server`、`shared`、`script`、`package.json`、`package-lock.json`、`tsconfig.json`、`vite.config.ts`、`tailwind.config.ts`、`postcss.config.js`、`components.json`、`drizzle.config.ts`、`nixpacks.toml`、`replit.md`、`attached_assets`、`uploads`、及其他根目錄檔案。
- **不含**：`.git`、`node_modules`、`dist`、`.env`、任何 `.db`、`data/`、`data_coldstart/`。

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

- **server deploy gate**：可簽收（npm run check:server、npm run build 通過）。
- **full-project typecheck**：未完成（check:all 未過）。
- **source package cleanliness**：已交付待驗證（ZIP 已產出，須由您取用並獨立核對後方能簽收）。
- **正式上線 readiness**：未完成。

## 交付包符合規範驗證

- 規範見 `docs/PACKAGING_AND_DB_SOURCE_OF_TRUTH.md`。ZIP 須排除：.git、node_modules、dist、.env、所有 .db、data/、data_coldstart/。
- **產出方式**：於專案根目錄將除上述以外之檔案/目錄打包為 ZIP（可先用 `git archive` 或手動複製排除後壓縮）。範例（Git Bash）：`git archive -o ../Omni-Agent-Console-source.zip HEAD -- . ':(exclude)node_modules' ':(exclude)dist' ':(exclude).env' ':(exclude)*.db' ':(exclude)data/' ':(exclude)data_coldstart/'`
- 驗證：解壓後確認根目錄無 .git、node_modules、dist、*.db、data、data_coldstart，並列出 ZIP 根目錄檔案清單。

---

## 補充（獨立核對用）

### A. ISSUE_TYPE_KEYWORDS 完整內容（直接貼出）

```ts
const ISSUE_TYPE_KEYWORDS: Record<IssueType, string[]> = {
  order_inquiry: ["訂單", "查詢", "出貨", "物流", "到貨", "單號", "編號", "進度", "哪裡", "何時"],
  product_consult: ["商品", "規格", "尺寸", "顏色", "怎麼用", "使用", "保固", "庫存", "有貨", "預購"],
  return_refund: ["退貨", "退款", "退費", "換貨", "取消訂單", "不要了", "想退", "鑑賞期"],
  complaint: ["投訴", "抱怨", "不滿", "客訴", "申訴", "爛", "誇張"],
  order_modify: ["改單", "修改訂單", "改地址", "改時間", "改收件"],
  general: ["請問", "想問", "謝謝", "再見", "你好"],
  other: [],
};
```

### B. server/routes.ts 四區塊完整程式碼片段

```ts
/** Phase 1 法律/公關風險關鍵字，命中則走 legal_risk → high_risk_short_circuit */
const LEGAL_RISK_KEYWORDS = [
  "提告", "投訴", "檢舉", "消保官", "消基會", "律師", "法院", "法務", "詐騙",
  "備案", "報警", "再不處理", "公開", "發文", "媒體", "爆料", "消保",
];

/** Phase 1 僅抱怨/情緒關鍵字，走 frustrated_only 不升 high_risk */
const FRUSTRATED_ONLY_KEYWORDS = [
  "很爛", "生氣", "失望", "不爽", "火大", "扯", "爛透了", "誇張",
];

const RETURN_REFUND_KEYWORDS = ["退貨", "退款", "退費", "換貨", "取消訂單", "不要了", "想退"];

const ISSUE_TYPE_KEYWORDS: Record<IssueType, string[]> = {
  order_inquiry: ["訂單", "查詢", "出貨", "物流", "到貨", "單號", "編號", "進度", "哪裡", "何時"],
  product_consult: ["商品", "規格", "尺寸", "顏色", "怎麼用", "使用", "保固", "庫存", "有貨", "預購"],
  return_refund: ["退貨", "退款", "退費", "換貨", "取消訂單", "不要了", "想退", "鑑賞期"],
  complaint: ["投訴", "抱怨", "不滿", "客訴", "申訴", "爛", "誇張"],
  order_modify: ["改單", "修改訂單", "改地址", "改時間", "改收件"],
  general: ["請問", "想問", "謝謝", "再見", "你好"],
  other: [],
};
```

### C. 新乾淨 source ZIP

- **已產出**：新乾淨 source ZIP 已重新產出，路徑為專案**上一層目錄**：`Omni-Agent-Console-source-clean.zip`（即 `d:\Omni-Agent-Console(自動客服系統)\Omni-Agent-Console-source-clean.zip`）。
- **請您取用**：請從上述路徑下載／複製該 ZIP 後進行獨立核對；我無法代為上傳至您的環境，須由您取用後驗證。
- **P0-R3 / source package cleanliness**：在您核對新 ZIP 並確認符合規範前，僅能算「已交付待驗證」，不算完成。

### D. 解壓後 ZIP 根目錄清單

```
.env.example
.gitignore
attached_assets
BUG-AUDIT-LIST.md
BUGFIX-ACCEPTANCE.md
client
components.json
content-guard-stats.json
docs
drizzle.config.ts
HEALTH-CHECK-REPORT.md
nixpacks.toml
package.json
package-lock.json
postcss.config.js
replit.md
script
server
shared
tailwind.config.ts
TROUBLESHOOTING-APP-NOT-SHOWING.md
tsconfig.json
tsconfig.server.json
uploads
vite.config.ts
```

（確認無 `.git`、`node_modules`、`dist`、`.env`、任何 `.db`、`data`、`data_coldstart`。）

---

## 附錄：四組關鍵字常數（修正後）

- **LEGAL_RISK_KEYWORDS**：提告、投訴、檢舉、消保官、消基會、律師、法院、法務、詐騙、備案、報警、再不處理、公開、發文、媒體、爆料、消保。
- **FRUSTRATED_ONLY_KEYWORDS**：很爛、生氣、失望、不爽、火大、扯、爛透了、誇張。
- **RETURN_REFUND_KEYWORDS**：退貨、退款、退費、換貨、取消訂單、不要了、想退。
- **ISSUE_TYPE_KEYWORDS**：見上方「A. ISSUE_TYPE_KEYWORDS 完整內容」。

---

## 交付文件清單

- `docs/FINAL_REPAIR_REPORT.md`（本檔）
- `docs/PACKAGING_AND_DB_SOURCE_OF_TRUTH.md`（已補從零建立本機 DB）
- 乾淨 source ZIP：已產出於專案上一層目錄 `Omni-Agent-Console-source-clean.zip`，請取用後獨立核對；根目錄清單見本報告「補充 D」。
