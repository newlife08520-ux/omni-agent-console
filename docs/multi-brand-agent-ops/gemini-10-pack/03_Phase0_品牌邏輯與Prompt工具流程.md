# 合併來源：`CURRENT_BRAND_LOGIC_MAP.md` + `CURRENT_PROMPT_TOOL_FLOW.md`（全文）

---

# 第一部分：`CURRENT_BRAND_LOGIC_MAP.md`

# Phase 0 — 品牌邏輯地圖（Brand Logic Map）

說明 **品牌差異實際落在哪些檔案／資料**，以利後續「抽成 Override」時不遺漏。

---

## 1. 資料庫與設定

| 區域 | 位置 | 品牌相關？ | 說明 |
|------|------|------------|------|
| `settings` key-value | `storage.getSetting` | **多為全域** | `system_prompt` 為 **全品牌共用底稿**（體積大時會壓過品牌細節感知） |
| `brands` | `storage.getBrand` | **強** | `system_prompt`（語氣／規則）、電商憑證、`return_form_url` |
| `channels` | `brand_id` | **強** | LINE/Messenger token；決定 inbound 綁哪個品牌 |
| `knowledge_files` | `brand_id` | **強** | 知識庫僅掛品牌，無「情境子集」欄位 |
| `image_assets`（若有） | 依 brand 查 | **強** | 與 catalog 類似，屬品牌素材 |
| `meta_page_settings` | `brand_id` + `page_id` | **強（Meta 渠道）** | 留言自動回覆／導 LINE／模板等 **與一對一客服並行的一條線** |
| `orders_normalized` 等 | `brand_id` | **資料隔離** | 查單正確性依品牌索引，非「人格」 |

---

## 2. Prompt 與內容來源

| 區塊 | 函式／檔案 | 範圍 |
|------|------------|------|
| Global 政策 | `buildGlobalPolicyPrompt()` | `settings.system_prompt` |
| 品牌人格 | `buildBrandPersonaPrompt(brandId)` | `brands.system_prompt` |
| 服務時段 | `buildHumanHoursPrompt()` | **全域** schedule + assignment |
| 流程高層 | `buildFlowPrinciplesPrompt` | `return_form_url` 取自 brand；`productScope` 來自對話狀態 |
| 商品型錄 | `buildCatalogPrompt(brandId)` | SuperLanding 設定隨 brand |
| 知識庫 | `buildKnowledgePrompt(brandId)` | 該品牌 **全部** 有內容檔案拼進（有總字數上限） |
| 圖片資產 | `buildImagePrompt(brandId)` | 該品牌資產 |

**污染風險**：同一品牌一輪對話仍可能帶入 **完整 knowledge + catalog**（僅在 `order_lookup`／`order_followup` 時略做 **prompt diet** 略過部分區塊，見 `prompt-builder.ts` `planMode`）。

---

## 3. 規則與「像品牌專屬」但寫在共用程式裡的邏輯

| 區域 | 檔案 | 現象 |
|------|------|------|
| 意圖關鍵字 | `conversation-state-resolver.ts` | Regex／中文關鍵字 **全系共用** |
| 查單來源偏好 | `order-lookup-policy.ts` | 「官網／一頁」關鍵字共用 |
| 回覆計畫優先序 | `reply-plan-builder.ts` | 全系共用 |
| 內容護欄 | `content-guard.ts` 等 | 依 `ReplyPlanMode` 禁用促銷等 **共用** |
| Safe confirm／高風險 | `ai-reply.service.ts` + classifier | 模板與 Meta 設定互動；**部分路徑依 brand 取 template** |

若某品牌需要「較鬆／較緊」的關鍵字或流程，**目前沒有 DB 欄位**，只能改程式或把規則塞進 `system_prompt`（難維護）。

---

## 4. 工具（Tools）與品牌

- Tool **定義**在 `openai-tools.ts`（全系共用描述與 schema）。
- **執行**在 `tool-executor.service.ts`，已支援 `brandId` 等 context。
- **未見**依品牌或情境 **動態刪減** tool 列表（見 `CURRENT_PROMPT_TOOL_FLOW.md`）。

---

## 5. 前端：營運從哪裡改到「品牌」？

| 頁面 | 檔案 | 管理內容 |
|------|------|----------|
| 設定（全域） | `settings.tsx` | 含 `system_prompt` 等 |
| 品牌／渠道 | `brands-channels.tsx` | 品牌 CRUD、渠道 |
| 知識庫 | `knowledge.tsx` | 上傳／列表（依品牌選取） |
| 對話 | `chat.tsx` | 客服操作，**非**結構化「本輪 scenario trace」 |
| 留言中心 | `comment-center.tsx` | Meta 另一戰場 |

**易誤用點**：

- 在 **全域** `system_prompt` 寫入過長「訂單決策樹」時，與 **品牌** `system_prompt` 疊加，模型與人都難確認優先序。
- 知識檔 **無情境標籤** 時，售後與導購 FAQ 可能同時進上下文。

---

## 6. 摘要

品牌差異 **已** 有：`brands`、`channels`、`knowledge`、Meta `meta_page_settings`。  
品牌差異 **不足** 處：情境維度、tool 白名單、設定版本、per-brand feature flag、以及過度依賴 **單一 global prompt**。

---

# 第二部分：`CURRENT_PROMPT_TOOL_FLOW.md`

# Phase 0 — Prompt × Tool × 查單 流程（現況）

---

## 1. 端到端順序（簡化）

1. Webhook 收到使用者訊息 → 取得 `contact`（含 `brand_id`、`platform`）。
2. `resolveConversationState(...)` → `ConversationState`（`primary_intent`、`needs_human`、`return_reason_type`…）。
3. `buildReplyPlan({ state, returnFormUrl, orderFollowupTurn, ... })` → **單一** `ReplyPlanMode`。
4. `assembleEnrichedSystemPrompt(brandId, { planMode, productScope, recentUserHasImage, hasActiveOrderContext })` → `full_prompt` + `sections` metadata。
5. `ai-reply.service` 組 messages、選模型參數、呼叫 OpenAI **`tools`**。
6. 若有 tool calls → `tool-executor`（帶 `brandId`、`platform` 等）。
7. 結束後 `storage.createAiLog(...)`（`reply_source`、`plan_mode`、`tools_called` 等）。

---

## 2. Prompt 層級（現況 = 2.5 層 + 選擇性瘦身）

| 層級 | 來源 | 註解 |
|------|------|------|
| Global | `settings.system_prompt` | 常含長篇訂單 SOP（db 預設 seed 即很長） |
| Brand | `brands.system_prompt` | 「品牌語氣與規範」區塊 |
| 全域排班 | `buildHumanHoursPrompt` | 非品牌 |
| 流程片段 | `buildFlowPrinciplesPrompt` | 部分依 `return_form_url`、`productScope` |
| Catalog | SuperLanding | 依 `brandId` |
| Knowledge | `getKnowledgeFiles(brandId)` | **品牌內全部檔**（直到字數上限） |
| Image | `getImageAssets(brandId)` | 同上 |

### Prompt diet（查單輪）

當 `planMode === "order_lookup"` 或 `"order_followup"`：

- `assembleEnrichedSystemPrompt` 會 **省略** `human_hours`、`flow_principles`、`catalog`、`knowledge`（見 `prompt-builder.ts`）。
- 仍保留 **global + brand + image**（image block 邏輯與 `recentUserHasImage` 有分支）。

這是現有「減少一顆大腦內容」的主要機制，但 **粒度是 plan 字串**，不是目標架構的「Scenario 設定表」。

---

## 3. Tools（現況 = 幾乎全集）

在 `ai-reply.service.ts`（多處）：

```text
allTools = [...orderLookupTools, ...humanHandoffTools, ...(hasImageAssets ? imageTools : [])]
```

- **沒有**依 `ReplyPlanMode` 或 `primary_intent` 做 **白名單切片**（僅 image tools 依資產是否存在）。
- 意義：查單、退換、導購語意可能仍在同一 tool 空間內由模型自選 → **與目標「情境隔離工具」有落差**。

Tool 實作：`services/tool-executor.service.ts`（查單走 `order-service` / `unifiedLookup*`）。

---

## 4. 查單與「非 LLM」邏輯

| 模組 | 角色 |
|------|------|
| `order-lookup-policy.ts` | 訂單編號／手機／來源關鍵字、`OrderLookupIntent`、`shouldBypassLocalPhoneIndex` 等 **規則** |
| `order-service.ts` | 統一查詢、快取讀寫、`data_coverage` / `needs_live_confirm` |
| `order-index.ts` | `cache_key` 格式、`orders_normalized` |
| `intent-and-order.ts` 等 | 與單號分類、fast path 協作 |

這條線 **已是 Hybrid** 的一部分（規則 + 確定性工具），目標 Phase 2 是把它與 **意圖路由 JSON**、**Scenario prompt** 更明確對齊，而非推倒。

---

## 5. `plan_mode` / `reply_source`（觀測）

- `createAiLog` 寫入 `plan_mode`（多為 `ReplyPlanMode`）、`reply_source`（如 `llm`、`gate_skip`、`safe_confirm_template`、`deterministic_tool`…）。
- **缺口**：未有一個欄位完整記錄「prompt 各 section 是否 inclusion」的結構化列表（仅有 `prompt_profile` 等）；Phase 3 可擴充 JSON 欄位或附表。

---

## 6. 與目標架構的差距（一行版）

現況：**規則狀態機 + 單輪 ReplyPlan + 巨型 prompt 拼接 + 全域 tools**。  
目標：**繼承鏈設定 + Scenario 隔離 prompt 片段 + tool whitelist + 可版本發布 + 完整 trace**。
