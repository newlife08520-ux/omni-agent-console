---
產出時間: 2026-04-14（Asia/Taipei）
Phase 版本: Phase 106 交接包
檔案用途: 專案與業務總覽、技術棧、部署與客人訊息主流程
---

# 01 — 系統總覽

## 專案是什麼

**Omni-Agent Console（自動客服中控台）**：整合 LINE 官方帳號（與 Messenger 等）與 AI 對話，讓客人在聊天視窗內完成諮詢、查單、售後引導；後台可檢視對話、人工接手、品牌與渠道設定。

## 業務場景

- 多品牌客服：後台以 **brand** 區隔 system_prompt、知識庫、商品目錄、渠道與訂單索引。
- **查訂單**：一頁商店（SuperLanding）與 Shopline 雙來源，統一走 order-service 與工具層。
- **知識庫（RAG-Lite）**：`knowledge_files` 依品牌載入，prompt-builder 依使用者訊息挑選片段。
- **閒置結案**：客戶最後一則為 user 且超過設定小時未回，可走結案文案與（符合條件時）評價邀請。

## 兩個品牌（範例）

- **brand_id=1**：AQUILA 天鷹座（主品牌 LINE 入口之一）
- **brand_id=2**：私藏生活（同一套商品／服務、不同 LINE 機器人；`channels.bot_id` 對應不同 destination）

實際名稱以 DB `brands` 為準。

## 訂單來源

- **SuperLanding（一頁）**：`brands.superlanding_*`；同步入 `orders_normalized`（source=superlanding）。
- **Shopline**：`shopline_store_domain` + `shopline_api_token`；同步入 `orders_normalized`（source=shopline）。

## 技術棧

- **API**：Express（專案為 Express 5 相容設定）
- **前端**：React 18 + Vite
- **資料庫**：SQLite（better-sqlite3），路徑受 `DATA_DIR` 控制（production 常掛 `/data`）
- **佇列**：Redis + BullMQ
- **主對話模型**：Google Gemini（`settings.gemini_api_key`）；可保留 OpenAI 等後備路徑

## 部署架構（Railway 兩個 Service）

| Service | 指令 | 角色 |
|---------|------|------|
| **web** | `npm start` | HTTP、Webhook、靜態前端 |
| **worker** | `npm run start:worker` | 消費 ai-reply 佇列、呼叫 `POST /internal/run-ai-reply` |

共用 **`REDIS_URL`**、**`INTERNAL_API_SECRET`**；Worker 的 **`INTERNAL_API_URL`** 須為 web 的**公開 URL**。

## 主要 User Flow（客人傳訊到 AI 回覆）

1. LINE 呼叫 `POST /api/webhook/line`：驗簽、destination 對 `channels.bot_id`、寫入 `messages`（user）。
2. 若 `is_ai_enabled=1` 且非測試模式：`enqueueDebouncedAiReply`（約 4 秒 debounce）。
3. Worker 合併文字後呼叫 `POST /internal/run-ai-reply` → `autoReplyWithAI`。
4. Gemini（與工具）產生回覆 → `pushLineMessage` → 客人收到；寫入 `messages`（ai）、`ai_logs`。

若 Worker 不可用，web 可能內聯 `autoReplyWithAI`；若 **`gemini_api_key` 為空**，開頭即 return，可能**靜默不回**。

## 相關檔案

- `07-webhook-and-queue.md`、`05a`–`05d`、`05-core-services.md`
