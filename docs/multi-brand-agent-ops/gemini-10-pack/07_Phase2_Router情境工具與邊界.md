# 合併來源：`HYBRID_ROUTER_DESIGN.md` + `SCENARIO_ISOLATION_SPEC.md` + `TOOL_WHITELIST_SPEC.md` + `ROUTER_EDGE_CASES.md`（全文）

---

# 第一部分：`HYBRID_ROUTER_DESIGN.md`

# Phase 2 — Hybrid Router 設計

---

## 1. 目標輸出（固定 JSON）

```json
{
  "intent": "ORDER_LOOKUP | AFTER_SALES | PRODUCT_CONSULT | GENERAL",
  "confidence": 0.0,
  "source": "rule | llm"
}
```

**與內部狀態銜接**：

- `intent` 映射到 `SelectedScenario`（四選一）。
- 現有 `ConversationState.primary_intent` 可 **保留**作細粒度 log；Router 輸出為 **粗粒度營運視角**。

---

## 2. Step 1 — Hard-rule pre-router（建議觸發順序）

1. **訂單編號／強查單**（沿用 `order-lookup-policy` + `ORDER_LOOKUP_PATTERNS`）：→ `ORDER_LOOKUP`，`confidence≥0.9`，`source=rule`。
2. **明確退換貨／取消／瑕疵**（沿用 `REFUND_RETURN_PATTERNS`、`PRODUCT_ISSUE_PATTERNS`）：→ `AFTER_SALES`，高信心。
3. **商品價格／連結／規格**（`product_consult`、`price_purchase`、`link_request`）：→ `PRODUCT_CONSULT`。
4. **離題／閒聊**（現有 `off_topic`、`smalltalk`）：→ `GENERAL` 或子類 `off_topic_guard`（實作時二層：Scenario=GENERAL + plan 細分）。

**規則**：硬規則命中且 confidence ≥ 門檻 → **不呼叫** LLM Router。

---

## 3. Step 2 — LLM fallback router

**輸入**（精簡）：當前句 + 極短摘要（例如上一句意圖），**不含**完整 catalog/knowledge。

**輸出**：僅上述 JSON；temperature 低（如 0.2）。

**失敗**：JSON parse 失敗 → `GENERAL` + `confidence=0` + `source=llm` + log error。

---

## 4. Step 3 — 與 `buildReplyPlan` 的協作

**選項 A（漸進）**：Router 只決定 **Scenario**；`buildReplyPlan` 仍決定 `return_form_first` vs `aftersales_comfort_first` 等。

**選項 B（長期）**：把 `ReplyPlanMode` 收斂為 Scenario 內 **子狀態表**。

建議 Phase 2 採 **A**。

---

## 5. Step 4 — Prompt assembly

見 `SCENARIO_ISOLATION_SPEC.md`：只組 **該 Scenario** 的 fragments + 允許的 knowledge + 全域精簡政策。

---

## 6. 監控

- 每則訊息 log：`router_intent`、`router_confidence`、`router_source`（可進 `ai_logs` 新欄位或 JSON）。

---

# 第二部分：`SCENARIO_ISOLATION_SPEC.md`

# Scenario 隔離規格

---

## 1. 四情境定義

| Scenario | 營運描述 | 典型使用者句 | 備註 |
|----------|-----------|----------------|------|
| ORDER_LOOKUP | 查單、物流、出貨進度 | 「我的單什麼時候到」 | 可併用 order_followup |
| AFTER_SALES | 退換貨、取消、瑕疵、客訴 | 「我要退款」「東西壞了」 | 內部再用 plan 分表單/安撫 |
| PRODUCT_CONSULT | 規格、價格、連結、比較 | 「這款跟那款差在哪」 | 可帶 catalog/knowledge |
| GENERAL | 閒聊、模糊、其他 | 「在嗎」 | 可含 off_topic_guard |

---

## 2. 單輪單主腦

- **每輪** `selected_scenario` **恰好一個**。
- **禁止**：同一輪對使用者輸出內容來自兩個 Scenario 的「並列主線」（可接受：先工具查單再同一 Scenario 內組句）。

**切換**：

- 若本輪 router 結果與上一輪不同 → 寫 `scenario_switch: { from, to, reason }` 至 trace。

---

## 3. Prompt 內容隔離

| Scenario | Global 精簡政策 | Brand tone | Catalog | Knowledge | 查單專用長文 |
|----------|-----------------|------------|---------|-----------|----------------|
| ORDER_LOOKUP | ✓ | ✓ | 預設 ✗ | 預設 ✗ | 僅允許「查單片段」欄 |
| AFTER_SALES | ✓ | ✓ | ✗ | 僅 tagged「售後」 | ✗ |
| PRODUCT_CONSULT | ✓ | ✓ | ✓ | ✓（可限 tag） | ✗ |
| GENERAL | ✓ | ✓ | 預設 ✗ | 限縮 | ✗ |

（✗/✓ 為預設策略，以 `content_json` 覆寫為準。）

---

## 4. 與現有 `order_lookup_prompt_diet`

現有 `planMode === order_lookup` 已 **略過** catalog/knowledge；Scenario 化後應 **對齊**避免行為倒退。

---

## 5. 多 Agent（非目標）

- 不實作「多個 Agent 同時發話」。
- `Agent Profile` 僅作 **設定容器**，同一輪仍單一 profile 生效（除非未來明確定義「轉接換 profile」）。

---

# 第三部分：`TOOL_WHITELIST_SPEC.md`

# Tool Whitelist 規格

---

## 1. 原則

- **Allow list**：Scenario 僅列出 **可用** tool `name`（與 OpenAI function name 一致）。
- **預設 deny**：未列於 allow list 的 tool **不傳給** `chat.completions` 的 `tools` 參數。
- **Executor**：不修改；若收到非法 tool call（理論上不應發生）→ 回錯誤 JSON + log **policy_violation**。

---

## 2. 建議預設矩陣（可於資料模型覆寫）

| Tool | ORDER_LOOKUP | AFTER_SALES | PRODUCT_CONSULT | GENERAL |
|------|----------------|-------------|-----------------|---------|
| lookup_order_by_id | ✓ | ✗ | ✗ | ✗ |
| lookup_order_by_product_and_phone | ✓ | ✗ | ✗ | ✗ |
| lookup_order_by_date_and_contact | ✓ | ✗ | ✗ | ✗ |
| lookup_more_orders* | ✓ | ✗ | ✗ | ✗ |
| transfer_to_human | ✓ | ✓ | ✓ | ✓ |
| send_image_to_customer | ✗ | ✗ | ✓ | ✗ |

**誠實註記**：實際 tool 名稱以 `openai-tools.ts` 為準；上表為示意，實作前需 **grep 完整清單** 對表。

---

## 3. AFTER_SALES 例外

- 久候型可能需 **查單工具**（現有 `aftersales_comfort_first`）。  
- **規則**：允許 `ORDER_LOOKUP` 工具子集 **僅當** `ReplyPlanMode` 為 `aftersales_comfort_first` 或 router 子狀態標記 `allow_order_tools_in_aftersales=true`。

---

## 4. 與 imageTools

- `imageTools` 僅在 `PRODUCT_CONSULT`（或 GENERAL 若營運要求）且 **品牌有圖片資產** 時加入。

---

## 5. 驗證

- 單元測試：`pickTools(scenario, plan)` 回傳集合。
- 整合測試：對話腳本斷言 **未出現**禁用的 tool call（見 `TOOL_ISOLATION_TEST_RESULTS.md`）。

---

# 第四部分：`ROUTER_EDGE_CASES.md`

# Router 邊界案例（Edge Cases）

**用途**：實作 Phase 2 時與 QA 對照；非完整清單。

---

## 1. 複合意圖（同句多需求）

- **例**：「我要退款，順便問訂單到哪了」  
- **策略**：硬規則 **優先序** — 若含強烈售後關鍵字 → `AFTER_SALES`；並在 trace 標 `compound_utterance=true`。  
- **產品**：可於售後 Scenario 內允許 **有限**查單工具（見 `TOOL_WHITELIST` AFTER_SALES 例外）。

---

## 2. 訂單編號出現在退貨句

- **例**：「KBT12345 這筆我要退」  
- **策略**：**AFTER_SALES** 優先（避免變成冷查單句忽略情緒）；查單由 plan/tool 在情境內處理。

---

## 3. 純手機號

- 沿用 `order-lookup-policy`：`phone_all_orders` vs 模糊。  
- Router intent 可能 `ORDER_LOOKUP`，但 tool 層 **summaryOnly** 等行為保持。

---

## 4. 官網 vs 一頁 來源

- `resolveOrderSourceIntent` 與 Router **獨立**：Router 決定 Scenario；來源偏好仍舊模組。

---

## 5. 圖片訊息

- Router 可降 confidence → LLM fallback 或預設 `PRODUCT_CONSULT`（若營運同意）。  
- **風險**：誤判為導購；可要求 **圖片時總是**帶小額 vision 上下文 **不**帶 catalog（另規格）。

---

## 6. 修正語「不是、我要改」

- 現有 `CORRECTION_OVERRIDE_PATTERNS`：**本輪重算**。  
- Scenario switch 應允許與上一輪不同。

---

## 7. Safe confirm / 高風險短路

- **不經**一般 Router 或 **最高優**覆寫：維持現有 `ai-reply.service` 短路，但在 trace 標 `short_circuit=safe_confirm|high_risk`。

---

## 8. LLM Router 胡說 JSON

- Parse 失敗 → `GENERAL` + log + **可選**再問一句澄清（現有 `ask_one_question` 可重用）。
