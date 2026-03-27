# 官網（SHOPLINE）手機查單 — DEMO 遮罩 runtime 證據

> **類型**：`REVIEW_BUNDLE_DEMO` — 與 `npm run seed:review-bundle-shopline-demo` 產生之索引列對齊，**非**真實 Shopline API 成功回應。  
> **用途**：證明工具／deterministic 合約在 `source=shopline` 時的欄位形狀；**不可**單憑本檔宣稱生產環境「官網可查」。

## 模擬：`lookup_order_by_phone` 成功（多筆節錄為單筆示意）

```json
{
  "success": true,
  "found": true,
  "total": 1,
  "source": "shopline",
  "orders": [
    {
      "order_id": "BUN***01",
      "status": "已完成",
      "amount": 99,
      "buyer_phone": "09********",
      "source": "shopline"
    }
  ],
  "lookup_diagnostic": {
    "preferred_source": "shopline",
    "shopline_config_present": true,
    "normalized_phone": "900000000",
    "note": "DEMO_TOKEN — live API 不會成功"
  }
}
```

## 真實「可查」時 bundle 應另含

1. `diagnose_review_bundle_db.txt` 內 `brands.shopline_configured >= 1` 且 token **非** `__REVIEW_BUNDLE_DEMO_*`。
2. `orders_normalized` 遮罩 export 內至少一筆 `source: "shopline"`，且 `global_order_id` **非** `BUNDLE_DEMO_SL_001`（或同時附真實對話 sanitized case）。
