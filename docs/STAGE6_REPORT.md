# 第六階段回報：修 prompt 架構，讓人格與流程分層

依 `cursor_fix_plan_omni_agent_console.md` 第六階段執行，拆開 prompt 責任、去重、人格 vs 流程分工、降低 handoff 份量、統一模型 fallback。

---

## 1. 改了哪些檔案

| 檔案 | 改動摘要 |
|------|----------|
| `server/services/prompt-builder.ts` | **新建**。`buildGlobalPolicyPrompt()`、`buildBrandPersonaPrompt(brandId)`、`buildHumanHoursPrompt()`、`buildFlowPrinciplesPrompt(options)`、`buildCatalogPrompt(brandId)`（async）、`buildKnowledgePrompt(brandId)`、`buildImagePrompt(brandId)`；`normalizeSections(text)` 依 "--- 標題 ---" 去重；`assembleEnrichedSystemPrompt(brandId, context)` 總組裝並做 runtime 去重。流程區塊改為高層原則（退換貨表單、訂單查詢、transfer_to_human 情境），不重複承載 deterministic SOP。 |
| `server/openai-model.ts` | **新建**。`resolveOpenAIModel()`：`process.env.OPENAI_MODEL?.trim()` \|\| `storage.getSetting("openai_model")?.trim()` \|\| `"gpt-4o-mini"`，供所有 OpenAI 呼叫使用。 |
| `server/routes.ts` | `getEnrichedSystemPrompt` 改為僅呼叫 `assembleEnrichedSystemPrompt(brandId, context)`。移除 `buildKnowledgeBlock`、`buildImageAssetCatalog`、`IMAGE_PRECISION_COT_BLOCK` 及舊的 handoff/tone/shipping 長串內聯。新增 `import { assembleEnrichedSystemPrompt } from "./services/prompt-builder"`、`import { resolveOpenAIModel } from "./openai-model"`。`getOpenAIModel()` 改為委派 `resolveOpenAIModel()`。meta-comments suggest-reply 的 model 改為 `resolveOpenAIModel()`。 |
| `server/superlanding.ts` | 新增 `import { storage } from "./storage"`；新增並 export `getSuperLandingConfig(brandId)`，供 prompt-builder 與 routes 共用。 |
| `server/controllers/line-webhook.controller.ts` | 圖片 vision 呼叫改用 `resolveOpenAIModel()`。 |
| `server/controllers/facebook-webhook.controller.ts` | 圖片 vision 呼叫改用 `resolveOpenAIModel()`。 |
| `server/already-provided-search.ts` | 圖片抽取訂單/手機的 model 改為 `resolveOpenAIModel()`。 |
| `server/scripts/normalize-global-prompt.ts` | **新建**。可選執行：讀取 DB `system_prompt`，以 `normalizeSections()` 去重；`--write` 時寫回 DB，否則僅印出差異。 |

---

## 2. 為什麼這樣改

- **A（拆 prompt builder）**：`getEnrichedSystemPrompt()` 不再把全域/品牌/時段/流程/商品/知識/圖片全部硬串在一處，改由 `assembleEnrichedSystemPrompt()` 依序呼叫各 builder 再 `normalizeSections()`，職責分離。
- **B（去重複規則）**：runtime 組裝後以 `normalizeSections()` 依 "--- 標題 ---" 去重，避免同標題區塊重複拼入；另提供 `normalize-global-prompt.ts` 可選擇性整理 DB 內既有 `system_prompt`。
- **C（人格 vs 流程）**：全域 prompt 仍從 DB 讀取（安全/誠實/不亂編等）；品牌區塊僅語氣與規範；流程改為 `buildFlowPrinciplesPrompt()` 高層原則（物流提示、退換貨表單、何時可呼叫 transfer_to_human），不重複細部 SOP。
- **D（降低 prompt 直接命令 handoff）**：流程區塊改為簡短「何時傾向轉接」與「訂單查詢失敗可考慮轉接」，細節由程式（handoff service）處理。
- **E（模型 fallback 統一）**：所有呼叫 OpenAI 處改為使用 `resolveOpenAIModel()`，fallback 統一為 `gpt-4o-mini`，不再出現 gpt-5.2 / gpt-4o / gpt-4o-mini 混用。

---

## 3. 這次改動解決什麼風險

- **prompt 與程式打架**：流程與 handoff 高層在 prompt、細部在 code，減少重複與衝突。
- **同區塊重複**：runtime 去重與可選 DB 腳本可避免「訂單查詢決策樹」「禁止事項」等重複出現。
- **模型不一致**：單一 `resolveOpenAIModel()` 後，各路徑 fallback 一致，易於維運與成本控制。

---

## 4. 怎麼驗收

1. **prompt builder**：`server/services/prompt-builder.ts` 存在，export 各 build* 與 `assembleEnrichedSystemPrompt`、`normalizeSections`；`getEnrichedSystemPrompt` 僅委派組裝。
2. **全域/品牌/流程分工**：組裝順序為 global → brand → humanHours → flow → catalog → knowledge → image；flow 區塊為高層原則。
3. **去重**：`normalizeSections()` 會依 "--- 標題 ---" 保留首次出現；可執行 `npx tsx server/scripts/normalize-global-prompt.ts`（可加 `--write`）驗證。
4. **模型**：`server/openai-model.ts` 的 `resolveOpenAIModel()` 為單一來源；routes、LINE/FB webhook、already-provided-search、meta-comments suggest-reply 皆使用它。

---

## 5. 驗收結果

| 項目 | 結果 |
|------|------|
| `npm run check:server` | 通過。 |
| `npm run build` | 通過。 |
| 程式面 | prompt-builder 已拆責任；getEnrichedSystemPrompt 委派組裝；flow 為高層原則；normalizeSections 已用於組裝；resolveOpenAIModel 已統一；可選腳本已提供。 |

**需真人/環境驗證**：實際發送對話確認組裝後 system prompt 內容與行為符合預期；可選執行 `normalize-global-prompt.ts --write` 整理既有 DB 內容。

---

## 6. 未改動說明

- **DB 內 system_prompt 預設值**：未在本次修改；若需整理既有資料可執行 `normalize-global-prompt.ts --write`。
- **品牌 system_prompt**：仍由各品牌欄位讀取，未做去重寫回；僅組裝時與全域一起經 `normalizeSections()`。

第六階段 prompt 架構與模型統一已完成。
