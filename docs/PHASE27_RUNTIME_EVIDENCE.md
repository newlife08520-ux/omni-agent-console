# Phase 2.7 Runtime Evidence

## verify:phase27

```bash
npm run verify:phase27
```

含：`check:server` → `verify:hardening` → phase24 → phase25 → phase26 → **phase27**（12 OK）→ `stats:order-index`。

## ai_log 新欄位範例查詢（SQLite）

```sql
SELECT id, reply_source, used_llm, used_first_llm, used_second_llm,
       reply_renderer, prompt_profile, queue_wait_ms,
       first_customer_visible_reply_ms, lookup_ack_sent_ms
FROM ai_logs
ORDER BY id DESC LIMIT 5;
```

（舊列在新 migration 前寫入者，新欄位可能為 0 / NULL。）

## stats:latency 範例

```bash
echo "[phase26_latency] lookup_ack_sent_ms=100 contact=1
[phase26_latency] first_customer_visible_reply_ms=150 final_reply_sent_ms=500 second_llm_skipped=false final_renderer=llm prompt_profile=order_lookup_ultra_lite
[phase26_latency] queue_wait_ms=30 contact=1" | npm run stats:latency
```

應見 `lookup_ack_sent_ms`、`final_reply_sent_ms`、`queue_wait_ms` 之 p50/p95/max 摘要。

## ZIP

建議本機打包（排除 `node_modules`、`.git`、`dist`、`*.db`）：

`Compress-Archive` 或 `7z` 對專案根目錄；亦可使用精簡包範例路徑 `d:\Omni-Agent-Console-Phase27.zip`（僅含 server/shared/docs 等子目錄時體積較小，完整 source 請自行全目錄打包）。
