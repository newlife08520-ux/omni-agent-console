# Phase 30 驗收摘要

- **verify:phase30**：在 `verify:phase29` 基礎上再跑 `phase30-verify.ts`（靜態＋行為）。
- **視窗合併**：`lookupOrdersByPageAndPhone`、`lookupOrdersByPhone` 皆為多視窗合併後去重，無首窗早退。
- **data_coverage**：local 回傳為 `local_only`，API 為 `api_only` 或 `merged_local_api`；單筆＋local_only 時回覆帶「僅已同步資料」說明（可關閉：`CONSERVATIVE_SINGLE_ORDER=false`）。
- **前端**：聯絡人列上方顯示「即時」/「輪詢」；SSE 失敗時橫幅＋狀態可辨識。
- **ZIP**：執行 `scripts/pack-ai-analysis-bundle.ps1` 產出最新 SOURCE 與 AI-BUNDLE-CONTEXT。

## 與煙霧清單對照（PHASE30_FINAL_SMOKE_AND_SIGNOFF）

- A. 查單正確性：視窗合併與 data_coverage 支援「同手機多筆都看到」與「資料不全不單筆定案」。
- B. 切單能力：P29 CLEAR 關鍵字與多筆摘要已支援。
- C. 付款/出貨：沿用既有 COD/成功/失敗邏輯與追問。
- D. 速度與頁面：P29 聯絡人 80＋載入更多、SSE 節流與可觀測；P30 補「即時/輪詢」狀態。
- E. 體感：conservative 單筆說明與 ORDER_LOOKUP_RULES 收緊，減少「很快但亂答」。
