# 轉真人（handoff）觸發總表與可能衝突

> 目的：找出「一直轉真人」的可能原因，以及多條規則是否互相打架。

---

## 一、相關檔案一覽（會影響「是否轉真人」的程式）

| 檔案 | 角色 |
|------|------|
| **server/routes.ts** | Webhook 入口、高風險短路、尷尬/重複轉人工、state_resolver 後 plan.mode=handoff、已給過未找到轉人工、**LINE/FB 關鍵字先判**、LLM 後 post-handoff 強制告知句、transfer_to_human 工具 |
| **server/conversation-state-resolver.ts** | 決定 `needs_human`、`human_reason`（明確要真人 / 投訴 / 堅持退款 等）→ 供 reply-plan 用 |
| **server/reply-plan-builder.ts** | 依 state 產出 `plan.mode`，`handoff` 為最高優先 |
| **server/awkward-repeat-handoff.ts** | 同一種資料重問 ≥3 次、同一模板重複 2 次、用戶說「我給過了」且 AI 又討資料、類別跳錯 → 直接轉人工 |
| **server/phase2-output.ts** | `buildHandoffReply`、`getHandoffReplyForCustomer`、`HANDOFF_MANDATORY_OPENING` |
| **server/content-guard.ts** | 發送前 guard（禁語等） |
| **server/storage.ts** | `updateContactHumanFlag`、`isAiMuted`、contacts.needs_human |
| **server/already-provided-search.ts** | 客戶說「已給過」時三層搜尋訂單/手機；沒找到 → 轉真人 |
| **server/db.ts** | `human_transfer_keywords` 設定、migration 收緊關鍵字 |

---

## 二、轉真人觸發來源（依「發生時機」排序）

### 1. Webhook 收到「文字」當下（不進 LLM，直接轉）

| 來源 | 條件 | 位置 |
|------|------|------|
| **LINE 關鍵字** | 訊息內容 **包含** 任一關鍵字即設 needs_human=1 並送 handoff 句 | routes.ts 約 4712–4722 |
| **FB 關鍵字** | 同上 | routes.ts 約 5109–5121 |

- **預設關鍵字**  
  - LINE：`["我要轉人工", "轉人工", "找真人客服", "找主管"]`  
  - FB：`["真人客服", "轉人工", "找主管", "不要機器人", "人工客服", "真人處理"]`  
- 後台設定 `human_transfer_keywords` 可覆寫（逗號分隔），**LINE 與 FB 共用同一設定**，若設得太寬（例如單字「人工」「客服」）會導致很多句被當成要轉真人。

---

### 2. 進 AI 流程前（Gate／短路，不進 LLM）

| 來源 | 條件 | 位置 |
|------|------|------|
| **高風險短路 legal_risk** | 訊息內容**包含**任一下列詞：投訴、客訴、消保、消費者保護、消基會、法律、律師、告你、告你們、提告、訴訟、報警、警察、公平會、媒體、爆料、上新聞、找記者、詐騙、騙子、去死 | routes.ts 約 166–170, 3720–3755 |
| **尷尬／重複** | 同一種「討資料」句型出現 **≥3 次** / 最近兩則 AI 回覆高度相似 / 用戶說「我給過了」且前一則 AI 在討訂單或手機且更早訊息裡有訂單或手機 / 類別跳錯（用戶上一輪查單、上一則 AI 卻回表單） | routes.ts 約 3880–3924；awkward-repeat-handoff.ts |
| **已給過未找到** | 用戶訊息符合「已給過」句型，且三層搜尋（近期文字、最近圖片 vision、linked order）**都沒有**訂單編號或手機 → 直接轉真人 | routes.ts 約 4102–4145 |

---

### 3. State Resolver → plan.mode = handoff（不進 LLM，只送一句轉接）

| 來源 | 條件 | 位置 |
|------|------|------|
| **state_resolver** | `resolveConversationState` 產出 `needs_human=true` 且 `human_reason` 為允許的六種之一 → `buildReplyPlan` 回傳 `mode: "handoff"` | conversation-state-resolver.ts 約 218–235；reply-plan-builder.ts 約 71–76；routes.ts 約 3932–3984 |

**human_reason 何時被設為 true：**

- **明確要真人**：`HUMAN_REQUEST_PATTERNS` 命中且**不是**純招呼/曖昧短句。  
  - 正則：`/真人|轉人工|不要機器人|找客服|找主管|真人處理|真人客服|人工客服|人呢|能轉人工嗎|我要人工|轉真人|可以幫我轉人工|我要轉人工/i`  
  - 排除：`/^(在嗎|哈囉|嗨|嗯|好|喔|太誇張了|太扯了|等一下|有人嗎|人呢|喂)$/i`  
  - **注意**：「人呢」在正則裡會命中 HUMAN_REQUEST_PATTERNS，但又被 PURE_GREETING_OR_VAGUE 排除；若排除表漏列或邊界 case，可能誤判。
- **complaint / high_risk 情緒**：`primary_intent === "complaint"` 或 `customer_emotion === "high_risk"`（消保官、檢舉、詐騙、公開、發文、再不處理、提告、投訴、消保、媒體、爆料）。
- **明確堅持退款退貨**：`INSIST_REFUND_PATTERNS`（我就是要退、直接幫我退、不要其他方案 等）。

**本輪為「AI 可處理意圖」時會清掉 needs_human：**  
`order_lookup`、`link_request`、`product_consult`、`price_purchase`、`smalltalk`、`unclear` → 不沿用前輪 handoff，所以理論上「只說查訂單」不會被 state 設成轉真人。

---

### 4. LLM 內（工具 transfer_to_human）

| 來源 | 條件 | 位置 |
|------|------|------|
| **AI 呼叫 transfer_to_human** | 工具定義限定六種原因：explicit_human_request、legal_or_reputation_threat、payment_or_order_risk、policy_exception、repeat_unresolved、return_stage_3_insist | routes.ts 約 5290–5382 |

若 AI 過度解讀（例如把「查訂單」「等太久」都當成要轉真人），就會**一直**寫入 needs_human=1；後續每則訊息可能再觸發「post-handoff 強制告知句」。

---

### 5. LLM 回覆之後（Post-handoff 強制告知句）

| 來源 | 條件 | 位置 |
|------|------|------|
| **已轉真人或靜音** | LLM 回覆完後，若 `finalContact.needs_human` 或 `status === awaiting_human | high_risk` 或 `isAiMuted`，**再送一則** handoff 強制告知句 | routes.ts 約 4429–4471 |

**止血邏輯：**  
若本輪 `state.primary_intent` 屬於 `AI_HANDLABLE_INTENTS`（例如 order_lookup），則 `shouldSkipPostHandoff = true`，**不會**再補這句。  
所以若 AI 在「查單」情境**誤呼叫** transfer_to_human，會把 needs_human 設成 1，但本輪意圖仍是 order_lookup 時會跳過 post-handoff；若意圖被判成別的，就會再送一次「已轉專人」，客人會覺得「又轉真人了」。

---

## 三、可能打架／過度轉真人的原因

1. **關鍵字過寬**  
   - 後台 `human_transfer_keywords` 若含「人工」「客服」等短詞，只要句子裡出現就會觸發（LINE/FB 都用 `text.includes(kw)`），例如「想找人工查訂單」會直接轉。

2. **State：明確要真人 vs 查單**  
   - 同一句同時有「轉人工」與「查訂單」時，`detectPrimaryIntent` 的**順序**是：先判 human_request（HUMAN_REQUEST_PATTERNS），再判 order_lookup。  
   - 所以「我要查訂單可以轉人工嗎」會先被當成 human_request → needs_human=true → handoff，不會走查單。若希望「以查單為主、轉人工為輔」，需要調整優先順序或加例外。

3. **尷尬／重複門檻**  
   - `sameDataAskedTwice` 已改為 **≥3 次** 才轉；若門檻再降回 2，會更容易轉真人。

4. **已給過未找到**  
   - 用戶說「我給過了」但三層搜尋沒找到（例如訂單編號在更早的對話、或圖片辨識沒撈到），就會直接轉真人；若三層搜尋太嚴格或漏撈，會增加轉真人次數。

5. **AI 過度呼叫 transfer_to_human**  
   - Prompt 雖限定六種原因，若模型仍對「查不到訂單」「等很久」等呼叫轉人工，會反覆寫入 needs_human=1，後續每輪可能再觸發 post-handoff 或 gate 跳過 AI。

6. **Gate：needs_human=1 時放行查單**  
   - 目前邏輯：若 contact 已是 needs_human=1，但**本輪**是查單意圖（ORDER_LOOKUP_PATTERNS 或 我要查訂單/查訂單/想查訂單…），會**放行**跑 AI 查單，不直接跳過。  
   - 若意圖辨識不穩（例如沒判成 order_lookup），就會變成「needs_human=1 → 跳過 AI → 不回覆或只送 handoff」，客人會覺得一直被轉真人。

7. **FRUSTRATED_ONLY 不應觸發短路**  
   - 「爛、很煩、很慢、不爽…」等只會標成 frustrated_only，**不會** legal_risk 短路，這部分已拆級，不會因情緒詞就轉。

---

## 四、建議排查順序（一直轉真人時）

1. **看日誌**  
   - 搜尋 `needs_human=1 source=`，確認是哪一個來源：`webhook_keyword` / `high_risk_short_circuit` / `awkward_repeat` / `state_resolver` / `already_provided_not_found` / `handoff_short_circuit` / `gate_skip:needs_human`。

2. **檢查後台設定**  
   - `human_transfer_keywords` 是否過長或含短詞（如「人工」「客服」），若有先收緊為完整短語（如「我要轉人工」「找真人客服」）。

3. **檢查 state 與意圖**  
   - 若多數是 `state_resolver` 或 `handoff_short_circuit`，看該則用戶訊息是否被誤判為 human_request 或 complaint；必要時收緊 HUMAN_REQUEST_PATTERNS 或調整 intent 優先順序（例如查單優先於轉人工）。

4. **檢查 AI 是否常呼叫 transfer_to_human**  
   - 看 ai_log 或 tool_called 是否常有 `transfer_to_human`；若有，加強 prompt「查單／久候先查詢或安撫，勿未查就轉人工」。

5. **已給過轉真人**  
   - 若常出現 `already_provided_not_found`，可檢查三層搜尋的範圍（則數、圖片 vision、linked order）是否過窄或漏撈。

---

## 五、關鍵程式行號速查（routes.ts）

| 情境 | 約略行號 |
|------|----------|
| LEGAL_RISK_KEYWORDS / FRUSTRATED_ONLY_KEYWORDS | 166–175 |
| detectHighRisk | 189–204 |
| 高風險短路（legal_risk）轉人工 | 3720–3755 |
| Gate：needs_human=1 放行查單意圖 | 3654–3684 |
| 尷尬／重複轉人工 | 3880–3924 |
| plan.mode === "handoff" 短路（只送一句） | 3932–3984 |
| 已給過未找到轉人工 | 4102–4145 |
| Post-handoff 強制告知句（含 shouldSkipPostHandoff） | 4429–4471 |
| LINE HUMAN_KEYWORDS 與關鍵字判 | 4632–4636, 4712–4722 |
| FB HUMAN_KW2 與關鍵字判 | 4969–4972, 5109–5121 |
| transfer_to_human 工具定義與處理 | 5290–5382 |

---

以上為目前與「轉真人」有關的檔案與觸發條件總表；若某幾條規則重疊或門檻過鬆，就容易出現「一直轉真人」的體感。
