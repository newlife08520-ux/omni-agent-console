# Phase 0 — 現況架構盤點（Read-only Audit）

**盤點基準**：`Omni-Agent-Console` 目錄內原始碼與 SQLite（`getDataDir()` → 開發環境常為 `process.cwd()/omnichannel.db`）。**本檔為 2026-04-02 Phase 0 產出**，與 `docs/multi-brand-agent-ops/` 內既有文件可交叉比對；差異以本檔「證據標註」為準。

---

## 1. 系統分層（粗）

| 層 | 代表位置 | 職責 |
|----|-----------|------|
| Inbound | `server/*webhook*`、`routes/meta-comments.routes.ts` 等 | 接收平台事件、建立/更新 contact、觸發 AI |
| 狀態／意圖 | `conversation-state-resolver.ts` | `ConversationState`、`primary_intent` |
| 單輪計畫 | `reply-plan-builder.ts` | **一輪一個** `ReplyPlanMode` |
| Prompt | `server/services/prompt-builder.ts` | `assembleEnrichedSystemPrompt` |
| LLM + Tools | `ai-reply.service.ts`、`openai-tools.ts`、`tool-executor.service.ts` | 呼叫 OpenAI、注入 tools |
| 訂單 | `order-service.ts`、`order-lookup-policy.ts`、`superlanding.ts`、`shopline.ts` | 查單、政策、來源偏好 |
| 儲存 | `storage.ts`、`db.ts` | SQLite schema、CRUD |
| 營運 UI | `client/src/pages/*` | 設定、知識、品牌渠道、對話 |

---

## 2. 品牌差異散落在哪裡

| 維度 | 主要位置 | 說明 |
|------|-----------|------|
| **Persona／語氣** | `brands.system_prompt`（DB）＋ `buildBrandPersonaPrompt` | 以「--- 品牌語氣與規範 ---」區塊併入 system prompt |
| **全域政策** | `settings` 表的 `system_prompt` key＋ `buildGlobalPolicyPrompt` | 與品牌層疊加；易形成超長「一腦」 |
| **規則（流程／轉人工）** | `reply-plan-builder.ts`、`conversation-state-resolver.ts`、`order-lookup-policy.ts`、`phase2-output`、`content-guard*` | 多為程式硬規則，非 per-brand 資料表 |
| **工具綁定** | `openai-tools.ts` 定義全集；`ai-reply.service.ts` 以 `orderLookupTools + humanHandoffTools + imageTools?` 合併 | **無**依情境或品牌的 tool whitelist 表 |
| **知識綁定** | `knowledge_files.brand_id`＋ `storage.getKnowledgeFiles(brandId)`＋ `buildKnowledgePrompt` | 已能依品牌篩檔；**無**依情境（scenario）標籤篩選的正式機制（`db.ts` 有 knowledge metadata 欄位 migration 註解，需以實際欄位為準） |
| **渠道** | `channels.brand_id`、`contacts.brand_id`／`channel_id` | Webhook 綁品牌的主要關聯 |
| **Meta 留言** | `meta_page_settings`、`meta_comment_*` | `page_id` ↔ `brand_id` |

---

## 3. 共用核心（建議視為「不要整塊重寫」）

- Webhook → contact/message 寫入與基本路由。
- `tool-executor.service.ts`（查單、轉人工、圖片 side effect）。
- `order-service` / `order-index` / `order_lookup_cache` 語意。
- `handoff` / `assignment`。
- `meta-comments-storage` 與風險規則（若產品持續使用）。
- `ai_logs` 寫入點（可擴欄位，不宜先拆毀）。

---

## 4. 已具品牌專屬卻可能「硬寫在共用流程」的痕跡

- **`buildFlowPrinciplesPrompt`**（`prompt-builder.ts`）：預設 `returnFormUrl` 後備為固定 URL、`shippingHint` 依 `productScope`（sweet / 非 sweet）分支——屬**業務語意**，透過 `productScope` 與品牌欄位部分參數化，但預設字串仍可能與特定品牌假設耦合。
- **`getProductScopeFromMessage`**（`ai-reply.service.ts`）：以關鍵字區分 bag／sweet——**跨品牌共用**的產品線假設；非所有品牌都適用。
- **`ISSUE_TYPE_KEYWORDS` 等**：關鍵字分類為**全域**字典，非 per-brand。

---

## 5.「一腦多用」與 prompt 打架風險

- **多區塊串接**：`assembleEnrichedSystemPrompt` 將 global、brand、human_hours、flow、catalog、knowledge、image 串接後 `normalizeSections` 去重——若兩處政策用不同標題但同義，**去重無法**消除語義衝突。
- **`order_lookup` / `order_followup` 瘦身**：`planMode` 為查單時略過 catalog／knowledge／部分 flow——與「全情境同一套 prompt」相比已緩解，但 **tools 仍為全集**（見 `CURRENT_PROMPT_TOOL_FLOW.md`），LLM 仍可能被誤導呼叫查單工具。
- **額外 system 字串**：部分流程在 `getEnrichedSystemPrompt` 結果後再拼接指令（例如 vision 路徑），增加與主 prompt 不一致的機率。

---

## 6. 最容易互相污染之處

| 區域 | 原因 |
|------|------|
| 全域 `settings.system_prompt` + 品牌 `system_prompt` | 雙層疊加，營運難以預測最終語氣與禁令 |
| 同一輪 **tools 全集** | 售後與查單工具並存時，模型可能選錯 tool |
| **知識庫全掃**（非 diet 模式） | 售後與行銷 FAQ 混在同一 KNOWLEDGE 區塊 |
| **跨品牌共用的關鍵字／scope 推斷** | A 品牌訊息被 B 品牌的產品假設解讀 |

---

## 7. 證據與限制

- **本檔結論**：主要為 **code-derived**；執行環境實際 `settings`／`brands` 內容見 `runtime_snapshot` 與 `_export_summary.json`。
- **Repo 內** `docs/multi-brand-agent-ops/gemini-10-pack/` 與上一層 md 為既有設計資產，**非**本 Phase 0 執行後才新增的實作。
