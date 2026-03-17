# 第四階段回報：Facebook / Messenger / 留言系統

依 `cursor_fix_plan_omni_agent_console.md` 第四階段執行，讓 Facebook 私訊與粉專留言路徑不再卡在設定與程式 bug。

---

## 1. 改了哪些檔案

| 檔案 | 改動摘要 |
|------|----------|
| `server/meta-comment-auto-execute.ts` | **無 pageSettings**：維持既有邏輯（設 `main_status: "pending_config"`、不寫 `auto_execution_run_at`），並新增 `storage.createSystemAlert`，details 為 `blocked:no_page_settings comment_id=… page_id=…`。**無 channel token**：在 `tryClaimAutoExecution` 前檢查 `getChannelToken(comment.page_id)`；若無 token，設 `main_status: "pending_config"`、寫 system alert `blocked:no_channel_token`、return，不 claim。僅在「有 pageSettings 且 token 可用」後才呼叫 `tryClaimAutoExecution`。 |
| `server/routes.ts` | **GET /api/meta-comments**：enriched 每筆加上 `blocked_reason: main_status === "pending_config" ? "no_page_settings" : undefined`。**GET /api/meta-comments/:id**：同上，單筆回傳加上 `blocked_reason`。 |

---

## 2. 為什麼這樣改

- **A/B（import + 無 pageSettings 不 claim）**：第一階段已完成（`import { storage }`、無 pageSettings 時只設 pending_config、不寫 run_at）。本階段補上 **blocked:no_page_settings** 的 system alert，方便追查。
- **C（只有可執行平台動作時才 claim）**：在 `tryClaimAutoExecution` 前增加 **channel token 檢查**。若無 token，不寫 `auto_execution_run_at`，只設 pending_config 並記錄 `blocked:no_channel_token`，避免「已被標記執行過但實際上沒送平台」。
- **D（meta_page_settings 不存在時的提示）**：留言列表與單筆 API 回傳 **blocked_reason**；當 `main_status === "pending_config"` 時設為 `"no_page_settings"`，前端可顯示「尚未完成自動留言設定」或「缺設定」。
- **E（Facebook webhook blocked reason）**：第三階段已在 FB controller 用 `recordAutoReplyBlocked` 記錄 no_channel_match、channel_ai_disabled、test_mode、no_channel_token，本階段無需再改。
- **F（匯入 page 回傳）**：第三階段已在 batch import 回傳中加入 message、ai_enabled、page_settings_created、next_steps，本階段無需再改。

---

## 3. 這次改動解決什麼風險

- **留言被誤標已執行**：缺 page settings 或 channel token 時不再 claim，補好設定後可重跑。
- **無法追查為何沒送**：缺 page settings / 缺 token 時都會寫 system_alert（auto_reply_blocked），可從報表或後台查。
- **前端看不到「尚未設定」**：列表與單筆 API 帶出 `main_status` 與 `blocked_reason`，前端可顯示「尚未完成自動留言設定」或 blocked_reason。

---

## 4. 怎麼驗收

1. **meta-comment-auto-execute**：import 為 `import { storage }`；無 pageSettings 或無 token 時不寫 `auto_execution_run_at`，只設 pending_config 並寫 alert。
2. **API**：GET /api/meta-comments 與 GET /api/meta-comments/:id 回傳中，當 `main_status === "pending_config"` 時帶 `blocked_reason: "no_page_settings"`。
3. **Messenger / 留言 blocked**：沿用第三階段 recordAutoReplyBlocked；第四階段僅補留言側 no_page_settings / no_channel_token 的 alert 與 API blocked_reason。

---

## 5. 驗收結果

| 項目 | 結果 |
|------|------|
| `npm run check:server` | 通過。 |
| 程式面 | tryClaim 前已檢查 pageSettings 與 channel token；無則 pending_config + alert；列表/單筆 API 已帶 blocked_reason。 |

**需真人/環境驗收**：建立一則留言且該 page 無 page_settings 或無 channel token，確認 DB 無 `auto_execution_run_at`、有 system_alert、API 回傳 main_status 與 blocked_reason；補好設定後可再次觸發執行。

---

## 6. 與前階段重疊說明

- **A/B**：第一階段已修 import 與「無 pageSettings 不寫 run_at」；本階段僅補 no_page_settings 的 system alert。
- **E**：第三階段已在 FB webhook 補齊 blocked 記錄。
- **F**：第三階段已加強 batch import 回傳內容。

第四階段 Facebook/Messenger/留言相關的 claim 順序與 API 提示已完成。
