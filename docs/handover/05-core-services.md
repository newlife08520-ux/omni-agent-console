---
產出時間: 2026-04-14（Asia/Taipei）
Phase 版本: Phase 106 交接包
檔案用途: 【檔案 5】核心服務原始碼索引（已拆檔）
---

# 05 — 核心服務原始碼

因單檔超過合理閱讀長度，**完整內容**已拆成下列檔案（皆含 YAML metadata 與 ```typescript 內嵌）：

| 檔案 | 內容 |
|------|------|
| **05a-core-services-ai-reply.service.md** | `server/services/ai-reply.service.ts` |
| **05b-core-services-tool-executor.md** | `server/services/tool-executor.service.ts` |
| **05c-core-services-prompt-messaging.md** | `prompt-builder.ts`、`messaging.service.ts`、`contact-classification.ts`、`business-hours.ts` |
| **05d-core-services-intent-ai-client.md** | `intent-router.service.ts`、`ai-client.service.ts` |

第三方 review 時建議順序：**05a → 05b → 05c → 05d**。
