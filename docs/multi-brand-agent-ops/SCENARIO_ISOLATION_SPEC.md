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
