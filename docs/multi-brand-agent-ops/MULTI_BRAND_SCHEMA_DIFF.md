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
