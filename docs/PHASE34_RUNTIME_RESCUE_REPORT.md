# Phase 34 — 人格／查單政策 Runtime Rescue（Ticket 34-1～34-5）

**人格單一真相（repo 內）：** `docs/persona/全區域人格設定.txt`、`docs/persona/ai客服人格.txt`

**驗證：** `npm run verify:phase34`（含 verify:phase33 鏈與 `server/phase34-verify.ts`）

---

## 附錄：Code Audit 五項補強（與 Phase34_CODE_AUDIT_AND_FIX_NOTES 對齊）

| 項目 | 作法 |
|------|------|
| **local_only 單筆文案** | `routes.ts`：`data_coverage=local_only` 時僅拼接 `singleDeterministicOnePage`（`formatOrderOnePage`），前置「目前僅從已同步資料…」；**不出現**「我查到這筆了，內容如下：」。 |
| **付款／配送對客映射** | `order-reply-utils.ts`：`displayPaymentMethod`、`displayShippingMethod`；`formatOrderOnePage` 與確定性追問配送行皆經映射，**不對客輸出** `pending` / `to_store` / `credit_card` 等 raw。 |
| **一頁 payment_status_raw** | `superlanding.ts`：`deriveSuperlandingPaymentStatusRaw()` 彙整 `system_note`、常見 gateway 欄位、`order.status` 等；**不再**把 `payment_method` 當成唯一的 `payment_status_raw`。 |
| **長數字官網單號** | `order-service.ts`：`preferSource === "shopline"` 且單號為 **15～22 位純數字**時，Shopline 查無則 **shopline-only**（不回落一頁）。 |
| **品牌 delay 覆蓋面** | `routes.ts`：`planAllowsActiveOrderDeterministic()` 含 `order_lookup`、`order_followup`、`answer_directly`、`aftersales_comfort_first` 等；`order-fast-path.ts` 同步擴充可觸發 `buildDeterministicFollowUpReply` 的 `planMode`。 |

---

## Ticket 34-1 — 查單來源意圖 TTL（不永久污染）

| 項目 | 內容 |
|------|------|
| **Root cause** | `detectLookupSourceIntent` 讀取 `recentMessages` 過多則（先前 `slice(-2)`），導致較舊的「官網」語句仍影響後續僅手機等訊息，違反「只繼承上一則」的人格／決策樹。 |
| **改了哪些檔** | `server/order-lookup-policy.ts`（recent 改為 `slice(-1)`） |
| **Verify** | `phase34-verify`：純手機＋`["官網買的","好的收到"]` 仍為 `unknown`；`查訂單`＋僅最後一則為 `官網買的` 時繼承 `shopline`。 |
| **手動重現案例** | 對話：(1) 使用者「官網買的」(2)「好的收到」(3) 僅傳 `0912345678` → 不應被視為強制官網管道；若 (2) 改為「官網買的」且 (3)「查訂單」→ 可繼承官網意圖。 |

---

## Ticket 34-2 — 官網長純數字單號（15～22 位）

| 項目 | 內容 |
|------|------|
| **Root cause** | Fast path 僅允許 5～14 字元單號，SHOPLINE 長數字單號無法走查單捷徑；`deriveOrderLookupIntent` 亦需辨識為 `order_id_direct`。 |
| **改了哪些檔** | `server/order-fast-path.ts`（`isLineMostlyOrderId`、`extractLongNumericOrderIdFromMixedSentence`、`preferSourceForOrderIdLookup`）、`server/order-lookup-policy.ts`（`extractOrderId` 含長數字／混合句） |
| **Verify** | `phase34-verify`：`deriveOrderLookupIntent(longId)` 為 `order_id_direct`；混合句擷取長數字；原始碼含 `preferSourceForOrderIdLookup` 且長數字預設 `shopline`。 |
| **手動重現案例** | 查單模式傳入整行 `1234567890123456789`（19 位）→ 應觸發 `lookup`/fast path；「請查 1234567890123456789 謝謝」→ 混合擷取；句內含「團購」→ 偏好一頁管道。 |

---

## Ticket 34-3 — `local_only` 單筆不可用「幫您查到了」定案

| 項目 | 內容 |
|------|------|
| **Root cause** | 若僅本地索引命中單筆即使用最終語氣，易與「尚未 API 全量確認」衝突。 |
| **改了哪些檔** | `server/order-fast-path.ts`（`isLocalOnlySingle` 分支使用「目前從已同步資料先看到…」）、`server/routes.ts`（`<ORDER_LOOKUP_RULES>` 明確禁止 local_only 單筆以「幫您查到了」當最終結論） |
| **Verify** | `phase34-verify`：掃描 `order-fast-path.ts` 與 `ORDER_LOOKUP_RULES` 關鍵字。 |
| **手動重現案例** | 手機查單僅回傳 1 筆且 `data_coverage=local_only` → 客戶端文字應含「目前從已同步資料先看到 1 筆…」，不可單用「幫您查到了」作唯一結論。 |

---

## Ticket 34-4 — 付款失敗對客標籤與訊號

| 項目 | 內容 |
|------|------|
| **Root cause** | 狀態列缺少「訂單未成立／紅叉」等關鍵字時易漏判 failed；對客標籤需與人格一致（失敗＝未成立）。 |
| **改了哪些檔** | `server/order-payment-utils.ts`（`PAYMENT_FAIL_STATUS_KW` 擴充、`failed` 標籤改為「付款失敗／訂單未成立」） |
| **Verify** | `phase34-verify`：`derivePaymentStatus(..., "訂單未成立（紅叉）", "superlanding")` 為 `failed` 且 label 同時含「付款失敗」「訂單未成立」。 |
| **手動重現案例** | 一頁商店 LINE Pay、`payment_status_raw=failed`、狀態描述含「訂單未成立（紅叉）」→ 應顯示合併標籤，不得誤判為一般待付款。 |

---

## Ticket 34-5 — 久候／出貨追問品牌話術＋確定性追問

| 項目 | 內容 |
|------|------|
| **Root cause** | 確定性追問未帶人格檔的 5 工作天／7–20 工作天模板；`PHASE24` 禁用句含與品牌道歉衝突之句型；`routes`/fast path 未傳使用者句給 `buildDeterministicFollowUpReply`。 |
| **改了哪些檔** | `server/order-reply-utils.ts`（`buildDeterministicFollowUpReply(ctx, userMessage?)`、品牌模板、從 `PHASE24_BANNED_DETERMINISTIC_PHRASES` 移除衝突句）、`server/order-fast-path.ts`（追問傳 `msg`）、`server/routes.ts`（短路傳 `msgTrimShort`） |
| **Verify** | `phase24-verify` + `phase34-verify`：久候句觸發模板且不含剩餘禁用句；COD 追問仍正確。 |
| **手動重現案例** | 已有 active order、狀態待出貨、使用者問「什麼時候會出貨」→ 回覆應含 5 個工作天／7–20 個工作天與不加亂保證之表述；COD 問出貨應說明非付款失敗。 |

---

## 附錄：`phase34-verify.ts` 修復紀錄

- `deterministicReplyHasBannedPhrase(delayReply!)`：滿足 `tsc` 對 `string | null` 參數之檢查（`delayReply` 已由 `assert` 保證非空）。
