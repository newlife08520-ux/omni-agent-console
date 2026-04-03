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
