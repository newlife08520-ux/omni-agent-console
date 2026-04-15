---
產出時間: 2026-04-14（Asia/Taipei）
Phase 版本: Phase 106 交接包
檔案用途: handover 目錄索引與打包順序建議
---

# docs/handover — 第三方架構 Review 打包說明

老闆 `git pull` 後可將本目錄**整包 zip** 或依序餵給 ChatGPT。

## 檔案清單（建議閱讀順序）

| 順序 | 檔名 | 說明 |
|------|------|------|
| 1 | 01-system-overview.md | 專案總覽、技術棧、Railway 雙服務、主流程 |
| 2 | 02-architecture.md | Mermaid 架構圖、訊息流、重要表摘要 |
| 3 | 03-phase-history.md | Phase 106.1–106.17 演進 |
| 4 | 04-known-bugs.md | 已知 Bug 與方向 |
| 5 | 05-core-services.md | 核心服務索引 |
| 5a–d | 05a … 05d … .md | ai-reply、tool-executor、prompt/messaging、business-hours、intent、ai-client **全文** |
| 6 | 06-order-handling.md | 訂單、一頁、閒置結案 **全文** |
| 7 | 07-webhook-and-queue.md | LINE、Facebook webhook、queue、worker、internal 節錄 **全文** |
| 8 | 08-admin-endpoints.md | 入口說明（請連同下列兩檔） |
| 8b | 08-admin-endpoints-index.md | Admin API 列表 |
| 8c | 08-admin-core.routes.md | core.routes.ts 全文 |
| 9 | 09-database-schema.md | DB 索引說明 |
| | 09a-database-db.ts.md | db.ts 全文 |
| | 09b-database-schema.ts.md | schema.ts 全文 |
| 10 | 10-current-status-snapshot.md | **請貼 production JSON／log** 後再打包 |

## 重新產生內嵌原始碼

若程式更新後需重刷 05–09 內嵌檔：

```bash
node scripts/build-handover-pack.mjs
```

（專案根目錄執行。）
