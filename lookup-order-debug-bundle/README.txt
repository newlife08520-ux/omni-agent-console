查單除錯包（給 Gemini / 外部檢視用）
====================================

目的：釐清「手機查單、SHOPLINE 官網 vs 一頁商店（SuperLanding）」合併與工具層行為。

含檔說明：
- openai-tools.ts — 查單 function 的 name / description / parameters
- tool-executor.service.ts — 實際執行 lookup_*、summary_only（>5 筆）、多筆回傳
- order-service.ts — unifiedLookupByPhoneGlobal / Shopline+一頁 合併、data_coverage
- order-lookup-policy.ts — deriveOrderLookupIntent、summaryOnly 意圖、官網/一頁關鍵字
- tool-llm-sanitize.ts — 給 LLM 前的 JSON 清洗、summary_only 語氣小抄
- order-feature-flags.ts — CONSERVATIVE_SINGLE_ORDER 等旗標
- ai-reply.service.ts — orderLookupSummaryOnly、工具 context 組裝（檔案大，僅供對照）
- GREP_RESULTS.txt — 關鍵字 grep 彙整（多筆/summary/local_only 等）

編碼：UTF-8。請用支援 UTF-8 的編輯器開啟 .ts。

近期行為變更（供對照）：
- lookup_order_by_phone：orderLookupSummaryOnly 且訂單「超過 5 筆」才走 summary_only；
  5 筆以內回傳完整 orders 供 AI 列出。

打包日期：見檔案系統修改時間。
