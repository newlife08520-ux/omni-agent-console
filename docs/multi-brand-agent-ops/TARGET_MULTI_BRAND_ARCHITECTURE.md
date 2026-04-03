# 目標架構 — Multi-Brand Agent Ops（內部 10 品牌）

**原則**：保留 webhook、查單、tool executor、handoff、storage；**重構「設定與觀測」**，不做成通用拖拉 SaaS。

---

## 1. 目標能力

| 能力 | 說明 |
|------|------|
| 隔離 | 品牌／渠道／情境的 persona、規則、知識、工具 **不互相污染** |
| 穩定 | 單輪 **單一主情境**；prompt 只帶該情境需要的區塊 |
| 可管 | Lite Admin：品牌、情境、綁定、發布、對話 trace |
| 可演進 | draft / publish / rollback；**逐品牌** feature flag |
| 可解釋 | 每次回覆可追溯：intent、rule/llm、scenario、tools、policy hits、config version |

---

## 2. 繼承鏈（設定解析順序）

**解析順序（後者覆蓋前者）**：

1. **Global Default** — 全系安全、輸出原則、共用排班敘述（精簡化，避免長 SOP 塞全域）
2. **Brand Override** — 語氣、品牌專屬連結、預設語言基調
3. **Channel Override** — LINE / Messenger /（未來）IG 差異（字數、模板、禁用詞）
4. **Scenario Override** — 四類情境專屬指令與邊界

**實作策略**：先以 **DB JSON 或少量表** 表達 override，**執行時** merge 成 `ResolvedAgentConfig`（純 in-memory 物件），再餵給 prompt assembler 與 tool picker。

---

## 3. Hybrid Router（目標行為）

1. **Hard-rule pre-router**（現有強化）：訂單編號、物流關鍵字、退換貨、商品諮詢、一般句 — 高信心直接標 `intent` + `source: "rule"`。
2. **LLM router**（僅模糊句）：輸出固定 JSON schema，`source: "llm"`。
3. **對齊 Scenario**：將 intent 映射到 `ORDER_LOOKUP` | `AFTER_SALES` | `PRODUCT_CONSULT` | `GENERAL`（可與現有 `PrimaryIntent` / `ReplyPlanMode` **並存一段過渡期**，見 MIGRATION）。

---

## 4. Scenario 與現有 `ReplyPlanMode` 的關係（遷移視角）

**不要**第一天刪除 `reply-plan-builder`。建議：

- **Scenario** = 營運可理解的四象限 + 設定綁定單位。
- **ReplyPlanMode** = 細粒度行為（例如 `return_form_first` vs `aftersales_comfort_first`）可降級為 **Scenario 內部子狀態** 或 **規則表**。

過渡映射範例：

| Scenario | 涵蓋的 ReplyPlanMode（舉例） |
|----------|------------------------------|
| ORDER_LOOKUP | order_lookup, order_followup |
| AFTER_SALES | return_form_first, aftersales_comfort_first, return_stage_1, 部分 handoff 觸發前 |
| PRODUCT_CONSULT | answer_directly（當 primary 為 product/price/link） |
| GENERAL | off_topic_guard, answer_directly（smalltalk/unclear）, ask_one_question, … |

---

## 5. Tool 策略

- 每個 Scenario（或 Agent Profile）維護 **allow list**（tool name 陣列）。
- Runtime：`pickTools(scenario, brandFlags)` → 子集傳入 OpenAI。
- Executor **不變**；僅 **呼叫端** 限制 LLM 可見工具。

---

## 6. 與 Meta 留言線的關係

- `meta_page_settings` 已為 **page 級** 覆蓋；目標上可視為 **Channel Override 的 Meta 特例**。
- 一對一 AI（LINE/Messenger）與留言自動化 **可共用** Global + Brand 底層，但 **Scenario 預設** 可能不同（文件化即可，不必第一階段合併 UI）。

---

## 7. 非目標（重申）

不做多租戶帳務、不做全權限大改、不做畫布、不做多 Agent 同輪並行發話。
