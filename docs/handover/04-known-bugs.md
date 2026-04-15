---
產出時間: 2026-04-14（Asia/Taipei）
Phase 版本: Phase 106 交接包
檔案用途: 已知 Bug 清單（現象、根因方向、修復方向）
---

# 04 — 已知 Bug

## BUG-1：CoT 洩漏（待修）

- **現象**：客人偶爾看到模型內部推理、標籤或未應對外揭露的結構化片段。
- **根因方向**：提示詞／後處理未完全攔截「思考過程」；少數路徑繞過 output guard。
- **修復方向**：強化 `phase2-output`／guard pipeline；禁止特定前綴輸出；回歸測試含 CoT 釣魚句。

## BUG-2：純單號沒查單（待修）

- **現象**：使用者只丟訂單編號時，未穩定觸發 `lookup_order_by_id` 或誤判為閒聊。
- **根因方向**：意圖路由／plan mode 與關鍵字閘道對「純單號」辨識不足。
- **修復方向**：訊息前處理偵測單號格式即強制查單路徑；與 `looksLikeOrderNumber` 等既有工具對齊。

## BUG-5：圖+文罐頭（待修）

- **現象**：圖片與文字同輪時，回覆變成固定罐頭而非依圖文綜合回答。
- **根因方向**：vision 與文字合併策略或 debounce 合併後遺失上下文。
- **修復方向**：檢查 `handleImageVisionFirst` 與後續文字輪次的 state；必要時同輪合併進單一 LLM 請求。

## BUG-6：`goal_locked` 不釋放（待修）

- **現象**：對話目標鎖定後，客人已換話題仍被舊目標綁死。
- **根因方向**：`customer_goal_locked`／相關欄位釋放條件過窄或漏網。
- **修復方向**：盤點釋放點（新 intent、明確取消、時間衰減）；與 prompt-builder 的鎖定提示一致化。

## BUG-7：週末 idle close 沒順延（診斷中）

- **現象**：例：週六仍發閒置結案訊息，與 Phase 106.15 預期不符。
- **根因方向（可能）**：
  - 環境變數 **`BUSINESS_WORK_DAYS`** 若含週六 (6)，週六會被當營業日，`findNextBusinessMoment` 可能不再順延。
  - 國定假日檔不含「每週六」—週末依賴 `workDays`，非 `holidays.json`。
- **修復方向**：核對 production `GET /api/admin/business-hours-status` 的 `businessHours.workDays`；與老闆確認「週末是否一律不結案」產品規則後再改邏輯或環境設定。

## 營運相關（非單一編號但常與「不回」混淆）

- **`gemini_api_key` 為空**：`autoReplyWithAI` 開頭即 return，**無 log、無推播**（P0 診斷重點）。
- **Worker 未部署**：僅 web 時，設計上會依 heartbeat 走內聯；若同時 Redis/job 異常需看 `ai_reply_deliveries` 與 Worker log。
- **LINE Channel Access Token 過期**：推播 401，可能 DB 有 ai 訊息但客人收不到（需打 LINE `GET /v2/bot/info` 驗證）。
