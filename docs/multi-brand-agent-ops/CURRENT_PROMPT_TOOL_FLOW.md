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
