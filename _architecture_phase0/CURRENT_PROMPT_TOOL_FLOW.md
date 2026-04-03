# Phase 0 — Prompt 與工具流程追蹤

---

## 1. 入口與組裝鏈

| 步驟 | 函式／檔案 | 說明 |
|------|-------------|------|
| 總組裝 | `assembleEnrichedSystemPrompt(brandId, context)` | `server/services/prompt-builder.ts` |
| 便捷包裝 | `getEnrichedSystemPrompt` | `ai-reply.service.ts` → 呼叫上面並回傳 `full_prompt` |
| Context | `EnrichedPromptContext` | `planMode`（如 `order_lookup`／`order_followup`）、`productScope`、`recentUserHasImage` |

**拼接順序**（非 image 全開時與 vision 路徑略有差異，見原始碼）：  
`buildGlobalPolicyPrompt`（`settings.system_prompt`）→ `buildBrandPersonaPrompt`（`brands.system_prompt`）→ `buildHumanHoursPrompt`（查單 diet 時可略）→ `buildFlowPrinciplesPrompt`（查單 diet 時略）→ `buildCatalogPrompt`（查單 diet 時略）→ `buildKnowledgePrompt`（查單 diet 時略）→ `buildImagePrompt` → `normalizeSections`。

---

## 2. 是否「大雜燴式」prompt？

**是，但已有局部瘦身**：

- **完整模式**：global + brand + 班表 + flow + CATALOG + KNOWLEDGE + IMAGE（若該品牌有資產）同時存在，屬典型 **monolithic system string**。
- **查單／追問 diet**：`planMode === "order_lookup" \|\| "order_followup"` 時略過 catalog、knowledge、human_hours、flow 等——**prompt 層**已部分情境化。
- **Ultra-lite 系列**：`buildOrderLookupUltraLitePrompt` 等標為 `@deprecated`，保留相容。

---

## 3. Tools 陣列如何生成？

**定義**：`server/openai-tools.ts`  
- `orderLookupTools`：多個 lookup_* function declarations  
- `humanHandoffTools`：`transfer_to_human` 等  
- `imageTools`：`send_image_to_customer`  

**注入**（例：`ai-reply.service.ts`）：  
```text
allTools = [...orderLookupTools, ...humanHandoffTools, ...(hasImageAssets ? imageTools : [])]
```
**未見**依 `ReplyPlanMode` 或 scenario 的子集過濾（**code-derived** 結論）。

**其他入口**：`routes/core.routes.ts`、`contacts-orders.routes.ts`、`meta-comments.routes.ts`、`settings-brands.routes.ts`、`sandbox.routes.ts` 亦 import 相同 tools 集合做測試／沙盒——行為與主線一致為「全集傾向」。

---

## 4. 查單工具、售後知識、FAQ、handoff 是否「物理隔離」？

| 項目 | Prompt 層 | Tools 層 |
|------|-----------|----------|
| 查單 | diet 時可不含 KNOWLEDGE／CATALOG | **未隔離**：查單 tools 仍與 transfer 等一併提供 |
| 售後／FAQ | 未分 tag 時整包 KNOWLEDGE | 無專用「售後 tool」；靠 `transfer_to_human` 與內文 |
| Handoff | flow 與全域政策中有描述 | `transfer_to_human` 始終在 tools 內（除非另有分支未掃到） |

**結論**：**無**完整的 scenario-based tool whitelist；**部分** prompt 隔離（order_lookup diet）。

---

## 5. 與目標（scenario assembly + tool whitelist）的差距

1. **Router 輸出**：目標四情境（ORDER_LOOKUP / AFTER_SALES / PRODUCT_CONSULT / GENERAL）應驅動 **prompt 片段集**與 **allowed_tools**；現況為 `primary_intent` + `ReplyPlanMode`，**命名與粒度不同**，且 tools 未掛鉤。
2. **Knowledge 依情境過濾**：需 metadata（tag／category）或分庫；現況 `buildKnowledgePrompt` 為品牌內全檔（有長度上限）。
3. **Hybrid Router**：現況已有大量 **硬規則**（resolver、reply-plan、order-lookup-policy）；**尚無**獨立「LLM router 僅輸出 JSON intent」的模組化層（設計見 `docs/multi-brand-agent-ops/HYBRID_ROUTER_DESIGN.md`，**未於本 repo 實作**）。
4. **Trace**：`ai_logs` 存在；是否已記錄 router／scenario／tool_allowlist **需查實際寫入點**（本 Phase 0 未改 code，詳見 runtime 欄位取樣）。

---

## 6. 相關輔助

- `server/tool-llm-sanitize.ts`：`finalizeLlmToolJsonString` — tool 回傳給 LLM 前的清理／防洩漏。
- `server/services/handoff.ts`：與 `transfer_to_human`、contact 狀態一致化。
