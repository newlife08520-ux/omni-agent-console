# LIVE_EVIDENCE_GAP_PLAN.md

**目標**：在 **不偽造列、不寫入正式環境業務庫** 的前提下，取得 **最小量** 可給 ChatGPT／人類審核的 **匿名真實** 證據（`ai_logs`、`order_lookup_cache`、`meta_page_settings`、webhook trace）。

---

## 1. 原則

| 原則 | 做法 |
|------|------|
| 不偽造 | 只匯出 DB **實際存在**的列；0 筆就維持 `[]` 並在 README 說明，不補假列。 |
| 不污染正式 | 正式環境 **禁止** 為取證而改 schema／灌測試帳；取證在 **本機／staging 複本** 或 **隔離 DB 檔** 進行。 |
| 最小量 | 每表 **5～20 筆** 足夠；全欄 **遮罩**（既有 `scripts/export-runtime-addon-data.ts` 邏輯可沿用）。 |

---

## 2. 取得真實 `ai_logs`

| 步驟 | 說明 |
|------|------|
| A. 隔離資料目錄 | 本機複製一顆 **僅測試用** 的 `omnichannel.db`（或 `DATA_DIR` 指到空目錄後由 `initDatabase` 建表），避免動到 production 掛載路徑。 |
| B. 觸發寫入 | 擇一：**(1)** `npm run dev` + **Sandbox**（若已啟用 `registerSandboxRoutes`）對 **測試 contact** 送訊並走 AI 路徑；**(2)** `dev:worker` + 佇列與 API 同開，對 **測試 LINE／Messenger channel**（測試用 channel token）送一則文字。 |
| C. 驗證 | `SELECT COUNT(*) FROM ai_logs` > 0 後執行匯出。 |
| D. 匯出 | `npx tsx scripts/export-runtime-addon-data.ts <outDir>`（已含遮罩）。 |

**可產出給審核的證據**：`ai_logs.json` 匿名列＋`_export_summary.json` 列數；可再加 **紅綠對照**（同一次請求的 `prompt_profile`／`reply_renderer`／`tools_called` 摘要）。

---

## 3. 取得真實 `order_lookup_cache`

| 步驟 | 說明 |
|------|------|
| A. 前置 | 測試庫需已跑過 **查單**（工具層或 sync），且 feature 未關閉寫入快取。 |
| B. 觸發 | 在 sandbox 或本機對 **測試品牌** 執行一次 `lookup_order_by_id`／phone lookup（可用 **假單號＋mock／staging API**，只要 **cache 表確實被寫**）；或執行 **`npm run sync:orders`**（`server/scripts/sync-orders-normalized.ts`）對 staging 商店拉單後再看 cache。 |
| C. 匯出 | 同上 `export-runtime-addon-data.ts`。 |

**證據**：`order_lookup_cache.json`（遮罩 key／phone）；若仍 0 筆 → README 註記「查單快取未命中或未啟用寫入」。

---

## 4. 取得真實 `meta_page_settings`

| 步驟 | 說明 |
|------|------|
| A. 觸發 | 在 **非正式** 後台為測試 `brand_id` **綁定一筆 Meta 測試頁**（或使用已有 staging page），使 `meta_page_settings` 有列。 |
| B. 若無後台操作條件 | 僅能在 **本機** 用 **migration 已允許** 的方式手動 INSERT 一筆測試 row 到 **本機 DB**（仍屬測試資料，非正式環境）；**不要**對 production 執行。 |
| C. 匯出 | `export-runtime-addon-data.ts`。 |

**證據**：`meta_page_settings.json`（`access_token` 等已由腳本 REDACT）。

---

## 5. 取得 webhook trace（接近 raw、已遮罩）

| 步驟 | 說明 |
|------|------|
| A. LINE | 使用 **LINE Developers 測試帳**＋**ngrok／staging URL** 指向本機 `dev`；傳一則測試訊息 → 在 **request log** 或 **自行 middleware 暫存最後一則 body**（僅測試環境）→ 以腳本遮罩 `userId`／`replyToken` 後存檔。 |
| B. Meta | 用 **測試粉專**＋**測試用 webhook**；同樣只保留 **本機／staging** 收到的 JSON。 |
| C. 勿從正式 DB 抽 raw | 若 DB 有 `raw_json` 欄，僅在 **合規與內部授權** 下對 **staging 複本** 匯出並遮罩。 |

**證據**：`line_webhook_rawish_masked.json`／`meta_webhook_rawish_masked.json`（**provenance** 註明 capture 時間與環境：staging／local）。

---

## 6. 最小腳本／流程清單（建議順序）

1. `npm run check:server`（確認可編譯）  
2. 準備 **獨立 `DATA_DIR`** 或複製測試 `omnichannel.db`  
3. `npm run dev`（＋可選 `dev:worker`）  
4. **Sandbox 或測試 webhook** 觸發 1～3 輪對話與查單  
5. `npx tsx scripts/export-runtime-addon-data.ts ./_evidence/db_snapshot_anonymized`  
6. （可選）`npx tsx scripts/export-knowledge-index-addon.ts ./_evidence`  
7. 將 webhook 遮罩檔與 DB JSON **一併** zip，附 `_export_summary.json` 與 **環境說明**（local／staging、日期 UTC）

---

## 7. 可給 ChatGPT 審核的產物清單

- `_export_summary.json`（每表匯出筆數，誠實 0 筆）  
- `ai_logs.json`、`order_lookup_cache.json`、`meta_page_settings.json`（匿名）  
- 1 份 **tool／handoff** 對照：從 `ai_logs` 列中截 **同一 `contact_id`** 的 tool 與回覆摘要（已遮罩）  
- **VERIFY_TRUTH_MATRIX.md**（本 repo）＋ **phase34 / r1** 最新終端輸出（exit code）  
- **不提交**：未遮罩 token、production 路徑、完整 `.env`

---

## 8. 刻意不做的事

- 不在正式庫 **INSERT 假 ai_logs**「為了好看」。  
- 不把 **synthetic** JSON 標榜為 live capture（與增量包中 synthetic 範本區隔）。  
- 不因取證而 **關閉** production 的資安設定或改 **正式** channel 到測試 webhook（應另建測試 channel）。
