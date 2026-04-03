# 合併來源：`MULTI_BRAND_SCHEMA_DIFF.md` + `MULTI_BRAND_DATA_MODEL.md` + `BRAND_OVERRIDE_INHERITANCE.md` + `VERSIONING_AND_ROLLBACK_SPEC.md`（全文）

---

# 第一部分：`MULTI_BRAND_SCHEMA_DIFF.md`

# Phase 1 — Schema Diff（建議）

**原則**：表數最少、能承載 **Brand / Agent Profile / Scenario / Bindings / Version**。SQLite 友善；避免多租戶過度正規化。

---

## 1. 建議新增表

### 1.1 `agent_config_versions`

| 欄位 | 型別 | 說明 |
|------|------|------|
| id | INTEGER PK | |
| brand_id | INTEGER FK brands | |
| agent_profile_key | TEXT | 如 `default`、`after_sales`（先可固定 enum 字串） |
| status | TEXT | `draft` \| `published` \| `archived` |
| content_json | TEXT | 見 `MULTI_BRAND_DATA_MODEL.md` |
| created_at / updated_at | TEXT | |
| published_at | TEXT NULL | |
| published_by_user_id | INTEGER NULL | |
| parent_version_id | INTEGER NULL | rollback 指標或歷史鏈 |

**索引**：`(brand_id, agent_profile_key, status)`、`(brand_id, published_at DESC)`。

### 1.2 `agent_config_publish_log`（可選，精簡版可省略）

| 欄位 | 說明 |
|------|------|
| id, brand_id, from_version_id, to_version_id, actor_id, action, created_at |

用於稽核；若嫌多表，可只存 `agent_config_versions` 多列 + status。

---

## 2. 建議擴充既有表（擇一或組合）

| 表 | 欄位 | 用途 |
|----|------|------|
| `brands` | `active_agent_ops INTEGER DEFAULT 0` | 是否走新解析鏈 |
| `brands` | `published_agent_config_id INTEGER NULL` | 快取目前 published 版本 id |
| `knowledge_files` | `scenario_tags TEXT NULL` | JSON array，如 `["PRODUCT_CONSULT","GENERAL"]`；**可 Phase 1.5** |

**Channel**：可先 **不重複建表**，在 `content_json` 的 `channel_overrides` 內以 `line` / `messenger` 為 key；日後再正規化。

---

## 3. 不需為了 10 品牌而建的表

- 租戶帳單、組織 org、細粒度 RBAC 資源表。
- 完整 workflow / 畫布節點表。

---

## 4. 與現有 Meta 表

- **不合併** `meta_page_settings` 到上表於 Phase 1；僅在 `MULTI_BRAND_DATA_MODEL` 註明「Meta 以 page 為 override」。
- Phase 2+ 可選：page_id → 對應 `channel_overrides.meta_page_id:*` 的 convention。

---

## 5. Migration 注意

- 使用既有 `db.ts` migration 風格：`CREATE TABLE IF NOT EXISTS` + `PRAGMA table_info` 補欄位。
- **不回填刪除** `brands.system_prompt`；backfill 腳本另述（`MIGRATION_AND_ROLLOUT_PLAN.md`）。

---

# 第二部分：`MULTI_BRAND_DATA_MODEL.md`

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

---

# 第三部分：`BRAND_OVERRIDE_INHERITANCE.md`

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

---

# 第四部分：`VERSIONING_AND_ROLLBACK_SPEC.md`

# Versioning — Draft / Publish / Rollback

---

## 1. 狀態機

```
draft ──publish──► published ──archive──► archived
   ▲                    │
   └──── clone/edit ────┘ (optional)
```

- **同一 `(brand_id, agent_profile_key)` 同時僅一筆 `published`**（建議 UNIQUE 索引或應用層保證）。
- **draft** 可多筆時：需 UI 標示「當前編輯中草稿」；簡化版可 **只允許 1 draft**。

---

## 2. 欄位

| 欄位 | 說明 |
|------|------|
| `status` | draft / published / archived |
| `published_at` | 發布時間 |
| `published_by_user_id` | 誰發布 |
| `parent_version_id` | 從哪版複製（選填） |

**Rollback**：

- **軟回滾**：將指定歷史版本 **複製為新 draft** → 審核 → publish（推薦，有稽核軌跡）。
- **硬回滾**：把舊版 `content_json` 設為 published 並將現 published 設 archived（需 super_admin + 二次確認）。

---

## 3. API 行為（建議）

| 端點 | 說明 |
|------|------|
| `GET .../agent-config?brand_id=&profile=` | 回傳當前 **published** + 可選 **draft** |
| `PUT .../agent-config/draft` | 儲存草稿 |
| `POST .../agent-config/publish` | draft → published；寫 `publish_log` |
| `GET .../agent-config/history` | 列表（最近 N 版） |

---

## 4. 執行時讀取

- Runtime **只讀 published**（快取於程序內 memory，TTL 30–60s 或事件失效）。
- 避免每則訊息打 DB：可 `brands.published_agent_config_id` 指向當前版本。

---

## 5. 與舊設定的關係

- `use_agent_ops_v2=0`：**忽略** version 表，沿用 `brands.system_prompt`。
- 首次 publish：**不刪** 舊欄位；僅在 UI 顯示「已遷移至 Agent Ops」。

---

## 6. 風險

- 營運以為改了 draft 已上線 → UI 必須清楚區分 **Draft / Live**。
- 同時多人編輯 → 簡化版 **最後寫入贏** + 顯示 `updated_at`。
