# Brand Override 繼承鏈規格

**目標順序**：`Global Default` → `Brand` → `Channel` → `Scenario`。

---

## 1. 各層責任

| 層級 | 內容範例 | 來源（建議） |
|------|-----------|----------------|
| Global | 安全、不捏造、個資、危機應對基線 | `settings` 或專用 `global_agent_defaults`（精簡後） |
| Brand | 稱呼、emoji 政策、品牌禁忌、預設表單連結 | `brands` + `content_json.brand_defaults` |
| Channel | LINE vs Messenger 字數、是否允許貼連結、Meta 與一對一差異 | `content_json.channel_overrides[line|messenger]` |
| Scenario | 查單鐵律、售後安撫、導購話術邊界 | `content_json.prompt_fragments[SCENARIO]` |

---

## 2. Merge 演算法（規範）

1. 以 **key-value** 或 **有序區塊** 合併：`scenario` 區塊永遠最後 append。
2. **同標題區塊**（如 `--- 訂單 ---`）：沿用現有 `normalizeSections` **去重**邏輯；但目標是 **減少重複來源**，而非依賴去重修補。
3. **Tool / Knowledge**：非文字 merge，由 `tool_policy` / `knowledge_policy` **直接計算**，不經字串拼接。

---

## 3. 與 `meta_page_settings`

- **語意上**：Meta 的 `line_general` / `auto_reply_enabled` 等 = **Channel（page）級** 覆蓋。
- **實作上**：Phase 1 可不把它們物理搬進 `content_json`；在文件中約定 **解析優先序**：  
  `Meta page settings`（若當前請求為 Meta 留言）**或** `channel_overrides.messenger`（一對一）。

---

## 4. 衝突解決

- **明文規則優於 LLM**：硬路由與 `ReplyPlanMode` 仍可在 Scenario 內保留子狀態。
- **同層多條規則**：後寫入覆蓋前（版本時間戳）；Publish 時凍結快照。

---

## 5. 非目標

- 不做任意 DAG 繼承（A 繼承 B 再繼承 C）。
- 10 品牌不需要模板市場或多層 org。
