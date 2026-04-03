# Phase 0 — 品牌邏輯地圖（Brand Logic Map）

說明 **品牌差異實際落在哪些檔案／資料**，以利後續「抽成 Override」時不遺漏。

---

## 1. 資料庫與設定

| 區域 | 位置 | 品牌相關？ | 說明 |
|------|------|------------|------|
| `settings` key-value | `storage.getSetting` | **多為全域** | `system_prompt` 為 **全品牌共用底稿**（體積大時會壓過品牌細節感知） |
| `brands` | `storage.getBrand` | **強** | `system_prompt`（語氣／規則）、電商憑證、`return_form_url` |
| `channels` | `brand_id` | **強** | LINE/Messenger token；決定 inbound 綁哪個品牌 |
| `knowledge_files` | `brand_id` | **強** | 知識庫僅掛品牌，無「情境子集」欄位 |
| `image_assets`（若有） | 依 brand 查 | **強** | 與 catalog 類似，屬品牌素材 |
| `meta_page_settings` | `brand_id` + `page_id` | **強（Meta 渠道）** | 留言自動回覆／導 LINE／模板等 **與一對一客服並行的一條線** |
| `orders_normalized` 等 | `brand_id` | **資料隔離** | 查單正確性依品牌索引，非「人格」 |

---

## 2. Prompt 與內容來源

| 區塊 | 函式／檔案 | 範圍 |
|------|------------|------|
| Global 政策 | `buildGlobalPolicyPrompt()` | `settings.system_prompt` |
| 品牌人格 | `buildBrandPersonaPrompt(brandId)` | `brands.system_prompt` |
| 服務時段 | `buildHumanHoursPrompt()` | **全域** schedule + assignment |
| 流程高層 | `buildFlowPrinciplesPrompt` | `return_form_url` 取自 brand；`productScope` 來自對話狀態 |
| 商品型錄 | `buildCatalogPrompt(brandId)` | SuperLanding 設定隨 brand |
| 知識庫 | `buildKnowledgePrompt(brandId)` | 該品牌 **全部** 有內容檔案拼進（有總字數上限） |
| 圖片資產 | `buildImagePrompt(brandId)` | 該品牌資產 |

**污染風險**：同一品牌一輪對話仍可能帶入 **完整 knowledge + catalog**（僅在 `order_lookup`／`order_followup` 時略做 **prompt diet** 略過部分區塊，見 `prompt-builder.ts` `planMode`）。

---

## 3. 規則與「像品牌專屬」但寫在共用程式裡的邏輯

| 區域 | 檔案 | 現象 |
|------|------|------|
| 意圖關鍵字 | `conversation-state-resolver.ts` | Regex／中文關鍵字 **全系共用** |
| 查單來源偏好 | `order-lookup-policy.ts` | 「官網／一頁」關鍵字共用 |
| 回覆計畫優先序 | `reply-plan-builder.ts` | 全系共用 |
| 內容護欄 | `content-guard.ts` 等 | 依 `ReplyPlanMode` 禁用促銷等 **共用** |
| Safe confirm／高風險 | `ai-reply.service.ts` + classifier | 模板與 Meta 設定互動；**部分路徑依 brand 取 template** |

若某品牌需要「較鬆／較緊」的關鍵字或流程，**目前沒有 DB 欄位**，只能改程式或把規則塞進 `system_prompt`（難維護）。

---

## 4. 工具（Tools）與品牌

- Tool **定義**在 `openai-tools.ts`（全系共用描述與 schema）。
- **執行**在 `tool-executor.service.ts`，已支援 `brandId` 等 context。
- **未見**依品牌或情境 **動態刪減** tool 列表（見 `CURRENT_PROMPT_TOOL_FLOW.md`）。

---

## 5. 前端：營運從哪裡改到「品牌」？

| 頁面 | 檔案 | 管理內容 |
|------|------|----------|
| 設定（全域） | `settings.tsx` | 含 `system_prompt` 等 |
| 品牌／渠道 | `brands-channels.tsx` | 品牌 CRUD、渠道 |
| 知識庫 | `knowledge.tsx` | 上傳／列表（依品牌選取） |
| 對話 | `chat.tsx` | 客服操作，**非**結構化「本輪 scenario trace」 |
| 留言中心 | `comment-center.tsx` | Meta 另一戰場 |

**易誤用點**：

- 在 **全域** `system_prompt` 寫入過長「訂單決策樹」時，與 **品牌** `system_prompt` 疊加，模型與人都難確認優先序。
- 知識檔 **無情境標籤** 時，售後與導購 FAQ 可能同時進上下文。

---

## 6. 摘要

品牌差異 **已** 有：`brands`、`channels`、`knowledge`、Meta `meta_page_settings`。  
品牌差異 **不足** 處：情境維度、tool 白名單、設定版本、per-brand feature flag、以及過度依賴 **單一 global prompt**。
