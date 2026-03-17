# 轉人工（handoff）邏輯從哪調用、要改從哪改

## 一、整體流程（誰先誰後）

```
LINE/FB 訊息進站
    ↓
① Webhook 關鍵字快篩（routes.ts）→ 命中就「直接轉人工」、不進 AI
    ↓ 未命中
② autoReplyWithAI → resolveConversationState（意圖／needs_human）→ buildReplyPlan（mode）
    ↓
③ 若 awkward-repeat-handoff 觸發 → 直接轉人工
④ 若 plan.mode === "handoff" → 直接轉人工（不進 LLM）
⑤ 否則進 LLM；LLM 可呼叫 transfer_to_human → 寫入 needs_human
⑥ 回覆後若 needs_human 或靜音 → 再補一則 handoff 告知句
```

---

## 二、各層從哪調用、要改從哪改

### 1. Webhook 關鍵字快篩（**最先**，一命中就轉人工）

| 項目 | 說明 |
|------|------|
| **檔案** | `server/routes.ts` |
| **約略行數** | 4549–4552（關鍵字來源）、4625–4635（判斷 + 設 needs_human + 送 handoff） |
| **邏輯** | `human_transfer_keywords` 設定（或預設 `真人客服,轉人工,找主管,不要機器人,人工客服,真人處理`），**本則訊息內容**只要 `text.includes(某關鍵字)` 就：設 needs_human、送「轉接真人」、**不進 AI**。 |
| **要改「問任何話都轉」可這樣做** | • 到後台「系統設定」改 `human_transfer_keywords`，縮減關鍵字或改為更精準的詞（例如只留「轉人工」「找真人」）。<br>• 或改程式：不要用「只要包含關鍵字就轉」，改成「整句幾乎等於該關鍵字」或改由下面 2 的意圖層判斷。 |

---

### 2. 意圖與 needs_human（state）

| 項目 | 說明 |
|------|------|
| **檔案** | `server/conversation-state-resolver.ts` |
| **誰調用** | `server/routes.ts` 的 `autoReplyWithAI` 裡呼叫 `resolveConversationState(...)`（約 3798 行）。 |
| **邏輯** | • `detectPrimaryIntent()`：用 `HUMAN_REQUEST_PATTERNS`、`PURE_GREETING_OR_VAGUE` 等判斷是否為「明確要真人」等。<br>• `needs_human`：從 contact 既有值繼承，或依本輪意圖改寫；**若本輪是 order_lookup / link_request 會強制不沿用**（不因前一句就轉人工）。 |
| **要改「問任何話都轉」可這樣做** | • 放寬「不沿用 needs_human」的意圖：在 `resolveConversationState` 裡，對 `order_lookup`、`link_request` 以外再加「本輪是商品諮詢／價格／一般問答／閒聊等也清掉 needs_human」，只在本輪**明確要真人**時才設 needs_human。<br>• 或放寬 `PURE_GREETING_OR_VAGUE`、收緊 `HUMAN_REQUEST_PATTERNS`，讓更多句子不判成 human_request。 |

---

### 3. 本輪 mode（handoff 與否）

| 項目 | 說明 |
|------|------|
| **檔案** | `server/reply-plan-builder.ts` |
| **誰調用** | `server/routes.ts` 的 `autoReplyWithAI` 裡在 `resolveConversationState` 之後呼叫 `buildReplyPlan({ state, ... })`（約 3811 行）。 |
| **邏輯** | 若 `state.needs_human && state.human_reason` 且 human_reason 在白名單內 → `mode === "handoff"`，後面就不進 LLM、直接出轉人工句。 |
| **要改** | 通常改上面 2 的 `needs_human` / `human_reason` 即可；若你要「連 human_reason 符合也不轉」的少數情境，再來改這裡條件。 |

---

### 4. 尷尬／重複對話強制轉人工

| 項目 | 說明 |
|------|------|
| **檔案** | `server/awkward-repeat-handoff.ts` |
| **誰調用** | `server/routes.ts` 的 `autoReplyWithAI` 裡，在 buildReplyPlan 之後、進 LLM 前呼叫 `shouldHandoffDueToAwkwardOrRepeat(...)`（約 3813 行）。 |
| **邏輯** | 同一種資料重問兩次、同一模板重複、用戶說「我給過了」且 AI 還在討資料、類別跳錯等 → 回傳要轉人工，routes 直接送 handoff。 |
| **要改** | 若覺得「重複問兩次」就轉太敏感，可改 `awkward-repeat-handoff.ts` 的條件或關閉其中幾條。 |

---

### 5. LLM 呼叫 transfer_to_human

| 項目 | 說明 |
|------|------|
| **檔案** | `server/routes.ts`（prompt 與 tool 定義）、執行時在 LLM 回覆裡呼叫 `transfer_to_human`。 |
| **邏輯** | System prompt 與 tool 描述規定「僅在明確要真人、法務/公關風險、金流/訂單爭議等六種情況才呼叫」；一呼叫就寫入 needs_human 並回傳轉接句。 |
| **要改** | 在 `getEnrichedSystemPrompt` 的 handoff 相關段落、以及 `transfer_to_human` 的 tool description 再收緊用語，避免模型過度呼叫。 |

---

### 6. 回覆後補一則 handoff 告知句

| 項目 | 說明 |
|------|------|
| **檔案** | `server/routes.ts` 約 4353 行附近。 |
| **邏輯** | 若 **contact 已 needs_human 或靜音或 awaiting_human**，在 AI 回覆流程結束後再送一則「轉接真人／請稍後」的固定句。 |
| **要改** | 通常不用改；只要前面 1～5 少設 needs_human，這裡就不會多送。 |

---

## 三、建議：讓「一般問話」不再沿用轉人工

若現象是「問任何話都會轉人工」，多半是：

- **contact 已被標成 needs_human**（例如之前某句觸發 ① 或 ② 或 ⑤），之後**每一句**都沿用這個 flag，所以每輪都走 handoff。

**建議改法（在 conversation-state-resolver）：**

- 在 `resolveConversationState` 裡，**不只**在 `order_lookup`、`link_request` 時清掉 needs_human，改為：
  - **只要本輪意圖是「可由 AI 處理」**（例如：order_lookup、link_request、product_consult、price_purchase、smalltalk、unclear 等），就**本輪不沿用** contact 的 needs_human（視為本輪不轉人工）；
  - **只有本輪再次明確要真人**（human_request）或高風險、堅持退款等，才設 needs_human。

這樣「問訂單、問價格、問商品、閒聊」都會由 AI 回，不會再因為之前被標過 needs_human 就每一句都轉人工。

---

## 四、快速對照：關鍵檔案與符號

| 目的 | 檔案 | 關鍵符號／位置 |
|------|------|----------------|
| Webhook 關鍵字快篩 | `server/routes.ts` | `HUMAN_KEYWORDS`、`human_transfer_keywords`、約 4625 行 `needsHuman = HUMAN_KEYWORDS.some(...)` |
| 意圖／needs_human | `server/conversation-state-resolver.ts` | `HUMAN_REQUEST_PATTERNS`、`PURE_GREETING_OR_VAGUE`、`resolveConversationState` 裡對 needs_human 的賦值與「不沿用」條件 |
| 本輪 mode handoff | `server/reply-plan-builder.ts` | `buildReplyPlan`、`needs_human && human_reason` → handoff |
| 尷尬／重複轉人工 | `server/awkward-repeat-handoff.ts` | `shouldHandoffDueToAwkwardOrRepeat`、`sameDataAskedTwice`、`userSaidAlreadyGaveAndLastAiAskedAgain` 等 |
| LLM 轉人工工具 | `server/routes.ts` | `transfer_to_human` 的 tool 定義與 prompt 中的「六種情況」 |

以上是「轉人工邏輯從哪調用、要改從哪改」的完整對照；若要收斂「問任何話都轉人工」，優先改 **① Webhook 關鍵字** 與 **② 意圖層不沿用 needs_human 的條件**。
