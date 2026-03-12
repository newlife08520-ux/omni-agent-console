# Hotfix：human_request 優先、已給過、handoff 原子化、官方渠道 guard

## 一、哪個分支在搶 human_request

**搶答分支**：`server/routes.ts` 內 **圖片＋極短／模糊文字** 分支（`image_short_caption`）。

- 流程順序：`safeConfirmDm` → **圖片＋短說明**（`hasRecentImageFromUser && isShortOrAmbiguousImageCaption(userMessage)`）→ 之後才做 `resolveConversationState` / `buildReplyPlan`。
- 「可以幫我轉人工嗎」「我要轉人工」等會被當成「短說明」而先進入圖片兜底模板，未先判斷 human_request。

**修正**：

- 在 **conversation-state-resolver** 新增並匯出 `isHumanRequestMessage(text)`（使用既有 `HUMAN_REQUEST_PATTERNS`，並補上「可以幫我轉人工」「我要轉人工」）。
- 在 **routes** 圖片分支條件加上 **`!isHumanRequestMessage(userMessage)`**：只要本則為明確轉人工，**不進入**圖片模板，往下走 state/plan，由 handoff 處理。

---

## 二、handoff 去重是在哪一層做

**去重層**：**plan 產出後立即短路**（同一檔案 `routes.ts`，在 `buildReplyPlan` 之後）。

- **handoff 短路**：當 `plan.mode === "handoff"` 時，**不進 LLM**，直接：
  - 更新 `needs_human`、status、assignment、case notification；
  - 送出**唯一一則**客戶可見訊息：`buildHandoffReply(state)`（固定句「這邊先幫您轉接真人專員處理，請稍後。」＋依情境最多補一句訂單提示）；
  - 寫入 ai_log（reply_source: handoff, reason: handoff_short_circuit），然後 **return**。
- 因此不會出現「先出一大段 LLM 回覆再出第二則轉接」；handoff 時**只會有一則**客戶可見訊息。

若 handoff 是由 **LLM 內 tool 呼叫 transfer_to_human** 觸發（非本輪 plan 即 handoff），則在 **needs_human 早期 return 區塊**同樣只送一則 `buildHandoffReply`，不送 LLM 回覆內容。

---

## 三、already_provided 規則怎麼搜尋歷史資料

**觸發**：`isAlreadyProvidedMessage(userMessage)` 為 true 時（關鍵字：我給過了、你拿過了、我就給過了、前面有、我貼過了、你沒看到嗎、剛剛有、剛才給、已經給過、已經提供、上面有、剛剛傳了）。

**搜尋**：`searchOrderInfoInRecentMessages(recentMessages)`（`routes.ts`）：

- 輸入：本輪帶入的 **recentMessages**（近期 N 則，與組 prompt 用同一份）。
- 只掃 **user** 且 `content` 非空的訊息；略過 `[圖片訊息]`。
- 從內文用 regex 抓：
  - **訂單編號**：`\b([A-Z0-9\-]{5,25})\b`
  - **手機**：`\b(09\d{8})\b` 或 `\b(\d{10,11})\b`
- 回傳 `{ orderId?: string, phone?: string }`（只取第一次出現）。

**行為**：

- **有找到** orderId 或 phone：在 system prompt 注入「【本輪 已給過】客戶表示已提供過資料。以下為近期對話中曾出現的資訊，請直接使用：訂單編號 xxx、手機 xxx。勿再重問同一項。」，交給 LLM 沿用，不再重問。
- **沒找到**：**短路**，不進 LLM；送一則「不好意思造成困擾，這邊先幫您轉接真人專員處理，請稍後。」，並設 needs_human、建立 case、寫 ai_log（reason: already_provided_not_found），return。

未使用「圖片抽取結果」「linked order」等額外來源；目前僅用 **近期對話文字**。若要接圖片辨識或訂單連結，可再擴充 `searchOrderInfoInRecentMessages` 或另函式供同一流程呼叫。

---

## 四、哪些模板已加上 official channel guard

**位置**：`server/routes.ts`，組 **system prompt** 時（`getEnrichedSystemPrompt` 之後、呼叫 LLM 前）。

**條件**：`contact.channel_id` 有值（表示此對話來自已知渠道，即品牌官方 LINE/FB）。

**注入句**：

- 「【本輪 官方渠道】客人目前透過品牌官方 LINE/渠道與你對話，請勿再詢問「是否官方下單」「若是其他平台購買」等與情境衝突的句子；直接依其需求協助查單或售後。」

**效果**：在官方 LINE/渠道場景下，LLM 不會再輸出「若您是透過我們官方通路下單…若是其他平台…」等與情境衝突的模板句。

**未改動**：`reply-plan-builder` 的 F2 `must_not_include`（官方通路、其他平台等用語）仍保留，作為通用禁止；官方渠道 guard 是**額外**在已知為官方渠道時明確禁止「再問是否官方／其他平台」。

---

## 五、驗收案例逐筆 PASS / FAIL

| 案例 | 輸入／情境 | 預期 | 結果 |
|------|------------|------|------|
| **A** | 貼圖 + 「可以幫我轉人工嗎」 | 直接 handoff，不可先圖片模板 | **PASS**（isHumanRequestMessage 為 true、plan 為 handoff；routes 圖片分支因 !isHumanRequestMessage 不進入） |
| **B** | 「我要取消訂單」+ 近期已給單號 | 不重問「是否官方下單」、不重複要資料 | **E2E**（依賴 prompt 官方渠道 guard + already_provided 注入；腳本未模擬 storage/近期訊息） |
| **C** | 「你拿過了」「我就給過了」 | 先回收歷史資料，不直接再問一次 | **PASS**（isAlreadyProvidedMessage 為 true；有找到則 prompt 注入沿用，沒找到則短路轉真人） |
| **D** | 「煩死了」後進 handoff | 只允許 1 則客戶可見 handoff 訊息 | **PASS**（「煩死了我要轉人工」→ human_request + handoff；handoff_short_circuit 只送一則） |
| **E** | 官方 LINE 場景查單/取消 | 不可再問是否官方通路 | **E2E**（contact.channel_id 時注入官方渠道 guard；需實際官方 LINE 對話驗證） |

**執行**：`npx tsx server/phase1-verify.ts` → 16 通過（含 Hotfix A、C、D）。Phase 2 驗收 10 通過不變。

---

## 六、修改檔案清單

| 檔案 | 修改摘要 |
|------|----------|
| server/conversation-state-resolver.ts | HUMAN_REQUEST_PATTERNS 補「可以幫我轉人工」「我要轉人工」；匯出 `isHumanRequestMessage`；新增 `ALREADY_PROVIDED_PATTERNS` 與 `isAlreadyProvidedMessage` |
| server/routes.ts | 圖片分支加 `!isHumanRequestMessage(userMessage)`；plan 後 handoff 短路（只送一則 buildHandoffReply）；`searchOrderInfoInRecentMessages`；already_provided 時有找到則 prompt 注入、沒找到則短路轉真人；contact.channel_id 時注入官方渠道 guard |
| server/phase1-verify.ts | 匯入 isHumanRequestMessage、isAlreadyProvidedMessage；新增 Hotfix A、C、D、E 驗收案例 |

---

## 七、Acceptance steps（建議）

1. 發「可以幫我轉人工嗎」（可先發一圖再發此句）→ 回覆應為 handoff 固定句，且**僅一則**；不應先出現圖片兜底模板。
2. 發「你拿過了」且近期對話無訂單/手機 → 應收到道歉＋轉接真人一則，且不再重問。
3. 發「你拿過了」且近期對話有訂單編號或手機 → 回覆應直接沿用該資訊查單，不重問「請提供訂單編號」。
4. 在品牌官方 LINE 發查單/取消相關句子 → 回覆不應出現「若您是透過我們官方通路下單…若是其他平台」。
5. 觸發 handoff（例如「煩死了我要轉人工」）→ 僅一則「這邊先幫您轉接真人專員處理，請稍後。」（及依情境最多一句訂單提示），無第二則客戶可見 AI 訊息。
