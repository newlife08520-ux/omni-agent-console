# Shopline 成功 case（僅接受 live／staging 真實軌跡）

**禁止**用 DEMO 種子或假 JSON 充當「官網可查」證據。

若 `diagnose_review_bundle_db_live.txt` 內 `brands.shopline_configured = 0` 或 `orders_normalized` 無 `shopline` 列：

- **不要**在此目錄新增宣稱成功的 `shopline_success_case_*.json`。  
- 請在後台填入 **真實** Shopline domain + token、`npm run sync:orders` 後，再從 **遮罩後** 對話／工具 log 摘一則放入本目錄，檔名例如 `shopline_success_case_001.masked.json`。
