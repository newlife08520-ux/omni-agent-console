# Phase 1 — 資料模型（content_json 草案）

**儲存位置**：`agent_config_versions.content_json`（JSON 字串）。以下為 **建議欄位**，實作可縮減。

---

## 1. 頂層結構

```json
{
  "schema_version": 1,
  "brand_defaults": {
    "tone_notes": "",
    "locale": "zh-TW"
  },
  "scenarios": {
    "ORDER_LOOKUP": { },
    "AFTER_SALES": { },
    "PRODUCT_CONSULT": { },
    "GENERAL": { }
  },
  "channel_overrides": {
    "line": { },
    "messenger": { }
  },
  "tool_policy": {
    "by_scenario": {
      "ORDER_LOOKUP": ["lookup_order_by_id", "lookup_order_by_product_and_phone", "transfer_to_human"],
      "AFTER_SALES": ["transfer_to_human"],
      "PRODUCT_CONSULT": ["send_image_to_customer", "transfer_to_human"],
      "GENERAL": ["transfer_to_human"]
    }
  },
  "knowledge_policy": {
    "by_scenario": {
      "ORDER_LOOKUP": { "mode": "none" },
      "PRODUCT_CONSULT": { "mode": "all_brand_files" },
      "GENERAL": { "mode": "tagged", "tags": ["GENERAL"] }
    }
  },
  "prompt_fragments": {
    "ORDER_LOOKUP": "…",
    "AFTER_SALES": "…",
    "PRODUCT_CONSULT": "…",
    "GENERAL": "…"
  }
}
```

**說明**：

- `prompt_fragments`：**只放**該情境增量，不再複製整份 global SOP。
- `tool_policy.by_scenario`：**allow list**（名稱與 `openai-tools.ts` function name 一致）。
- `knowledge_policy`：先支援 `none` / `all_brand_files` / `tagged`；tagged 需 `knowledge_files.scenario_tags` 或檔名慣例（待 Phase 1 末定）。

---

## 2. Agent Profile

內部 10 品牌 **第一版** 建議：

- 每品牌 **1 個 profile**：`agent_profile_key = "default"`。
- `content_json` 內含四情境即可。

若日後要 **After-sales Agent**：

- 新增同一 `brand_id` 下另一組 `agent_config_versions`（`agent_profile_key = "after_sales"`），由 **渠道或規則**選用（Phase 2+）。

---

## 3. 與舊欄位對照

| 舊 | 新 |
|----|-----|
| `settings.system_prompt` | 漸進遷入 `global` 解析層（可另表 `global_agent_defaults` 或保留 settings key） |
| `brands.system_prompt` | `brand_defaults.tone_notes` + 或 published 版本內文 |
| 無 | `scenarios.*` 與 `tool_policy` |

---

## 4. 驗證

- 發布前 JSON schema 驗證（zod／手寫）避免錯 tool 名稱。
- **預設**：若 `tool_policy` 缺失，fallback **現行行為**（全集 tools）— 由 feature flag 控制是否允許。
