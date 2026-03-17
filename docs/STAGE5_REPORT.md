# 第五階段回報：修 handoff 分散與人格亂轉人工

依 `cursor_fix_plan_omni_agent_console.md` 第五階段執行，將「轉人工」收斂成單一入口，避免多處散落改狀態導致人格或流程打架。

---

## 1. 改了哪些檔案

| 檔案 | 改動摘要 |
|------|----------|
| `server/services/handoff.ts` | **新建**。定義 `HandoffReason` 型別、`ApplyHandoffParams`、`applyHandoff()`。統一執行：`updateContactStatus`（可選 `statusOverride: "high_risk"`）、`updateContactHumanFlag(1)`、`updateContactAssignmentStatus("waiting_human")`、可選 `createCaseNotification`、`createSystemAlert`（alert_type: "transfer", details: `${source}:${reason}`）。Idempotent guard：若 contact 已是 `awaiting_human` 或 `high_risk` 且 `needs_human === 1` 則僅 log、不重複寫入。 |
| `server/routes.ts` | 新增 `import { applyHandoff } from "./services/handoff"`。**POST /api/contacts/:id/transfer-human**：改為呼叫 `applyHandoff({ reason: "explicit_human_request", source: "api_transfer_human" })`，再執行 assignCase、needsAssignment、setAiMutedUntil、broadcast（移除重複 createSystemAlert）。**PUT /api/contacts/:id/human**：當 `req.body.needs_human` 為 true 時改為呼叫 `applyHandoff({ reason: "explicit_human_request", source: "api_put_human" })`。**管理員發送訊息（Hard Mute）**：改為 `applyHandoff({ reason: "explicit_human_request", source: "api_admin_message" })`。**Webhook AI 路徑**：high_risk short circuit、safe_confirm suggest_human、awkward_repeat、plan.mode handoff、already_provided_not_found、**transfer_to_human tool 處理**、**timeout >= 2**（首輪與 loop 兩處）皆改為呼叫 `applyHandoff` 並帶對應 reason/source。**executeToolCall** 內 `transfer_to_human`：改為呼叫 `applyHandoff({ reason, source: "sandbox_tool_call" })`，再保留 createMessage 系統備註。 |
| `server/controllers/facebook-webhook.controller.ts` | 新增 `import { applyHandoff } from "../services/handoff"`。圖片補充升級（escalate）改為 `applyHandoff({ reason: "post_reply_handoff", source: "fb_webhook_image_escalate" })`。關鍵字觸發轉人工改為 `applyHandoff({ reason: "explicit_human_request", source: "fb_webhook_keyword" })`。 |
| `server/controllers/line-webhook.controller.ts` | 新增 `import { applyHandoff } from "../services/handoff"`。關鍵字觸發轉人工改為 `applyHandoff({ reason: "explicit_human_request", source: "line_webhook_keyword" })`。圖片補充升級改為 `applyHandoff({ reason: "post_reply_handoff", source: "line_webhook_image_escalate" })`。影片訊息固定回覆並轉人工改為 `applyHandoff({ reason: "post_reply_handoff", source: "line_webhook_video" })`。 |

---

## 2. 為什麼這樣改

- **A（handoff service）**：單一真實入口，所有「轉人工」狀態與副作用（status、needs_human、assignment_status、case notification、system alert）由 `applyHandoff()` 執行，便於 traceability 與日後調整。
- **B（收斂散落 updateContactHumanFlag(..., 1)）**：high_risk、awkward_repeat、timeout >= 2、transfer_to_human tool、post-handoff、明確人工按鈕/操作等路徑皆改走 `applyHandoff()`，並依情境帶入對應 `reason` / `source`。
- **C（LLM 只請求轉人工）**：`transfer_to_human` tool 僅回報 request（reason）；實際狀態切換與 side effects 由 `applyHandoff()` 執行，避免程式與 LLM 分散改狀態。
- **D（handoff traceability）**：system_alert 的 details 為 `${source}:${reason}`，log 中有 `[Handoff] contact … reason=… source=…`，可回答「為什麼這個人格又轉人工了？」。
- **E（避免重複 handoff）**：在 `applyHandoff` 內若 contact 已是 awaiting_human 或 high_risk 且 needs_human=1，僅 log、不重複寫入。

---

## 3. 這次改動解決什麼風險

- **人格亂轉人工**：多處各自改 status/needs_human 易造成不一致；改走單一 helper 後行為一致。
- **難以追查轉人工原因**：alert 與 log 可依 source/reason 查詢（high_risk、repeat、timeout、tool call、keyword 等）。
- **重複寫入**：已在 handoff 狀態時不再重複執行相同副作用。

---

## 4. 怎麼驗收

1. **handoff service**：`server/services/handoff.ts` 存在，export `HandoffReason`、`applyHandoff`；內含 idempotent 判斷與統一狀態/alert 寫入。
2. **關鍵路徑**：API 手動轉人工、Webhook（LINE/FB）關鍵字/圖片升級/影片、Webhook AI（high_risk、awkward、plan handoff、already_provided、transfer_to_human tool、timeout >= 2）、sandbox executeToolCall transfer_to_human、PUT /api/contacts/:id/human、管理員發送訊息，皆改為呼叫 `applyHandoff`。
3. **transfer_to_human tool**：不再在呼叫處直接寫 status/humanFlag/assignmentStatus/caseNotification/alert，改由 `applyHandoff()` 執行。
4. **log / alert**：可從 system_alerts（alert_type: "transfer", details 含 source:reason）或 console `[Handoff]` 查 source + reason。

---

## 5. 驗收結果

| 項目 | 結果 |
|------|------|
| `npm run check:server` | 通過。 |
| `npm run build` | 通過。 |
| 程式面 | handoff 服務已建立；routes / LINE / FB 關鍵 handoff 路徑已收斂至 `applyHandoff`；tool call 僅回報 reason，狀態由 helper 執行；idempotent guard 已加入。 |

**需真人/環境驗收**：實際觸發各來源（手動轉人工、關鍵字、tool call、timeout、high_risk 等），確認 DB 與 system_alerts 中 details 為 `source:reason` 格式，且重複觸發時不重複寫入。

---

## 6. 未改動說明

- **assignment.ts `unassignCase`**：該函式為「取消指派、案件回到待人工佇列」，並非「從 AI 轉人工」；仍直接呼叫 `updateContactStatus` / `updateContactAssignmentStatus`，未改為 `applyHandoff`。
- **restore-ai / 清除 needs_human**：`updateContactHumanFlag(id, 0)` 與 status 改回 ai_handling 等仍保留於原處，不經 handoff 服務。

第五階段 handoff 收斂與 traceability 已完成。
