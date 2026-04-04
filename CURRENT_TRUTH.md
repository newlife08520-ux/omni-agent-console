# 系統現狀（Single Source of Truth）

> 最後更新：2026-04-04（第五輪 5A + 5B 部分）

## 版本

- 主線功能：Phase 34B
- Multi-Brand 架構：Phase 1.7（feature branch 持續演進）
- Prompt：Phase 97（Global 已精簡；品牌細節在 Brand Persona 檔）
- UI：Stitch Pack（規格參考）

## Phase 1 狀態

- Go/No-Go：以 `_architecture_phase1/` 文件為準；isolated pilot 與 merge main 策略請對照最新 Go/No-Go。
- Feature branch：`phase1/agent-ops-backend`（實際以遠端為準）

## 本輪優化摘要（cursor-optimization-plan）

- **TASK 1–6（P0）**：品牌硬編碼已清除（含退貨連結 fallback、`sandbox`、product scope／SWEET 常數）；`runPostGenerationGuard` 在售後／handoff 等 mode **已恢復**禁推銷；固定文案（handoff、shipping SOP 前綴等）支援 **`phase1_agent_ops_json.message_overrides` 品牌覆寫**。
- **TASK 8–10**：Brand Prompt 已差異化（`brand_1`／`brand_2`）；ISO 模式 **`buildBrandPersonaPromptIsoThin`** 已放寬並智慧截斷以保留「禁止」段；**`buildScenarioIsolationBlock`** 情境邊界已強化（✅／❌）。
- **TASK 11–12**：圖片 DM 模板可經 `image_dm_generic` 覆寫；**`OFF_TOPIC_GUARD_MESSAGE`** 已去除 emoji。
- **TASK 13**：**Vitest** 已建立，`server/__tests__/intent-router.test.ts` **12 tests** 通過（`npm run test`）。
- **TASK 14**：**`server/repos/ai-logs-repo.ts`** 已抽出，`storage` 委派 `createAiLog`／`getAiLogs`／`getAiLogStats`。
- **TASK 15／16**：**SKIPPED** — `contacts-repo`／`orders-repo` 延後（`getContacts` 與 flags 耦合；訂單索引主邏輯在 `order-index.ts`），需後續架構決策。

## 第二輪優化摘要（cursor-optimization-plan-round2）

- **TASK 18**：`getProductScopeFromMessage` 已移除；Vision 上下文不再帶死碼 `product_scope`；`order_lookup`／`answer_directly` 分支不再寫入永遠為空的 inferred scope；`effectiveScope` 僅來自 `state.product_scope_locked`。
- **TASK 19**：**[已確認無需改動]** — `safe_confirm` 已以 `contact.brand_id` 取模板與 page 設定（程式註解已標記）。
- **TASK 20**：`safe_confirm_template` 的 `createAiLog` 補上 Phase 1 trace（`channel_id`、`matched_intent`、`route_source`、`selected_scenario`、`tools_available_json`、`response_source_trace`、`phase1_config_ref` 等）。
- **TASK 21–23**：新增 `content-guard`／`prompt-builder`／`sop-compliance-guard` 單元測試（見 `server/__tests__/`）。
- **TASK 24**：`npm run sync:prompt` → `server/scripts/sync-global-prompt.ts`，將 `PHASE97_MASTER_SLIM.txt` 寫入 `settings.system_prompt`。
- **TASK 25**：`npm run pilot:precheck` → `server/scripts/pilot-precheck.ts`，一鍵檢查 pilot 前置條件（可傳 `brand_id`）。

## 第三／四輪優化摘要（cursor-optimization-plan-round3／round4-final）

- **TASK 27**：Quick Ack 分批回覆已啟用——**隨機池**（每情境 5 句），品牌可經 `message_overrides.quick_ack_*` 覆寫為固定句。
- **TASK 28**：**[已確認]** Quick Ack **排除** `handoff`、`off_topic_guard`（`planModeForAck` 判斷）；查單工具內建 ack 仍受 `sentLookupAckThisTurn` 保護。
- **TASK 29**：`server/__tests__/quick-ack.test.ts`（flag 預設與關閉）。
- **TASK 30–32**：出貨語氣全面校準——品牌 prompt 與 **`SHIPPING_SOP_COMPLIANCE_PREFIX`** 皆為「先道歉、承認欠貨／等待」；現貨 **五工作天**、預購 **七到二十工作天**（兩品牌一致）；品牌檔結尾 SLA／表單提醒句已刪。
- **TASK 33–34**：**`enforceOutputGuard`** 長度控制（查單／出貨跟進 **200**、其餘 **350**）；`server/__tests__/output-guard.test.ts`。
- **TASK 36–37**：**品牌級模型覆寫**——`phase1_agent_ops_json.ai_model_override`（格式同 `AI_MODEL`）；`resolveModelWithBrandOverride` + `callAiModel({ modelOverride })` + OpenAI stream／`return_form_first` 路徑同步；`server/__tests__/brand-config.test.ts`。
- **TASK 38**：品牌 Persona 殘留「以營運／後台為準」類提醒已移除。
- **品牌模型 UI**：**[前端延後]** — 目前請直接編輯 DB `brands.phase1_agent_ops_json`；設定頁下拉未做。

## 第五輪 5A 優化摘要（cursor-optimization-plan-round5）

- **TASK 40–42**：**`runGlobalPlatformGuard`**／**`runOfficialChannelGuard`** 已恢復（`PLATFORM_FORBIDDEN_PATTERNS` 推責話術、官方渠道反問句；命中則刪句保留其餘）+ **`content-guard.test.ts`** 覆蓋。
- **TASK 43–45**：**`payment-status.test.ts`**（`derivePaymentStatus`）、**`customer-facing-safety.test.ts`**（`findCustomerFacingRawLeak`）、**`prompt-builder.test.ts`** 追加 `buildScenarioFlowBlock` 邊界。
- **TASK 46**：**`phase24`–`phase33` verify**（9 支）檔首標 **`@deprecated`**（保留不刪）；`package.json` 無對應 scripts 故未改。
- **TASK 47**：**`brand-config.test.ts`**（`scenario_overrides` 解析）、**`intent-router.test.ts`**（`applyScenarioToolOverrides`）。
- **TASK 48**：**[已確認]** Quick Ack 為 **`createMessage` + channel push**，主回覆才經 **`enforceOutputGuard`**，短路不經 output guard。
- **TASK 49**：**`docs/examples/brand-phase1-config-example.json`** 範例（營運參考）。

## 測試覆蓋

- `intent-router.test.ts`：Hybrid Router、工具過濾、`applyScenarioToolOverrides`
- `content-guard.test.ts`：禁推銷、`runGlobalPlatformGuard`、`runOfficialChannelGuard`
- `prompt-builder.test.ts`：去重、情境／流程 block、流程邊界
- `payment-status.test.ts`：`derivePaymentStatus`
- `customer-facing-safety.test.ts`：`findCustomerFacingRawLeak`
- `sop-compliance-guard.test.ts`、`quick-ack.test.ts`、`output-guard.test.ts`、`brand-config.test.ts`：見各檔
- 合計以 **`npm run test`** 為準（5A 完成後 **71 tests**）

## 已知 passthrough（刻意保留）

- `customer-reply-normalizer.ts`：passthrough（語氣交還 LLM，設計決策）

## 模型設定層級

1. **品牌覆寫**：`brands.phase1_agent_ops_json.ai_model_override`（僅當 **`enabled: true`** 時生效；最高優先）
2. **環境變數**：`AI_MODEL`（次之）
3. **DB 全域**：`settings.ai_model`（再次之；另有 `openai_model` legacy）
4. **預設**：`openai:gpt-4o`

## 已啟用的 Guard（完整清單）

- `runPostGenerationGuard`：售後／handoff 等 mode 禁推銷
- `runGlobalPlatformGuard`：推責話術（其他平台／非我們的單等）刪句
- `runOfficialChannelGuard`：官方渠道多餘反問（是否官網下單等）刪句
- `enforceOutputGuard`：回覆長度（查單／出貨跟進 200、其餘 350）
- `ensureShippingSopCompliance`：出貨 SOP 兜底（`order_followup`）
- 法律／高風險短路、Safe After-Sale Classifier、SOP／Tool 層：見程式註解與 routes

## 品牌文案覆寫

- `phase2-output.brandMessage`：讀取 `brands.phase1_agent_ops_json.message_overrides`（鍵如 `handoff_opening`、`shipping_sop_prefix`、`image_dm_generic`、`quick_ack_*`）

## Pilot 上線前人工操作

1. **`npm run sync:prompt`**：將 Global Prompt 同步到 `settings.system_prompt`（對應 `docs/persona/PHASE97_MASTER_SLIM.txt`）。
2. **`npm run pilot:precheck -- <brand_id>`**：一鍵前置檢查。
3. 在指定品牌的 **`phase1_agent_ops_json`** 寫入 flags（與選用的 **`ai_model_override`** 若需要）。
4. 發數則 LINE 測試訊息，端到端驗證並檢視 **ai_logs**。

## DB

- SQLite（WAL mode）
- 路徑：`DATA_DIR`/omnichannel.db（見 `server/data-dir.ts`）

## 程式結構備註

- **TASK 14**：`server/repos/ai-logs-repo.ts` — `createAiLog` / `getAiLogs` / `getAiLogStats` 已由 `storage` 委派。
- **TASK 15 [SKIPPED]**：`getContacts` 與 `getAgentContactFlags` 同類別耦合，全量抽出需依賴注入或重構批次 API。
- **TASK 16 [SKIPPED]**：`orders_normalized` / `order_lookup_cache` 主要邏輯在 `server/order-index.ts`；若需 `orders-repo` 應自該模組拆分。

## Prompt 文件

- Global：`docs/persona/PHASE97_MASTER_SLIM.txt`
- 品牌：`docs/persona/brands/brand_*_phase97_slim.txt`
- Phase 1 JSON 範例：`docs/examples/brand-phase1-config-example.json`

## 第五輪 5B（ai-reply 拆分）狀態

- **TASK 53**：**已完成** — `server/services/quick-ack.service.ts`（`pickRandomAck`、`sendQuickAckIfNeeded`），`ai-reply.service.ts` 改為呼叫。
- **TASK 55**：**已完成** — `server/services/guard-pipeline.ts` 的 **`runPostGenerationPipeline`**（`enforceOutputGuard` → 禁推銷 → 官方渠道 → 跨平台推責）；**不含** `normalizeCustomerFacingOrderReply`／`ensureShippingSopCompliance`（仍留在主流程）。
- **TASK 54（vision-handler）**、**TASK 56（handoff-decision）**：**[延後]** — 與 `toolExecutor`／多段 handoff 短路耦合高，本批次未拆，避免高風險大改。
- **TASK 57**：`ai-reply.service.ts` **仍約 2400 行**（未達 &lt;1800）；若要達標需再拆 Vision 區塊與／或 handoff 短路群。
- **TASK 58**：`npm run check:server`、`npm run build`、`npm run test`（71）、`verify:phase1-ops` 已通過；新檔：`quick-ack.service.ts`、`guard-pipeline.ts`。
