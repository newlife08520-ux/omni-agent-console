# Smoke Test 驗收清單

本清單對應審查要求（J）：補最終 smoke test，需實際執行並在 FINAL_SIGNOFF_REPORT 中附結果。  
打勾表示已執行並通過；若未通過或未執行，請在備註註明。

---

## 環境與 Build

| 項目 | 指令/步驟 | 結果 | 備註 |
|------|-----------|------|------|
| 乾淨安裝 | `rm -rf node_modules dist && npm ci`（Windows: 手動刪除後 `npm ci`） |  |  |
| Server typecheck | `npm run check:server` |  | 需附實際輸出 |
| Build | `npm run build` |  | 需附實際輸出 |
| Full typecheck | `npm run check:all` |  | 若未過，列出失敗檔案 |
| 未追蹤 build 產物 | `git ls-files \| grep -E '^(node_modules\|dist)/'` 應無輸出 |  |  |

---

## LINE

| 項目 | 步驟 | 結果 | 備註 |
|------|------|------|------|
| LINE test mode | 開啟 test_mode，送 LINE 訊息 |  | 應 recordAutoReplyBlocked + 一筆 system 訊息「[模擬回覆，未實際送出]」，不計入真實 outbound |
| LINE 正常 mode | 關閉 test_mode，送 LINE 訊息 |  | 應正常進 queue / 回覆 |

---

## Facebook / Messenger

| 項目 | 步驟 | 結果 | 備註 |
|------|------|------|------|
| Channel 未匹配 | 用未綁定渠道的 FB 帳號送訊息 |  | 應 blocked，reason 可辨識 |
| Token 缺失 | 渠道無 access_token 送訊息 |  | 應 blocked_reason: no_channel_token |
| Meta 留言無 page settings | 留言到未設定 page settings 的粉專 |  | API 回 blocked_reason: no_page_settings |
| Meta 留言無 token | 留言到有 page 但無 channel token |  | API 回 blocked_reason: no_channel_token |

---

## Worker 與 Debug

| 項目 | 步驟 | 結果 | 備註 |
|------|------|------|------|
| Worker heartbeat | 啟動 worker，呼叫 GET /api/debug/runtime |  | 應有 worker_alive: true、worker_last_seen_at、worker_heartbeat_age_sec |
| Worker 未跑 | 不啟動 worker，呼叫 GET /api/debug/runtime |  | worker_alive: false 或 heartbeat 過期 |
| Queue 計數 | GET /api/debug/runtime（Redis 啟用時） |  | 應有 queue_waiting_count、queue_active_count、queue_delayed_count、queue_failed_count |
| blocked:worker_unavailable + 降級 | 停掉 worker，送一則 LINE/FB 訊息 |  | 應產生 system_alert reason=blocked:worker_unavailable，並 fallback inline 執行 AI 回覆（不入隊）；runtime 顯示 degraded_mode: true |
| last_inbound/outbound | GET /api/debug/runtime |  | channels[].last_inbound_at、last_outbound_at 依 messages 彙總；last_blocked_reason、last_blocked_at、last_successful_ai_reply_at 有值或 null |
| Handoff 稽核 API | GET /api/debug/handoff-alerts?reason=...&source=...&contact_id=... |  | 回傳 handoff_alerts 陣列，可篩選 reason/source/contact_id |

---

## Handoff

| 項目 | 步驟 | 結果 | 備註 |
|------|------|------|------|
| transfer_to_human tool | 觸發 LLM 呼叫 transfer_to_human |  | 經 normalizeHandoffReason，applyHandoff，alert 為 JSON |
| Timeout escalation | 觸發逾時轉人工 |  | reason 為 timeout_escalation |
| High risk escalation | 觸發高風險短路 |  | status 可升級 high_risk，仍留新 alert |

---

## Prompt 與模型

| 項目 | 步驟 | 結果 | 備註 |
|------|------|------|------|
| Effective prompt preview | GET /api/debug/prompt-preview?brandId=1 |  | 回傳 full_prompt、total_prompt_length、sections、model、includes（catalog, knowledge, image 等） |

---

## 簽收前必做

- 上述「環境與 Build」區塊的指令輸出需貼到 `docs/FINAL_SIGNOFF_REPORT.md`。
- 若 `npm run check:all` 未通過，不得宣稱「完整 typecheck 完成」；僅能寫「server deploy gate 完成」。
