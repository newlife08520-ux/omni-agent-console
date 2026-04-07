# 查訂單／對客回覆 程式碼匯出包

**產出日期**：2026-04-07  
**用途**：給 GPT／Gemini 或內部檢閱「LINE／Messenger 查單 → 工具 → 格式化回覆」相關邏輯。

## 目錄結構

| 路徑 | 說明 |
|------|------|
| `gemini/01`～`10-*.md` | 給 Gemini 的 10 份濃縮說明（繁中，可分批上傳） |
| `source/*.ts` 等 | 實際程式碼快照（檔名為原檔 basename，同目錄扁平化） |

## `source/` 檔案對照（原名 → 專案內路徑）

- `schema.ts` → `shared/schema.ts`（`OrderInfo`、`Contact`、狀態型別等）
- `PHASE97_MASTER_SLIM.txt` → `docs/persona/PHASE97_MASTER_SLIM.txt`
- `tool-executor.service.ts` → `server/services/tool-executor.service.ts`
- `ai-reply.service.ts` → `server/services/ai-reply.service.ts`
- `order-ultra-lite.ts` → `server/prompts/order-ultra-lite.ts`
- 其餘 `order-*.ts`、`shopline.ts`、`superlanding.ts` 等均在 `server/` 下同名路徑。

## ZIP

上層目錄另有 `order-lookup-pack.zip`，內容與本資料夾相同。
