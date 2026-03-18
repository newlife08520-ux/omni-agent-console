# Phase 2.3 驗收報告（自主強化／查單）

**報告日期**：2026-03-16（含 Final Gap Fix）  
**交付型態**：原始碼 ZIP + 本報告 + **`docs/PHASE2_3_FINAL_GAP_FIX_REPORT.md`**

### Gap Fix 補強（本輪）
- Shopline **商品+手機** 二次過濾；圖片查單 **禁 cross-brand** + 統一 `formatOrderOnePage`／`buildActiveOrderContextFromOrder`；**本地商品+手機多筆** deterministic skip LLM；**verify:hardening** 擴充 10+ 檢查。詳見 **`PHASE2_3_FINAL_GAP_FIX_REPORT.md`**。

---

## 一、交付摘要

| 項目 | 說明 |
|------|------|
| **ZIP 檔名** | `Omni-Agent-Console-PHASE23-LATEST.zip` |
| **ZIP 路徑** | 與專案資料夾同層：`d:\Omni-Agent-Console(自動客服系統)\Omni-Agent-Console-PHASE23-LATEST.zip`（約 70MB） |
| **ZIP 內容** | 完整原始碼（`server/`、`client/`、`shared/`、`docs/`、`script/` 等） |
| **ZIP 排除** | `node_modules`、`.git`、`dist`、`uploads`、`data*`、`.env`、`*.db`、`.local`、`.replit` |
| **不含** | 正式資料庫、上傳檔、環境變數檔（需自行 `npm install`、建 `.env`） |

---

## 二、本輪實作與驗收對照

| 需求面向 | 實作要點 | 驗收方式 |
|----------|----------|----------|
| **Source-aware 查單** | `phone:` / `order_id:` cache 帶 `any|shopline|superlanding`；`getOrdersByPhone`／`getOrderByOrderId` 支援 source 篩選 | 官網+手機僅 Shopline；一頁+手機僅 SL；純手機合併雙來源 |
| **Generic 手機合併** | `unifiedLookupByPhoneGlobal` 未指定來源時本地合併 + API 雙查去重 | 簡表含 `[官網]`／`[一頁]` 標籤 |
| **order_items + upsert** | `upsertOrderNormalized` 寫入 `order_items_normalized`、`product_name_normalized` | 同步後 `stats:order-index` 之 `items_count` 上升 |
| **商品別名** | `derive-product-aliases.ts`、`lookupOrdersByProductAliasAndPhoneLocal` | 跑 `derive:aliases` 後本地商品+手機可查 |
| **Shopline 明細** | `mapShoplineOrder` 支援 `subtotal_items`、`paid_at`／`prepaid` | 同步 Shopline 訂單後明細完整 |
| **Fast Path** | `order-fast-path.ts`、webhook 前段；`order_fast_path_hit` log | 純單號／純手機等：`used_llm=0`、`reply_source=order_fast_path` |
| **多筆追問** | 只看成功／失敗／待付／貨到付／全部訂單／第 N 筆 | deterministic、`multi_order_router` |
| **自主驗證** | `server/autonomous-hardening-verify.ts` | `npm run verify:hardening` |

---

## 三、自動驗證執行指令與預期

建議於解壓後專案根目錄執行：

```bash
npm install
npm run verify:phase23
```

| 指令 | 預期 |
|------|------|
| `npm run check:server` | TypeScript 編譯通過 |
| `npm run verify:hardening` | 終端顯示 `[autonomous-hardening-verify] OK — 10 checks + ... + shopline filter + stats + image + format` |
| `npm run stats:order-index` | 輸出 JSON（`orders_count`、`items_count`、`by_source` 等） |

**說明**：新環境若尚未用新版邏輯同步訂單，`items_count` 可能為 0；屬預期，需執行 `npm run sync:orders`（需 API 憑證）後再驗。

---

## 四、文件索引

| 文件 | 用途 |
|------|------|
| `docs/PHASE2_3_SOURCE_AWARE_AND_MERGE.md` | Source-aware 與合併設計 |
| `docs/PHASE2_3_FAST_PATH.md` | Fast Path 行為 |
| `docs/PHASE2_3_LOCAL_ITEMS_ALIASES.md` | 明細表與別名 |
| `docs/PHASE2_3_VERIFY_AND_SIGNOFF.md` | 自驗指令與證據範例 |
| `docs/FINAL_MANUAL_SIGNOFF_CHECKLIST.md` | **人工總驗收勾選清單** |
| `docs/PHASE2_3_FINAL_GAP_FIX_REPORT.md` | Gap 修復與人工 8 題建議 |

---

## 五、已知限制／後續建議

1. **ZIP 不含資料庫**：上線或還原需自行 migration／同步。  
2. **端到端查單**：需設定 SuperLanding／Shopline 憑證後以實際對話驗證。  
3. **items_count**：歷史 `orders_normalized` 若未經新版 upsert，明細列為 0；建議排程或手動 `sync:orders`。

---

## 六、驗收結論（自動項）

- [x] 原始碼可編譯（`check:server`）  
- [x] 自主硬體驗證腳本通過（`verify:hardening`）  
- [x] 訂單索引統計可執行（`stats:order-index`）  
- [x] 交付 ZIP 已產出（見第一節路徑）  

**人工總驗收**請依 `docs/FINAL_MANUAL_SIGNOFF_CHECKLIST.md` 於正式環境勾選完成。

---

*本報告與 ZIP 對應之程式版本以打包當下工作區為準。*
