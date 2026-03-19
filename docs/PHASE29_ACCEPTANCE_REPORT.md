# Phase 2.9 驗收摘要

- **verify:phase29**：`check:server` + hardening + phase24～27 + **phase29-verify**（靜態）+ `stats:order-index`。
- **Tony 手機多筆**：依賴一頁 API 多視窗合併；請以實機手機在測試環境複驗。
- **「還有其他訂單嗎」**：單筆 active context + 關鍵字觸發展開；驗收時先查單筆再送該句。
- **官網查無**：客戶明講官網時工具走 shopline-only，查無不回一頁商店單。
- **聯絡人列表**：首屏 ≤80，「載入更多」每次 +80 至 480。
- **ZIP**：執行 `scripts/pack-ai-analysis-bundle.ps1` 或自訂 robocopy + `export-ai-bundle-context.mjs`。
