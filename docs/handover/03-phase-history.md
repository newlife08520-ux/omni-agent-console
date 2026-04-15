---
產出時間: 2026-04-14（Asia/Taipei）
Phase 版本: Phase 106 交接包
檔案用途: Phase 106.1 至 106.17 演進與遺留議題
---

# 03 — Phase 歷史

以下依程式註解與 commit 訊息整理，細節以 git log 為準。

## 106.1

- 多來源訂單合併排序與 preferSource。檔案: order-service.ts。

## 106.2

- 擋空推播。檔案: messaging.service.ts。

## 106.3

- 手機查單 90 天過濾與多筆模板。檔案: order-service.ts, tool-executor.service.ts, order-reply-utils.ts。

## 106.4

- 主對話走 Gemini；健康檢查看 gemini_api_key。檔案: ai-reply.service.ts, settings-brands.routes.ts, core.routes.ts。

## 106.6

- Catalog 超時略過；SuperLanding single-flight。檔案: prompt-builder.ts, superlanding.ts。

## 106.7

- 人工排隊仍進 LLM；工具收緊與 release_handoff_to_ai。檔案: line-webhook, facebook-webhook, prompt-builder, openai-tools, ai-reply.service。

## 106.8

- 深度同步 per-brand lock 與 45 天。檔案: sync-orders-normalized.ts, index.ts。

## 106.9

- 訂單狀態分類與 live fallback。檔案: order-status.ts, order-service.ts, tool-executor.service.ts。

## 106.10

- 訂單客人向文案。檔案: order-reply-utils.ts。

## 106.11

- 輸出兜底、查無計次、排隊分流與工具擴充。檔案: phase2-output, lookup-not-found-strikes, guard-pipeline, ai-reply.service, prompt-builder。

## 106.12

- 退換標籤白名單與 idle 情境。檔案: idle-close-job.ts。

## 106.15

- 閒置結案順延營業時間與假日。檔案: idle-close-job.ts, business-hours.ts。

## 106.16

- Idle close 可觀測性 debug（commit: idle-close observability log）。

## 106.17

- 2026 國定假日 JSON 重寫（commit: holidays from official PDF）。

## Debug endpoints

- brand-readiness, lookup-contacts-by-names, conversation-export, clone-brand-config 等於 core.routes.ts。

## 遺留

- 見 04-known-bugs.md；SL 狀態映射待產品確認；settings 表無 updated_at。
