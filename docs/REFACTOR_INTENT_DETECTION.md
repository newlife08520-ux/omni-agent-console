# Intent Detection Refactor TODO

## 設計原則

意圖判斷 → 用 AI（prompt 動態注入狀態 + tool 主動觸發）
安全護欄 → 用 regex（嚴格、寧可誤殺）
資料抽取 → 用 regex（格式問題）

## 已重構

### ✅ FORM_SUBMITTED_PATTERNS → mark_form_submitted tool
- 日期：2026-04-07
- 原因：「算了改成整筆取消好了」誤觸轉真人
- 解法：waiting_for_customer 狀態 + AI 工具
- Commit：c78a08b

## 待重構（按優先級）

### 🟡 P1: AI_SERVICE_REQUEST_PATTERNS → AI 判斷
**位置**：server/conversation-state-resolver.ts
**現況**：用 regex 偵測「幫我查訂單」「不要轉人工」這類句子，解鎖人工排隊
**問題**：誤觸風險（例如「不要查訂單了」可能誤觸）
**建議解法**：
- prompt 動態注入「contact 目前在人工排隊，請判斷客人是否要 AI 服務」
- 加工具 `request_resume_ai_handling(reason)` 讓 AI 主動呼叫
- 拿掉 webhook 層的 regex gate

### 🟡 P1: CANCEL_FLOW_FOLLOWUP_PATTERNS → conversation state
**位置**：server/conversation-state-resolver.ts
**現況**：用 regex 偵測「買多了」「後悔」這類句子，解鎖人工排隊
**問題**：誤觸風險（例如「我朋友也後悔」可能誤觸）
**建議解法**：
- 把「contact 目前在取消流程中」標進 conversation state
- AI 看 state 自己判斷脈絡

### 🟡 P2: INSIST_REFUND_PATTERNS → 移除自動觸發
**位置**：server/services/ai-reply.service.ts
**現況**：用 regex 偵測客人堅持退貨，自動 needs_human=1
**問題**：誤觸風險 + 跟新的「給表單」流程衝突
**建議解法**：
- 完全交給 prompt 處理（第 3 輪給表單）
- 加 `mark_user_insists()` 工具讓 AI 主動觸發
- 拿掉自動偵測

### 🟡 P2: RETURN_FORM_FOLLOWUP_PATTERNS → 跟 FORM_SUBMITTED 合併
**位置**：server/conversation-state-resolver.ts
**現況**：用 regex 偵測退貨表單後續句，解鎖人工排隊
**問題**：跟 FORM_SUBMITTED 重複邏輯
**建議解法**：
- 統一用 waiting_for_customer 狀態
- 客人在等待表單期間的所有訊息都讓 AI 處理（不再 gate）

## 不重構（保留 regex）

### ✅ extractPhone / extractOrderId
資料抽取，格式問題，regex 100% 準確

### ✅ COD_METHOD_REGEX  
API 代碼比對，固定格式

### ✅ WAIT_PAYMENT_HINT
後端資料字串比對，不是對話意圖

### ✅ detectOrderActionHallucination / detectFabricatedOrder
**安全護欄**：檢查 AI 輸出有沒有亂講，寧可誤殺也要擋

### ✅ CONVERSATION_RESET_REQUEST_PATTERNS
**安全護欄**：擋「重新開始」繞過真人排隊，要嚴格

### ✅ SHOPLINE_HINTS / SUPERLANDING_HINTS
平台選擇，二選一明確
