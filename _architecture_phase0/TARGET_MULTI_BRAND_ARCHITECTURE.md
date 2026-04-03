# 目標架構（10 自有品牌導向，非通用 SaaS）

**定位**：內部客服中台；**不做**大畫布、**不急**多 Agent 同時對話。原則：**Shared Core + Brand Overrides**、**Hybrid Router**、**Scenario Isolation**、**Tool Whitelist**、**Traceability**、**Lite Admin**。

---

## 1. 概念模型（精簡實體）

| 實體 | 用途 |
|------|------|
| **Brand** | 組織邊界；綁渠道、憑證、預設 Agent Profile |
| **Agent Profile** | 可選；若初期一品牌一 Profile，可與 Brand 1:1 |
| **Scenario** | ORDER_LOOKUP / AFTER_SALES / PRODUCT_CONSULT / GENERAL（營運粗粒度） |
| **Tool Bindings** | 每（Brand 或 Profile）× Scenario → `allowed_tool_names[]` |
| **Knowledge Bindings** | 每 Scenario → 允許的 knowledge tag／檔案集合或排除規則 |
| **Channel Bindings** | 現有 `channels.brand_id` 延續；Meta `meta_page_settings` 對齊 |
| **Versioning** | `draft` / `published` / `rollback`：以小表或 JSON snapshot 存「生效組態」，避免過度泛化 SaaS 版控 |

**刻意不做的 schema**：通用 workflow 節點圖、任意租戶外掛 marketplace、複雜 RBAC 商品化。

---

## 2. 四情境定義與預設 prompt 區塊

| Scenario | 建議 prompt 區塊 | 預設排除／限縮 |
|----------|------------------|----------------|
| **ORDER_LOOKUP** | Global（精簡）+ Brand tone + **查單專用片段** | CATALOG、行銷 KNOWLEDGE 預設關閉（與現 `order_lookup_prompt_diet` 對齊） |
| **AFTER_SALES** | Global（精簡）+ Brand tone + 售後 SOP 摘要 | CATALOG 預設關；KNOWLEDGE 僅 **售後 tag** |
| **PRODUCT_CONSULT** | Global + Brand + CATALOG + KNOWLEDGE（可限 tag） | 查單長文預設關 |
| **GENERAL** | Global + Brand + 限縮 KNOWLEDGE | CATALOG 預設關；off_topic 子規則可併入 |

---

## 3. 預設 Tool Whitelist（可 per-brand 覆寫）

| Scenario | 建議允許（範例） |
|----------|------------------|
| ORDER_LOOKUP | `lookup_*`（依品牌啟用之來源）、`transfer_to_human`；（圖片工具視品牌資產） |
| AFTER_SALES | `transfer_to_human` 為主；查單工具 **預設關**或僅在 **Hybrid 規則**允許時開（例如 `aftersales_comfort_first` 需查出貨） |
| PRODUCT_CONSULT | 圖片工具（若有）、`transfer_to_human`；**不**預設開全套 lookup（避免閒聊變查單） |
| GENERAL | `transfer_to_human`；其餘極小集或全關（依風險承受度） |

**重點**：AFTER_SALES **不採**「絕對禁止一切查單」的一刀切表述；與現有 `aftersales_comfort_first`（先安撫＋可查詢出貨）一致。

---

## 4. Hybrid Router 設計要點

**Step 1 — 硬規則（高信心）**  
- 訂單編號／強查單意圖 → ORDER_LOOKUP  
- 明確退換貨／取消／瑕疵關鍵字 → AFTER_SALES  
- 價格／規格／連結 → PRODUCT_CONSULT  
- 離題／極短閒聊 → GENERAL  

**Step 2 — LLM Router（低溫、短上下文）**  
- 僅在規則信心低於門檻時呼叫；輸出固定 JSON：`intent` + `confidence` + `source`  

**Step 3 — 與現有 `buildReplyPlan` 協作**  
- 第一階段：Router 決 **Scenario**；`buildReplyPlan` 仍決子模式（表單先／安撫先等）。  

---

## 5. Traceability（最小欄位建議）

每則 AI 處理建議可記：`selected_scenario`、`router_source`（rule|llm）、`router_confidence`、`allowed_tools` 摘要、`prompt_profile`（與現 `EnrichedPromptResult.prompt_profile` 對齊擴充）。

---

## 6. 與現況映射

現有 `ReplyPlanMode` 與 `primary_intent` **可過渡映射**到四 Scenario，不需第一天刪除舊 enum；重點是 **tools 與 knowledge 切片**與 **trace** 先落地。
