# Phase 30 Runtime 證據（待補）

部署或測試環境可依下列項目留下紀錄：

1. **一頁 page+phone 多視窗**：日誌出現 `[一頁商店] page_id=… N天窗口: 掃 … 筆，累計不重複匹配 M`，M 應隨視窗累加。
2. **data_coverage**：工具回傳或日誌中可見 `data_coverage: "local_only"` / `api_only` / `merged_local_api`；單筆且 local_only 時回覆含「僅從已同步資料」「還有其他訂單嗎」。
3. **前端**：左側聯絡人區顯示「即時」或「輪詢」；SSE 失敗時頂部橫幅＋「輪詢」狀態。
4. **verify:phase30**：`npm run verify:phase30` 通過（含 phase29 與 phase30-verify）。

---

靜態與行為檢查已於 `phase30-verify.ts` 實作；完整煙霧測試請依《PHASE30_FINAL_SMOKE_AND_SIGNOFF》手動執行。
