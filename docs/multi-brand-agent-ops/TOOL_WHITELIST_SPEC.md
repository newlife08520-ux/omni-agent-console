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
