# Phase 2.9 Runtime 證據（待補）

請在部署環境記錄：

1. **查單**：`[一頁商店] …窗口掃描完成，累計不重複 N`（日誌應 N≥實際筆數）。
2. **phase29 展開**：`reply_renderer=phase29_more_orders_expand`、`tools_called` 含 `phase29_expand_phone`。
3. **官網查無**：工具 JSON `message` 含「官網（SHOPLINE）…查無」。
4. **前端**：Network 首包 `/api/contacts?limit=80`（或載入更多後 160…）。
5. **SSE**：設 `VITE_DISABLE_SSE=1` 後不應出現 EventSource 連線。

---

靜態驗證已於 `npm run verify:phase29` 之 `phase29-verify.ts` 通過。
