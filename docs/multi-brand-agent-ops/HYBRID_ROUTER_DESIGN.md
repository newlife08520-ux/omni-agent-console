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
