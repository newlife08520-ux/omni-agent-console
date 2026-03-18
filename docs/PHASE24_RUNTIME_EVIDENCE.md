# Phase 2.4 Runtime 證據（日誌關鍵字）

於正式環境對話時，後端 console 可對照下列關鍵字確認路徑：

| 情境 | 日誌關鍵字 |
|------|------------|
| 查單 fast path（純單號／手機等） | `[order_fast_path_hit=true] fast_path_type=...` |
| 混合句單號 | `fast_path_type=order_id_mixed` |
| 追問 fast path | `[order_followup_fast_path_hit=true] followup_intent=followup_reply` |
| 多筆選定後帶明細 | `[multi_order_resolve] order=... source_hit=lookup` |
| 本地商品+手機命中 | `[order_lookup] product_phone local_hit n=...` |
| 圖片查單 | 應見 `allowCrossBrand false` 路徑（見 verify） |

**order_created_at**：`stats:order-index` 會印 `order_created_at_missing_count` 與 min/max；新 upsert 會持續補齊。

**first_visible_reply_ms**：若需精確延遲指標，建議在 webhook 入口與送出訊息處加 timestamp 差（本輪以 fast path 日誌為主）。
