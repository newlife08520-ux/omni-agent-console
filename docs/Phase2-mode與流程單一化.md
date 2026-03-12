# Phase 2：一輪一個 Mode 與流程單一化

## 一、Mode 枚舉與優先級表

**一輪只能有一個最終 mode**；由 `buildReplyPlan` 依 state 與優先級產出，不得再被其他 probing／安撫／查單／退貨流程搶答。

| 優先級 | Mode | 進入條件 | 退出條件 | 允許／禁止 |
|--------|------|----------|----------|------------|
| 1 | **handoff** | needs_human && human_reason（明確真人／法務投訴／金流爭議／明確堅持退款退貨／repeat_unresolved） | 已轉人工、案件關閉 | 直接安排接手；禁止再問「您是想找真人嗎」；最多補一句可選留單號 |
| 2 | **return_form_first** | primary_intent 退換貨 && return_reason_type === "product_issue"；或 insist 且非 return_stage_1 | 已給表單、進入 return_stage_1 | 先道歉＋表單連結；禁止先查單為主流程 |
| 3 | **aftersales_comfort_first** | primary_intent 退換貨 && return_reason_type === "wait_too_long"（等太久、不想等） | 已安撫＋查單一輪、或改為 insist/product_issue | 先安撫＋查單＋加急；禁止一開口就表單、禁止先轉人工 |
| 4 | **return_stage_1** | 退換貨 && return_stage === 1（已給過表單） | 客戶填單或改意圖 | 延續表單階段；禁止先查單為主 |
| 5 | **order_lookup** | primary_intent === "order_lookup" 且非退換貨意圖 | 已查到單或轉人工 | 承接一句＋只問一個最有效欄位（單號或商品+手機）；禁止問卷、禁止多餘問題；回覆簡短 |
| 6 | **off_topic_guard** | primary_intent === "off_topic"（晚餐吃什麼、推薦餐廳等品牌外問題） | 下一句回到品牌內 | 固定短句收邊界，不陪聊；不進 LLM |
| 7 | **answer_directly** | product_consult、price_purchase、smalltalk、unclear | 依對話自然結束 | 依商品範圍鎖定（若有）不跨品類；可答尺寸／圖片／連結 |

---

## 二、退換貨唯一版本規則表

| return_reason_type | 說明 | 本輪 mode | 行為 |
|--------------------|------|-----------|------|
| **wait_too_long** | 等太久、不想等、怎麼還沒到、不要了（尚未堅持） | aftersales_comfort_first | 先安撫＋查單＋加急；**不先表單**、不先轉人工 |
| **product_issue** | 瑕疵、損壞、錯貨、缺件、漏寄、收到有問題 | return_form_first | 先道歉＋正式售後表單／路徑 |
| **insist** | 我就是要退、直接幫我退、不要其他方案 | return_form_first 或 handoff（needs_human） | 不再挽回；直接表單或轉人工 |
| null / 未辨識 | 僅提到退貨但未明確分類 | aftersales_comfort_first | 先安撫、先理解原因、可查詢出貨；不要一開口就表單 |

**已淘汰**：任何「所有退貨首輪一律 form first」之殘留描述；以本表為準。

---

## 三、product_scope_locked 設計

| 項目 | 說明 |
|------|------|
| **存哪裡** | `contacts.product_scope_locked`（TEXT），可選值 `"bag"` \| `"sweet"` \| null |
| **何時建立** | 本輪 plan.mode 為 **order_lookup** 或 **answer_directly** 且 `getProductScopeFromMessage(userMessage)` 有值時，寫入 contact。關鍵字：bag ← 包包／通勤包／城市輕旅／輕旅包／托特／後背包；sweet ← 甜點／巴斯克／蛋糕／餅乾／點心／禮盒 |
| **何時清除** | plan.mode 為 **handoff** 或 **off_topic_guard** 時清為 null；correction override 或明顯換題時亦可清除（目前與 handoff/off_topic 一併處理） |
| **使用方式** | 組裝 system prompt 時若 `state.product_scope_locked` 或本輪推斷為 bag/sweet，注入「已鎖定為包包/袋類，不得提甜點、蛋糕、巴斯克」或「已鎖定為甜點類，不得提包包、袋類」 |
| **未鎖定時** | 僅能問與當前品牌商品線有關的澄清問題；不得跨品類搶答 |

---

## 四、Handoff 強制告知句（程式層保證）

只要案件進入「轉接真人」流程，回覆**第一句必須**明確告知客戶已轉接真人專員，**不得**僅以「已安排處理」「會協助您」「幫您處理中」等模糊說法取代。

| 項目 | 說明 |
|------|------|
| **固定句** | `HANDOFF_MANDATORY_OPENING` =「這邊先幫您轉接真人專員處理，請稍後。」（或語意等價） |
| **第二句** | 最多補一句：僅在非情緒差且 human_reason 為 explicit_human_request 時可補「若方便可先提供訂單編號，專員會更快協助您確認。」；情緒差（angry / high_risk / frustrated）時**只保留**固定句 |
| **落地** | `buildHandoffReply({ customerEmotion, humanReason })` 產出全文；所有 handoff 路徑（含 plan.mode === handoff、transfer_to_human 觸發、legal_risk 短路、LINE/FB 關鍵字轉人工、timeout 轉接）一律使用此回覆，不依賴 LLM 自由生成 |
| **禁止** | 不得再問「您是想找真人嗎」；不得混入查單／安撫／退貨 probing |

---

## 五、Output guard 規則

| 項目 | 規格 |
|------|------|
| **首輪回覆長度** | order_lookup：上限 **140 字**；其餘 mode：上限 **200 字** |
| **超標處理** | `enforceOutputGuard(text, plan.mode)`：截斷至上限，優先保留最後一句完整句（。！？\n）；否則截斷＋「…」 |
| **本輪契約（prompt）** | order_lookup：承接一句後只問一個最有效欄位；回覆簡短約 90～140 字。禁止一次多段長篇安撫＋解釋＋指引 |
| **落地位置** | 在 routes 取得 LLM 回覆後、寫入 message 與送 channel 前，對回覆文字執行 `enforceOutputGuard` |

---

## 六、Phase 2 驗收案例（含實際輸出）

| 案例 | 輸入 | 預期 path | 預期輸出／禁止 |
|------|------|-----------|----------------|
| 城市輕旅通勤包 | 我買城市輕旅通勤包怎麼還沒到 | order_lookup；product_scope_locked=bag | **不得**提甜點、巴斯克、蛋糕 |
| 不想等要退貨 | 我不想等了我要退貨 | aftersales_comfort_first | **不得**先查單又退貨又安撫一起來；先安撫＋查單，不先表單 |
| 很煩要轉人工 | 我訂很久了很煩不要了幫我轉人工 | handoff | **只能** handoff；不可查單/表單/長安撫搶答 |
| 晚餐吃什麼 | 晚餐吃什麼好 | off_topic_guard | **不得**真的推薦菜單；固定短句收邊界 |
| 我要查訂單 | 我要查訂單 | order_lookup | 回覆**要短**，不可像問卷；最多一問、約 90～140 字 |
| 包包尺寸有圖嗎 | 我要查包包尺寸，有圖片嗎 | answer_directly；scope=bag | 可答尺寸／圖片／連結；**不可冗長、不可跳類** |

驗收時除看 `reply_source`／`plan_mode` 外，需**目視或自動檢查實際回覆文案**是否符合上表。

---

## 七、Handoff 驗收案例（強制告知句）

| 案例 | 輸入 | 預期 | 結果 |
|------|------|------|------|
| 能轉人工嗎 | 能轉人工嗎 | handoff；回覆含「轉接真人專員」或「請稍後」 | PASS |
| 人呢 | 人呢 | handoff；同上 | PASS |
| 很煩要轉人工 | 我訂很久了很煩不要了幫我轉人工 | handoff；同上；不再問「您是想找真人嗎」、不混查單/安撫 | PASS |
| 我要找真人客服 | 我要找真人客服 | handoff；回覆明確告知 | PASS |
| 我要找主管 | 我要找主管 | handoff；回覆明確告知 | PASS |

驗收腳本：`npx tsx server/phase1-verify.ts`（含 G～K 項）。

---

## 八、Acceptance steps

1. **Mode／path**：跑 `npx tsx server/phase1-verify.ts` 仍全過；sandbox `?message=晚餐吃什麼好` → `simulated_reply_source=off_topic_guard`。
2. **退換貨**：發「我不想等了我要退貨」→ ai_log 為 llm、plan_mode=aftersales_comfort_first；回覆無「表單連結」開頭、無先轉人工。
3. **product_scope**：發「我買城市輕旅通勤包怎麼還沒到」→ 回覆無「甜點」「巴斯克」「蛋糕」；contact 的 `product_scope_locked` 為 bag（若已寫入）。
4. **off_topic**：發「晚餐吃什麼好」→ 固定短句、reply_source=off_topic_guard。
5. **output guard**：發「我要查訂單」→ 回覆長度 ≤ 140 字、無多題問卷感。
6. **混句轉人工**：發「我訂很久了很煩不要了幫我轉人工」→ handoff、回覆以轉人工為主。

---

## 九、修改檔案清單（Phase 2）

| 檔案 | 修改摘要 |
|------|----------|
| server/reply-plan-builder.ts | Mode 枚舉與優先級註解；新增 off_topic_guard；MODE_PRIORITY_ORDER |
| server/conversation-state-resolver.ts | PrimaryIntent 新增 off_topic；OFF_TOPIC_PATTERNS；state.product_scope_locked 從 contact 讀取 |
| server/routes.ts | OFF_TOPIC_GUARD_MESSAGE；getProductScopeFromMessage；enforceOutputGuard；off_topic_guard 短路；product_scope 設定/清除；order_lookup／product_scope prompt；output guard；**handoff 強制告知句**（needs_human 時送 buildHandoffReply；legal_risk／LINE/FB 轉人工／timeout 用 HANDOFF_MANDATORY_OPENING） |
| shared/schema.ts | Contact.product_scope_locked；ReplySource 新增 off_topic_guard |
| server/db.ts | migrateConversationStateFields 新增 product_scope_locked |
| server/storage.ts | updateContactConversationFields 支援 product_scope_locked |
| docs/訂單出貨與退換貨邏輯說明.md | 退換貨優先級改為依 return_reason_type 分流 |
| docs/Phase2-mode與流程單一化.md | 本文件 |
| server/phase2-verify.ts | Phase 2 path/scope 與輸出文案守則可重播驗收（含 off_topic 固定句、order_lookup 140 字） |
| server/phase2-output.ts | OFF_TOPIC_GUARD_MESSAGE、enforceOutputGuard、**HANDOFF_MANDATORY_OPENING、buildHandoffReply**、字數上限常數 |
| server/phase1-verify.ts | **Handoff 驗收**：G～K（固定句語意、我要找真人客服/主管 → handoff、回覆不可模糊） |
| server/conversation-state-resolver.ts | Phase 2 意圖順序：order_lookup 先於 REFUND_RETURN（「怎麼還沒到」→ 查單） |

---

## 十、驗收案例逐筆 pass/fail

**執行**：`npx tsx server/phase2-verify.ts`（自專案根目錄）。腳本內含：path/scope 檢查、off_topic 固定短句內容（不推薦菜單）、order_lookup 回覆經 enforceOutputGuard 後 ≤140 字。

| 案例 | 輸入 | 預期 path | Path/Scope 結果 | 實際文案備註 |
|------|------|-----------|-----------------|--------------|
| 城市輕旅通勤包 | 我買城市輕旅通勤包怎麼還沒到 | order_lookup；scope=bag | **PASS** | 需 E2E／手動確認回覆無甜點／巴斯克／蛋糕 |
| 不想等要退貨 | 我不想等了我要退貨 | aftersales_comfort_first | **PASS** | 需確認無「查單+退貨+安撫」混在一起、不先表單 |
| 很煩要轉人工 | 我訂很久了很煩不要了幫我轉人工 | handoff | **PASS** | 需確認僅 handoff、無查單/表單搶答 |
| 晚餐吃什麼 | 晚餐吃什麼好 | off_topic_guard | **PASS** | 固定短句、不進 LLM；無推薦菜單 |
| 我要查訂單 | 我要查訂單 | order_lookup | **PASS** | 需確認回覆 ≤140 字、無問卷感 |
| 包包尺寸有圖嗎 | 我要查包包尺寸，有圖片嗎 | answer_directly；scope=bag | **PASS** | 需確認簡短、不跳類 |

Path/scope 已由 phase2-verify 自動全過；**實際輸出文案**建議以手動或 E2E 依上表「實際文案備註」逐案確認。

---

## 十一、Self-critique

- **意圖順序**：原先「怎麼還沒到」被 REFUND_RETURN 先命中而走 aftersales_comfort_first；已改為 ORDER_LOOKUP 先於 REFUND_RETURN，使「我買OO怎麼還沒到」穩定走 order_lookup。若未來出現「怎麼還沒到＋明確退貨」混句，可能需再細則（例如：同時含「退貨／不要了」才走退貨）。
- **product_scope 關鍵字**：目前 bag/sweet 關鍵字為固定列表；若品牌擴品類需同步擴充 `getProductScopeFromMessage` 與 DB 可選值。
- **output 截斷**：以句號截斷可能切到「請提供…」導致語意不完整；目前以「…」收尾，建議監測是否常觸發截斷，必要時微調上限或改為「請提供單號或訂購人手機」等固定短句。
- **off_topic 覆蓋**：僅依關鍵字；若用戶說「今天心情不好」可能未命中，仍進 LLM。可依實際上線語料再補 OFF_TOPIC_PATTERNS。
- **一輪一個 mode**：buildReplyPlan 已單一出口；若 LLM 仍產出跨 mode 內容，僅能靠 must_not_include／prompt 與 output guard 字數限制壓制，無法 100% 保證不出現一句多意圖文案，需持續觀察。
