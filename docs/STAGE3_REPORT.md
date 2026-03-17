# 第三階段回報：test mode、channel 開關、runtime debug

依 `cursor_fix_plan_omni_agent_console.md` 第三階段執行，讓系統能清楚知道測試模式、channel AI 開關、queue/worker 預期與訊息卡在哪一層。

---

## 1. 改了哪些檔案

| 檔案 | 改動摘要 |
|------|----------|
| `server/auto-reply-blocked.ts` | **新建**：匯出 `recordAutoReplyBlocked(storage, opts)`，原因代碼含 `blocked:test_mode`、`no_channel_match`、`channel_ai_disabled`、`no_channel_token` 等；寫入 `system_alerts`，`alert_type: "auto_reply_blocked"`，`details` 含 reason、contact_id、platform、channel_id、brand_id、message_summary（截短）。 |
| `server/controllers/line-webhook.controller.ts` | 匯入 `recordAutoReplyBlocked`。文字訊息且 `shouldInvokeAi` 時：無匹配 channel → `blocked:no_channel_match`；有 channel 但 `!aiEnabled` → `blocked:channel_ai_disabled`；test mode 時 → `blocked:test_mode` 並寫入訊息改為「[模擬回覆，未實際送出] 收到您的訊息：「…」。」 |
| `server/controllers/facebook-webhook.controller.ts` | 匯入 `recordAutoReplyBlocked`。文字訊息且 `shouldInvokeAi` 時：無 `matchedChannel` → `blocked:no_channel_match`；有 channel 但 AI 關閉 → `blocked:channel_ai_disabled`；test mode → `blocked:test_mode`；無 token → `blocked:no_channel_token`；其餘才 enqueue / debounce。 |
| `server/routes.ts` | **/api/debug/status**：新增 `redis_enabled`、`internal_api_secret_configured`、`worker_mode_expected`、`meta_page_settings_summary`（total、page_ids）；channels 每筆新增 `is_ai_enabled`。**/api/debug/runtime**：新建 GET，回傳 timestamp、node_env、test_mode、redis_enabled、internal_api_secret_configured、internal_api_url（已設定與否）、worker_mode_expected、channels（含 is_ai_enabled、has_token、has_secret、last_inbound_at/last_outbound_at 暫為 null）、meta_pages（id、page_id、page_name、brand_id、auto_reply_enabled、auto_hide_sensitive、auto_route_line_enabled、has_channel_token）。**POST /api/meta/batch/import**：成功結果新增 `message`、`ai_enabled`、`page_settings_created`、`next_steps`，明確說明「渠道已建立、AI 預設關閉、請至後台手動開啟」。 |

---

## 2. 為什麼這樣改

- **recordAutoReplyBlocked**：test mode 或條件不足時不再只打 log，改為寫入 `system_alerts`，方便查報表與除錯；原因代碼與文件一致，可與後續 blocked 統計對齊。
- **LINE/FB 一致化**：兩邊都在「該送 AI 但被擋」時呼叫 `recordAutoReplyBlocked`；LINE 測試模式訊息改為「[模擬回覆，未實際送出]」避免誤以為已實際送出。
- **/api/debug/status 擴充**：補上 `is_ai_enabled`、redis、INTERNAL_API、worker 預期、meta_page_settings 摘要，讓前端或維運一眼看出環境與開關狀態。
- **/api/debug/runtime**：獨立 endpoint 提供完整 runtime 結構（channels、meta_pages），利於腳本或監控使用；last_inbound_at / last_outbound_at 預留為 null，之後可依需求補查詢。
- **匯入 page 回應**：明確回傳「已建立、AI 關閉、page settings 已建立」與下一步操作，減少「以為已全啟用」的誤解。

---

## 3. 這次改動解決什麼風險

- **test mode 不透明**：被 test mode 擋下時會寫 `auto_reply_blocked` + `blocked:test_mode`，並在 LINE 顯示「[模擬回覆，未實際送出]」，不會被當成已送平台。
- **不知道卡在哪一層**：no_channel_match、channel_ai_disabled、no_channel_token 等都有記錄，可從 system_alerts 或報表追查。
- **debug 看不到 AI 開關與 worker 環境**：/api/debug/status 與 /api/debug/runtime 可看到 is_ai_enabled、redis、INTERNAL_API、worker_mode_expected、meta_page_settings 摘要。
- **匯入 page 後誤以為全開**：batch import 回應明確寫出 AI 預設關閉與下一步要手動開啟的開關。

---

## 4. 怎麼驗收

1. **test mode 記錄**：開啟 test_mode，送 LINE / Messenger 文字訊息，查 DB `system_alerts` 應有 `alert_type = 'auto_reply_blocked'`、`details` 含 `blocked:test_mode`；LINE 對話應出現「[模擬回覆，未實際送出] …」。
2. **channel AI 關閉**：關閉某 channel 的 is_ai_enabled，送該渠道訊息，應有 `blocked:channel_ai_disabled` 記錄。
3. **/api/debug/status**：GET 回傳應含 `redis_enabled`、`internal_api_secret_configured`、`worker_mode_expected`、`meta_page_settings_summary`，且每個 channel 有 `is_ai_enabled`。
4. **/api/debug/runtime**：GET 回傳應含 `channels`（含 is_ai_enabled、has_token、has_secret）、`meta_pages`、`test_mode`、`worker_mode_expected` 等。
5. **匯入 page**：POST /api/meta/batch/import 成功時，該筆 result 應含 `message`、`ai_enabled: 0`、`page_settings_created: true`、`next_steps` 陣列。

---

## 5. 驗收結果

| 項目 | 結果 |
|------|------|
| `npm run check:server` | 通過。 |
| 程式面 | recordAutoReplyBlocked 已於 LINE/FB 文字分支呼叫；debug 兩支 endpoint 已擴充；batch import 回應已補 message / next_steps。 |

**需真人/環境驗收**：實際送 LINE/FB 訊息、查 DB system_alerts、呼叫 /api/debug/status 與 /api/debug/runtime、執行一次 batch import，需在本機或部署環境手動執行。

---

## 6. 剩餘風險與後續建議

- **last_inbound_at / last_outbound_at**：目前 /api/debug/runtime 的 channels 中為 null，若需「最後一筆進/出站時間」可再從 messages 依 channel 彙總查詢。
- **blocked:no_channel_secret / no_page_settings / worker_unavailable**：文件所列原因已預留於型別，FB/LINE 目前實作僅在「文字 + shouldInvokeAi」分支寫入；留言或其它路徑若需同套原因碼可再補呼叫 `recordAutoReplyBlocked`。

---

第三階段 test mode 透明化、webhook 擋住原因記錄、debug 擴充與匯入 page 回應已完成。
