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
