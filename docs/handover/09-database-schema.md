---
產出時間: 2026-04-14（Asia/Taipei）
Phase 版本: Phase 106 交接包
檔案用途: 資料庫 schema 索引；完整 DDL 與型別見 09a／09b
---

# 09 — 資料庫 Schema

## 完整原始碼位置

- **09a-database-db.ts.md**：`server/db.ts`（CREATE TABLE、migration、部分 seed）
- **09b-database-schema.ts.md**：`shared/schema.ts`（介面與型別）

## 重要表（用途一句話）

- **users**：後台帳號與角色。
- **brands**：品牌、system_prompt、一頁／Shopline 憑證、return_form_url。
- **channels**：LINE／Messenger、bot_id、access_token、channel_secret、is_ai_enabled。
- **contacts**：對話、brand_id、channel_id、status、needs_human、指派欄位等。
- **messages**：對話內容與 sender_type。
- **ai_logs**：每輪 AI 工具與摘要。
- **settings**：鍵值設定；含 gemini_api_key、test_mode 等（**無 updated_at 欄位**）。
- **orders_normalized** / **order_items_normalized**：訂單與明細索引。
- **product_catalog**、**knowledge_files**：商品與知識庫。
- **ai_reply_deliveries**：Worker 冪等送達。
- **system_alerts**：告警與 blocked 紀錄。

細部欄位以 09a 內 SQL 為準。
