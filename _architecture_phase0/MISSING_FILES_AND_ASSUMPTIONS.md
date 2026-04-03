# 缺失檔案、假設與證據類型

---

## 不存在或本次未納入的檔案／目錄

| 項目 | 狀態 |
|------|------|
| `docs/runtime-audit/superlanding-esc20981-linepay-fail.fixture.sanitized.json` | **不存在**（`r1-verify.ts` 引用路徑）；導致 `npm run verify:r1` 失敗。 |
| `migrations/*`（獨立目錄） | **本專案主要**以 `server/db.ts` 內 `initDatabase` + 多個 `migrate*` 函式演進；**非**典型 `migrations/*.sql` 目錄結構（至少在工作區未見獨立 migrations 資料夾為唯一真實來源）。 |
| 根目錄 `prisma/schema.prisma` | **未使用**（本專案為 Drizzle + better-sqlite3）。 |
| 正式 `.env`、production DB 檔 | **刻意排除**於 ZIP；不可取得 live production 佐證。 |
| `pnpm-lock.yaml` / `yarn.lock` | **不存在**；套件鎖定為 `package-lock.json`（npm）。 |

---

## 資料表 0 筆或無法匯出

- 以 **`runtime_snapshot/_export_summary.json`** 為準（執行 `scripts/export-runtime-addon-data.ts` 後產生）。  
- 若腳本報錯「No omnichannel.db」則全表缺失——**本次**開發路徑下 `omnichannel.db` **存在**（Phase 0 執行時已確認）。  

**本次匿名化匯出（開發庫一次取樣）實測**：`meta_page_settings`、`ai_logs`、`order_lookup_cache` 為 **0 筆**；其餘表有 1～15 筆不等。此為 **runtime fact（該 DB 檔）**，不可推論正式環境。  

---

## Code-derived vs runtime fact

| 結論類型 | 範例 |
|-----------|------|
| **Code-derived** | tools 全集合併、prompt 拼接順序、`getKnowledgeFiles` 依 `brand_id` 篩選。 |
| **Runtime fact** | 各表列數、範例列內容、verify 命令 exit code。 |
| **推測** | Worker 與主 service 完全同構；若未讀 `ai-reply.worker.ts` 全文則標為推測——**建議實作前比對**。 |

---

## 既有文件與本資料夾關係

- `docs/multi-brand-agent-ops/` 內含 **先前撰寫**的 TARGET／MIGRATION／GEMINI 十檔包等；**本** `_architecture_phase0/` 為 **2026-04-02 Phase 0 審核交付**，內容獨立撰寫並與 code 交叉驗證，**不**代表複製貼上舊檔（但方向一致處會自然重疊）。

---

## 字元編碼注意

- 部分 `server/openai-tools.ts`、終端機 capture 出現 **亂碼或 `?`**：**推測**為檔案編碼或 Windows console code page 與 UTF-8 不一致；**不**影響本報告對「工具名稱與結構存在」的結論，但 **審核時應以 UTF-8 原始檔為準**。
