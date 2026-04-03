# 合併來源：`CURRENT_ARCHITECTURE_AUDIT.md`（全文）

---

# Phase 0 — 現況架構盤點（Architecture Audit）

**範圍**：`Omni-Agent-Console` 後端（Express + SQLite）與前端（Vite/React）。**盤點基準日**：以 repo 現況為準；若與部署環境有差，以實際 DB／環境變數為準。

---

## 1. 系統分層（粗）

| 層 | 代表位置 | 職責 |
|----|-----------|------|
| Inbound | `line-webhook.controller.ts`, `facebook-webhook.controller.ts`, `meta-comments.routes.ts` | 接收平台事件、建立/更新 contact、觸發 AI |
| 狀態／意圖 | `conversation-state-resolver.ts` | 產出 `ConversationState`（`primary_intent` 等） |
| 單輪計畫 | `reply-plan-builder.ts` | **一輪一個** `ReplyPlanMode`（與目標「Scenario」概念相近但命名不同） |
| Prompt | `services/prompt-builder.ts` | 組裝 `assembleEnrichedSystemPrompt`（global + brand + catalog + knowledge + image + flow…） |
| LLM + Tools | `services/ai-reply.service.ts`, `openai-tools.ts`, `services/tool-executor.service.ts` | 呼叫 OpenAI、注入 tools、執行 tool |
| 訂單 | `order-service.ts`, `order-index.ts`, `order-lookup-policy.ts`, `superlanding.ts`, `shopline.ts` | 查單、快取、來源偏好 |
| 儲存 | `storage.ts`, `db.ts` | SQLite schema、CRUD |
| 營運 UI | `client/src/pages/*.tsx` | 設定、知識、品牌渠道、對話 |

---

## 2. 品牌／渠道資料是否已存在？

**是，且為核心關聯**：

- **`brands`**：`system_prompt`、SuperLanding／Shopline 憑證、`return_form_url` 等（見 `shared/schema.ts` `Brand`）。
- **`channels`**：`brand_id` + `platform`（`line` | `messenger`）+ token／secret。
- **`contacts`**：`brand_id`、`platform`、狀態與案件欄位。
- **`knowledge_files`**：依 `brand_id` 篩選（`storage.getKnowledgeFiles(brandId)`）。
- **Meta 留言**：`meta_page_settings`（`page_id` ↔ `brand_id`）、`meta_comment_*` 系列表。

**缺口（相對目標架構）**：

- 無第一級「**Scenario 設定表**」：情境差異主要靠 **程式規則**（`conversation-state-resolver` + `reply-plan-builder`）+ **超長 global `settings.system_prompt`** + **品牌 `system_prompt`** 疊加。
- **無 draft/publish 版本化**：設定變更即寫入現行 row／`settings` key。
- **Tool 非依情境白名單**：見 `CURRENT_PROMPT_TOOL_FLOW.md`。

---

## 3. 共用核心（建議保留）

以下模組已承載大量正確行為，**不建議整塊重寫**：

- Webhook 控制器與訊息／聯絡人寫入流程。
- `tool-executor.service.ts`（查單、轉人工、圖片等 side effect）。
- `order-service` / `order-index` / `order_lookup_cache` 語意。
- `handoff` / `assignment` 相關流程。
- `meta-comments-storage`、風險規則（若持續使用）。
- `ai_logs` 寫入點（可擴欄位，不宜先拆毀）。

---

## 4. 已具備的「單輪單主腦」雛形

- `reply-plan-builder.ts` 註解明確：**一輪一個 mode**，優先序表（handoff → 退換貨路徑 → order_lookup → …）。
- `ConversationState.primary_intent` 與 `ReplyPlanMode` **不等同**，但共同限制「不要多流程搶答」。

**與目標四情境對照**（概念映射，非現有 enum）：

| 目標 Scenario | 現況主要承載 |
|-----------------|---------------|
| ORDER_LOOKUP | `primary_intent === order_lookup` + `ReplyPlanMode` order_lookup / order_followup |
| AFTER_SALES | refund/return/cancel 意圖 + return_form_first、aftersales_comfort_first、return_stage_1、handoff |
| PRODUCT_CONSULT | product_consult、price_purchase、link_request → answer_directly |
| GENERAL | smalltalk、unclear、off_topic → answer_directly / off_topic_guard |

---

## 5. Feature 開關現況

- **`order-feature-flags.ts`**：以 **環境變數** 為主（`ENABLE_ORDER_*`、`CONSERVATIVE_SINGLE_ORDER` 等），**非 per-brand**。
- 達成「逐品牌試跑」需 **新增** brand-level 或 config-version-level 開關，不宜直接假設現有 env 可滿足。

---

## 6. 誠實結論

- **現況是「規則 + 單輪 plan + 巨型 prompt 拼接」**，已能跑內部業務；**最大風險**是 global／brand 文字規則與 catalog/knowledge **全量或大量進上下文**，以及 **tools 全集對 LLM 可見**。
- **Schema 已支援 brand/channel/page**，但 **未支援**「情境維度的設定與版本」。Phase 1 應以 **最小表** 補齊，而非重造多租戶。

---

## 7. 參考原始碼錨點（盤點用）

- 狀態：`server/conversation-state-resolver.ts`
- 計畫：`server/reply-plan-builder.ts`
- Prompt：`server/services/prompt-builder.ts`
- AI 主流程：`server/services/ai-reply.service.ts`
- Tools 定義：`server/openai-tools.ts`
- 查單政策：`server/order-lookup-policy.ts`
- DB migration：`server/db.ts`
