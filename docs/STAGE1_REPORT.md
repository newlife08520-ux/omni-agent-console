# 第一階段回報：環境與 build 穩定度

依 `cursor_fix_plan_omni_agent_console.md` 第一階段執行，直接改程式並驗收。

---

## 1. 改了哪些檔案

| 檔案 | 改動摘要 |
|------|----------|
| `script/build.ts` | 新增 `mkdir`；抽出 `buildServerEntry()`；先 build 主站，再 `mkdir("dist/workers", { recursive: true })`，再 build `server/workers/ai-reply.worker.ts` → `dist/workers/ai-reply.worker.cjs`，並 log 產物路徑。 |
| `.env.example` | 新增 `INTERNAL_API_SECRET=`、`INTERNAL_API_URL=` 及中文註解；REDIS_URL/OPENAI_MODEL 註解標明主站與 Worker 需一致／未設時以後端 fallback 為主；文末註明 test_mode 為 DB 設定非 .env。 |
| `server/meta-comment-auto-execute.ts` | `import * as storage` 改為 `import { storage }`；無 `pageSettings` 時改為只更新 `main_status: "pending_config"` 並 return，**不再**寫入 `auto_execution_run_at`。 |
| `shared/schema.ts` | `MetaCommentMainStatus` 新增 `"pending_config"`（尚無頁面設定，補好後可重跑）。 |
| `package.json` | `build` 改為 `npm run check && tsx script/build.ts`；新增 `clean`、`verify` 腳本。 |
| `docs/DEPLOYMENT_PRECHECK.md` | 新建：說明不可打包 node_modules、目標環境需 npm ci、clean → npm ci → check → build、主站/Worker 啟動方式及 Railway Worker 需設 INTERNAL_API_*。 |

---

## 2. 為什麼這樣改

- **build.ts**：正式環境 `start:worker` 依賴 `dist/workers/ai-reply.worker.cjs`，原本 build 只產 `dist/index.cjs`，Worker 無法啟動；改為同一套 esbuild 設定一併產出 worker，確保部署後有檔可跑。
- **.env.example**：Worker 打 `/internal/run-ai-reply` 依賴 `INTERNAL_API_SECRET`、`INTERNAL_API_URL`，範例沒寫會導致部署後 queue 有進、worker 有跑但打不回 internal API；補上後部署者能一次對齊主站與 Worker 設定。
- **meta-comment-auto-execute.ts**：  
  - `import { storage }` 才能正確呼叫 `storage.getChannelByBotId(pageId)`（storage 是實例不是 namespace）。  
  - 沒有 pageSettings 時若仍寫 `auto_execution_run_at`，留言會被視為已執行，之後補好設定也不會重跑；改為只設 `pending_config` 不寫 run_at，補好設定後可再重跑。
- **shared/schema.ts**：無 pageSettings 時要設 `main_status: "pending_config"`，需在型別中支援該值。
- **package.json**：build 前先 typecheck（文件要求）；提供 clean/verify 方便部署前檢查。
- **DEPLOYMENT_PRECHECK.md**：避免打包 Windows node_modules 到 Linux、以及漏設 Worker 環境變數等常見部署問題。

---

## 3. 這次改動解決什麼風險

- **Worker 在正式環境起不來**：build 現在會產出 `dist/workers/ai-reply.worker.cjs`，`npm run start:worker` 有檔可執行。
- **Worker 打不回 internal API**：.env.example 明列 `INTERNAL_API_SECRET`、`INTERNAL_API_URL`，減少漏設或主站/Worker 不一致。
- **Facebook 留言「當下沒設好、之後補好也不重跑」**：無 pageSettings 時不再寫 run_at，改為 pending_config，補好設定後可重跑。

---

## 4. 怎麼驗收

1. **Build 產物**  
   - 執行：`npx tsx script/build.ts`（不經 check，因專案有既存 TS 錯誤）。  
   - 檢查：`dist/index.cjs`、`dist/workers/ai-reply.worker.cjs` 存在。

2. **.env.example**  
   - 檢查：內含 `INTERNAL_API_SECRET`、`INTERNAL_API_URL` 及說明註解。

3. **.gitignore**  
   - 檢查：已排除 `node_modules/`、`dist/`、`.env`、`uploads/`、`data/`、`*.db`、`*.log`，且無例外把 node_modules 或 dist 拉回。

4. **meta-comment 邏輯**  
   - 程式面：無 pageSettings 時不寫 `auto_execution_run_at`，只設 `main_status: "pending_config"`；import 使用 `import { storage }`。

---

## 5. 驗收結果

| 項目 | 結果 |
|------|------|
| `npx tsx script/build.ts` | 成功；產出 `dist/index.cjs`、`dist/workers/ai-reply.worker.cjs`，並有 log `[build] worker built: dist/workers/ai-reply.worker.cjs`。 |
| .env.example | 已含 `INTERNAL_API_SECRET`、`INTERNAL_API_URL` 及註解。 |
| .gitignore | 已排除上述項目，無把 node_modules/dist 拉回的例外。 |
| meta-comment-auto-execute | 已改 import；無 pageSettings 時只設 pending_config、不寫 run_at。 |

**關於 `npm run build`**：目前為 `npm run check && tsx script/build.ts`。專案存在既存 TypeScript 錯誤（client/server 多檔），故 `npm run check` 會失敗，連帶 `npm run build` 會在 check 階段失敗。**第一階段僅驗證「build 腳本會產出 worker」**，已用單獨執行 `tsx script/build.ts` 通過。清掉 typecheck 錯誤後，`npm run build` 將可一次通過（屬第二階段 TypeScript/build 防線）。

---

## 6. 剩餘風險（需外部或真人才能驗證）

- **INTERNAL_API_SECRET / INTERNAL_API_URL**：需在實際主站 + Worker 環境設好並一致，才能驗證 Worker 真的打回 `/internal/run-ai-reply` 成功；本階段僅確保 .env.example 與文件有寫。
- **Facebook 留言 pending_config 重跑**：需有真實 Meta 留言、頁面設定先缺後補，才能驗證補好後是否會重跑；本階段僅確保程式邏輯正確。
- **Railway / 實機部署**：需在目標環境執行 `npm ci`、`npm run build`、分別啟動主站與 Worker，並具備 Redis、DB、Meta/LINE 憑證等，才能做端到端驗證；本階段僅提供 DEPLOYMENT_PRECHECK 與 env 範例。

---

第一階段程式改動與驗收已完成；第二階段將處理 TypeScript、tsconfig 與 build 前 typecheck 通過。
