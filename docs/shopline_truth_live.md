# Shopline — Live／Staging DB 真相（非架構說明）

> 以下每一句都對應 **你打包當下** `diagnose-review-bundle-db`／`stats:order-index`／`export-review-db-masked` **讀到的那一顆** `omnichannel.db`（`getDataDir()` + `omnichannel.db`）。  
> 若人工測試的伺服器用 **另一個 `DATA_DIR` 或不同 cwd**，這包可以 **全是 0** 而線上仍有對話——那是 **兩個 DB 世界**，不是「程式沒寫 Shopline」。

## 為什麼 `shopline_configured = 0`？

診斷 SQL（與程式一致）：

```sql
SELECT COUNT(*) FROM brands
WHERE TRIM(COALESCE(shopline_api_token,'')) != ''
  AND TRIM(COALESCE(shopline_store_domain,'')) != ''
```

**= 0** 在 live 意義只有一種：**這顆 DB 裡沒有任何品牌同時具備非空 token 與非空網域**。  
常見現況：staging／本機庫從未在後台填真憑證、只填一邊、或你匯出時根本連到空庫。

**不是**「Shopline API 程式不存在」；是 **這份快照所代表的 DB 裡沒有已設定好的品牌列**。

## 為什麼 `orders_normalized` 裡 `shopline = 0`？

統計是 `COUNT(*) WHERE source = 'shopline'`。  
**= 0** 表示：**索引表裡沒有任何一筆被標成 shopline 的列**。  
通常因為 **從未成功跑過** `npm run sync:orders`（或 API 未設定／回傳 0），或 **從未有官網訂單經 API 寫回** `upsertOrderNormalized(..., 'shopline', ...)`。

## 為什麼 `items_count`、`aliases_count = 0`？

- `items_count`：`order_items_normalized` 與訂單關聯列數；沒同步明細或沒寫入 → **0**。  
- `aliases_count`：`product_aliases`；沒跑 `npm run derive:aliases`（或流程未寫入）→ **0**。  

**Live 結論**：在這顆 DB 上，**「商品＋手機本地精準索引」沒有資料支撐**；不能宣稱已站穩。

## 為什麼 masked 匯出裡 `ai_logs`、`order_lookup_cache`、`contact_active_order` 全是 0？

匯出是 **該表實際列數** 的上限切片。  
**= 0** 即：**這顆 DB 裡這些表就是空的**。可能原因（皆為觀測事實，不講理想流程）：

1. **沒有流量**寫入這些表（沒走會記 `ai_logs` 的路徑、沒查單寫 cache、沒寫 active context）。  
2. **連到錯的 DB**（與你以為的 live 伺服器不同檔）。  

要反證「同一 DB」：同一台機、同一 `DATA_DIR`、打一次查單後立刻再跑 `diagnose`／masked export，看列數是否仍為 0。

## 能宣稱「官網可查」嗎？

**在目前這包若仍為上述數字，不能。**  
必須在同一快照內同時滿足：**`shopline_configured >= 1`**、**至少一筆 `orders_normalized.source = shopline`**、以及 **可對應的真實遮罩查單紀錄**（非 DEMO 種子）。  
做不到就寫：**「此 DB 世界下 Shopline 未啟用或未成功同步。」**

## 相關指令（與伺服器同 cwd／`DATA_DIR`）

- `npm run diagnose:review-db`  
- `npm run stats:order-index`  
- `npm run emit:runtime-parity -- <verify_output 目錄>`  
- `npm run sync:orders`（有真憑證且要進索引時）
