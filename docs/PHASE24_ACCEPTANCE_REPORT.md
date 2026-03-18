# Phase 2.4 驗收摘要

## 自動驗證

| 指令 | 結果 |
|------|------|
| `npm run check:server` | 應通過 |
| `npm run verify:hardening` | 應通過（含 COD 等） |
| `npm run verify:phase24` | 10 項 phase24 + 上述 |
| `npm run stats:order-index` | 含 `order_created_at_missing_count` / min / max |

## 建議人工 12 題（封板前）

1. 單號查單  
2. 混合句內單號（例：可以幫我查 AQX13705 嗎）  
3. 官網手機多筆 → 只看成功／只看失敗／只看貨到付款  
4. 多筆 → 第一筆／第二筆（確認排序為新→舊）  
5. 多筆 → 最新那筆／最早那筆  
6. 多筆 → 日期（例：2026-03-03 那筆）  
7. 多筆 → 只看官網／只看一頁（單筆時應直接帶明細）  
8. 商品名＋手機（官網／一頁）  
9. 帶出單後追問：出貨、地址、門市、物流（應 deterministic）  
10. COD 不應再說「付款失敗要重下單」  
11. 語氣：少套話、無禁用句型  
12. 首句是否夠快（fast path 命中時不進第一輪 LLM）

**通過標準**：與 `PHASE24_FINAL_MANUAL_TEST_CHECKLIST.md` 一致——關鍵為來源不混、多筆選擇正確、COD 不誤判。
