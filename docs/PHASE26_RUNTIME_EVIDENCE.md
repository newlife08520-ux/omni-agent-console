# Phase 2.6 Runtime / Verify 證據

## 指令

```bash
npm run verify:phase26
```

## 2026-03-15 本機執行結果（摘要）

- `check:server`：通過  
- `verify:hardening`：OK — 10 checks + …  
- `phase24-verify`：10 項通過  
- `phase25-verify`：9 項通過  
- `phase26-verify`：9 項通過  
- `stats:order-index`：JSON 統計輸出正常  

### phase26-verify 細項

1. generic deterministic：多 tool 以最後為準  
2. 五種 order tool generic 選出 reply  
3. 單筆 deterministic packer  
4. final normalizer 去套話且保留訂單資訊  
5. ultra-lite prompt  
6. order_followup_ultra_lite  
7. routes latency / normalizer / ai_log 關鍵字  
8. prompt-builder ultra + getBrandReplyMeta  
9. customer-reply-normalizer 模組存在  

### Latency 輔助腳本

```bash
npm run stats:latency-help
```

輸出為欄位說明（實際延遲需從 production log grep `[phase26_latency]`）。

### stats:latency-help 範例輸出

```
[query-latency-stats] Phase 26 延遲欄位說明：
  lookup_ack_sent_ms        查單 ack「我幫您查詢中」送出相對回合起點
  first_customer_visible_reply_ms  客戶第一則可見 AI（ack 或最終回覆）
  final_reply_sent_ms       最終對客文字送出
  second_llm_skipped        是否跳過第二輪 LLM
  final_renderer            llm | deterministic_tool
請於部署環境 log 以 grep/Select-String 彙整。
```

## 原始 ZIP

`Omni-Agent-Console-Phase26-SOURCE.zip`（與專案同層目錄 `Omni-Agent-Console(自動客服系統)`），已排除 `node_modules`、`.git`、`dist`、`.cursor`、`mcps`、`*.db`。
