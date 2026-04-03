# Phase 0 — 品牌邏輯對照（DB / Service）

**證據來源**：`shared/schema.ts` 型別、`server/db.ts` 建表與 migration、`server/storage.ts` 查詢。

---

## 1. 是否已有 brand / channel / page / setting / knowledge 關聯？

| 實體 | 表或機制 | 關聯摘要 |
|------|-----------|-----------|
| **Brand** | `brands` | 主檔；含 `system_prompt`、SuperLanding／Shopline 相關欄位、`return_form_url` 等（見 `Brand` interface） |
| **Channel** | `channels` | `brand_id` + `platform`（`line` \| `messenger`）+ token／secret |
| **Contact** | `contacts` | `brand_id`、`channel_id` 可空但實務上 webhook 會填 |
| **Settings** | `settings` | key-value **全域**，非 `brand_id` 維度（例如 `system_prompt`、班表時間） |
| **Knowledge** | `knowledge_files` | `brand_id`；`getKnowledgeFiles(brandId)` 篩選 |
| **Image assets** | `image_assets` | `brand_id`（`getImageAssets`） |
| **Meta page** | `meta_page_settings` | `page_id` ↔ `brand_id`（留言中心） |

**推測（需對照 live DB）**：`knowledge_files` 可能另有 category／intent 等 TEXT 欄位（`db.ts` migration 註解）；若欄位為空則情境隔離仍主要靠程式。

---

## 2. 系統如何判斷並套用品牌？

1. **Inbound**：LINE／Messenger webhook 依 channel token 或 page 對應到 `channels` → `brand_id`，寫入 `contacts`。
2. **AI 回覆**：`autoReplyWithAI` 等路徑使用 `contact.brand_id` 傳入 `assembleEnrichedSystemPrompt`、`getSuperLandingConfig(brandId)`、`toolExecutor` context。
3. **工具／查單**：`ToolCallContext.brandId` 傳入 `tool-executor.service.ts`，驅動 `storage.getBrand`、`unifiedLookup*` 的 Shopline／SuperLanding 憑證選擇。

---

## 3. 品牌覆蓋：顯性 vs 隱性

| 類型 | 範例 |
|------|------|
| **顯性** | `brands.system_prompt`、`return_form_url`、各品牌 API 欄位 |
| **隱性（程式預設）** | `buildFlowPrinciplesPrompt` 預設退換貨連結字串、`getProductScopeFromMessage` 的 bag／sweet 關鍵字、`order-feature-flags.ts` 的 **環境變數**（非 per-brand） |

---

## 4. Hardcoded brand logic（與「品牌無關的全域規則」之分）

以下為 **code 中不經 `brand_id` 分支**、但可能影響所有品牌的邏輯（部分為合理全域安全規則）：

- `LEGAL_RISK_KEYWORDS`、`ISSUE_TYPE_KEYWORDS`、`RETURN_REFUND_KEYWORDS`（`ai-reply.service.ts`）。
- `ReplyPlanMode` 優先序與 `buildReplyPlan` 條件（`reply-plan-builder.ts`）。
- `order-lookup-policy.ts` 內 regex／關鍵字（查單來源、手機、order id）。
- `F2_FORBIDDEN_PHRASES`（平台話術禁語，`reply-plan-builder.ts`）。

**區分**：上述不一定是「某單一品牌名稱寫死」，而是 **全租戶共用政策**；對「約 10 品牌內部中台」而言，仍可能造成某品牌需要例外時無法資料驅動。

---

## 5. 缺口（相對 Shared Core + Brand Overrides 目標）

- 無 **per-brand feature flag** 表（現有 `order-feature-flags.ts` 為 env）。
- 無 **Scenario** 第一級設定表；情境靠 resolver + reply plan。
- 無 **draft/publish** 版本列；設定變更即寫現行 row。

---

## 6. 證據標註

- Schema 欄位：**code-derived**（`db.ts` + `shared/schema.ts`）。
- 各表筆數、範例列：**runtime_snapshot** 與 `_export_summary.json`（本機 `omnichannel.db` 一次取樣，非正式環境則不代表 production）。
