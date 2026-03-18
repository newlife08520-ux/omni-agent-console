# 人工總驗收清單（Phase 2.3 起）

- [ ] **官網 + 手機**：僅出現 Shopline 訂單，不會被一頁商店 local／cache 蓋掉。
- [ ] **一頁 + 手機**：僅 SuperLanding。
- [ ] **純手機**：同品牌 SL + 官網皆有時，列表合併並標示來源（簡表含 `[官網]`/`[一頁]`）。
- [ ] **純單號**：Fast path 可直出明細，`ai_logs.used_llm=0`、`reply_source=order_fast_path`。
- [ ] **多筆追問**：「只看成功／失敗／待付款／貨到付款／第二筆／全部訂單」可 deterministic 回覆。
- [ ] **同步後**：`npm run stats:order-index` 顯示 `items_count` 成長；`derive:aliases` 後本地商品+手機能命中。
- [ ] **無憑證環境**：至少 `npm run verify:phase23`（含 `check:server`、`verify:hardening`、`stats:order-index`）通過。
- [ ] **Gap Fix（官網商品+手機）**：同手機多商品僅回符合關鍵字之單；不符則查無（見 `PHASE2_3_FINAL_GAP_FIX_REPORT.md`）。
- [ ] **Gap Fix（圖片查單）**：不跨品牌；門市／地址與主查單一致。
- [ ] **Gap Fix（本地商品+手機多筆）**：`deterministic_skip_llm`，第二輪不自由組文。
- [ ] **第 N 筆追問**：在顯示多筆簡表後，說「第一筆／第二筆／第 3 筆」可得到對應單號（deterministic）。
