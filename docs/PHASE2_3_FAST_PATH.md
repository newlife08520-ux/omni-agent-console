# Phase 2.3：Pre-LLM Fast Path

## 觸發時機（`tryOrderFastPath`）

- 在 `buildReplyPlan` 之後、awkward／handoff 之前執行（避免純查單被誤判轉人工）。
- 略過：`handoff`、`return_form_first`、對話為退貨流程（`planMode` 含 `return`）。
- `off_topic_guard` 下僅在「整句幾乎只有手機或單號」時才走 fast path。

## 類型與日誌

| fast_path_type | 說明 |
|----------------|------|
| `order_id` | 純訂單編號查詢 |
| `phone` | 純手機（合併來源） |
| `shopline_phone` | 官網關鍵字 + 手機 |
| `superlanding_phone` | 一頁／團購關鍵字 + 手機 |
| `ask_for_identifier` | 「我要查訂單」等缺資訊模板 |

Console：`[order_fast_path_hit=true] fast_path_type=... used_llm=0`

`ai_logs`：`reply_source=order_fast_path`、`used_llm=0`、`tools_called` 含 `order_fast_path`。

## 檔案

- `server/order-fast-path.ts`
- `server/routes.ts`（接入 `autoReplyWithAI` 主流程）
