# Phase 32 Bug-ticket Mode 報告

## 目標

本輪改為 **bug-ticket mode**：每張 ticket 對應一個可驗證的 runtime 問題，不做大而泛的 phase 擴充。信任恢復項目共 10 張 ticket，依 P0 → P1 → P2 完成。

---

## Ticket 1：官網偏好殘留（Shopline sticky preference）

### 症狀
對話先說「官網 0910...」，下一句改傳另一支手機或「不是官網的」，系統仍回「這支手機（官網）目前查無訂單紀錄」。

### 根因
`shouldPreferShoplineLookup(userMessage, recentUserMessages)` 把 recent 直接串起來判斷，前幾句出現「官網」後續就持續 prefer shopline，且無負向語句處理。

### 修改檔案
- `server/order-lookup-policy.ts`：新增 `resolveOrderSourceIntent(currentMessage, recentMessages)`，回傳 `"shopline" | "superlanding" | "unknown"`。支援負向語句（不是官網、不是網站買的、粉專買的、一頁買的）→ `unknown`。純手機或僅數字時不繼承 recent 的官網意圖。
- `server/order-service.ts`：`shouldPreferShoplineLookup` 改為薄封裝 `resolveOrderSourceIntent(..., []) === "shopline"`，不再用 recent 無限污染。
- `server/order-fast-path.ts`：`preferShop` / `preferSl` 改為依 `resolveOrderSourceIntent(msg, recentUserMessages)`，不再用 `recentUserMessages.slice(-3)` 判斷官網／一頁。
- `server/routes.ts`：tool 的 `preferShopline` 仍經 `shouldPreferShoplineLookup`（已改為用 resolver），故行為一致。

### 驗收
- 先輸入「官網 0910022130」→ 再輸入「0963187463」→ 最後一次不得帶 `(官網)`，source intent 為 unknown。
- 再輸入「不是官網的」→ source intent 應為 unknown。
- `npm run verify:phase32` 行為級：`resolveOrderSourceIntent("不是官網的", []) === "unknown"`，`resolveOrderSourceIntent("0963187463", ["官網 0910022130"]) === "unknown"`。

---

## Ticket 2：phone-only policy reset

### 症狀
只看到手機就直接查、看到 1 筆就當答案、不先問商品名。

### 目標政策
有訂單號直接查；無訂單號時一般查單要「商品名＋手機」；純手機僅在「我有幾筆／全部訂單／還有其他訂單嗎」時受理；純手機命中 1 筆且 `data_coverage === "local_only"` 不可直接定案。

### 修改檔案
- 延續 Phase 31：`server/order-lookup-policy.ts`（`deriveOrderLookupIntent`、`allowPhoneOnly`/`requiresProduct`）、`server/order-fast-path.ts`（純手機未 allowPhoneOnly 時回 ask_for_identifier）、`server/routes.ts`（ORDER_LOOKUP_RULES 與 tool 單筆 local_only 時 noSingleClaim）。

### 驗收
- 「我要查訂單」→「0912345678」→ 應要求商品名＋手機或只回摘要，不得直接把單筆當唯一答案。
- phase32-verify 行為級：純手機意圖 `requiresProduct=true`、`allowPhoneOnly=false`。

---

## Ticket 3：local-only / partial local hit guard

### 症狀
本地 index 命中 1 筆就直接回，未再 live API confirm，同手機多筆只列一筆。

### 修改檔案
- 延續 Phase 31：`server/order-service.ts`（`UnifiedOrderResult` 含 `coverage_confidence`、`needs_live_confirm`；local_only 單筆設 `needs_live_confirm: true`）。`server/order-fast-path.ts`（`isLocalOnlySingle || needsConfirm` 時回「目前從已同步資料先看到 1 筆…」不直接定案）。`server/routes.ts`（單筆時 `noSingleClaim = isLocalOnly`，不依 feature flag）。

### 驗收
- local_only 單筆回覆帶說明「目前先看到 1 筆，再幫您確認是否還有其他單」或補問。
- phase31 / phase32 verify 通過。

---

## Ticket 4：same-page / phone 查單完整性

### 症狀
同 page、同手機，多日視窗（如 3 天前＋22 天前）只回一筆。

### 根因
先前 `lookupOrdersByPageAndPhone()` 可能首窗命中即早退；已有多視窗合併，但缺少可觀測 log。

### 修改檔案
- `server/superlanding.ts`：在 dateWindows 迴圈內加入可觀測 log：`page_phone_window=${window.days} window_hits=... cumulative_unique_hits=...`，便於 runtime 確認多視窗合併結果。

### 驗收
- 多視窗路徑無「首窗命中即 return」；log 可見 window_hits / cumulative_unique_hits。
- phase32-verify 靜態檢查 `page_phone_window=`、`cumulative_unique_hits` 存在，且無首窗早退 regex。

---

## Ticket 5：active order 切換與清理

### 症狀
客戶說「我要查別筆、換一筆、不是這筆、我有其他訂單嗎」時系統仍沿用上一筆 active order。

### 修改檔案
- `server/routes.ts`：擴充 `CLEAR_ACTIVE_ORDER_KW`，新增「換另一筆、查另一張、另外一筆、不是這張、重查一下」等關鍵字，收到即清除 active order context。

### 驗收
- 輸入上述關鍵字後 active context 被清除，下次查單不沿用舊 selected order。
- phase32-verify 靜態檢查 CLEAR_ACTIVE_ORDER_KW 含「換另一筆」「不是這張」「重查一下」等。

---

## Ticket 6：商品明細與產品格式

### 症狀
前台可能出現 raw JSON 商品列表。

### 修改檔案
- 延續既有：`server/order-reply-utils.ts` 之 `formatProductLinesForCustomer` 與 `formatOrderOnePage`（內含商品行人類可讀輸出）。fast path、tool path、routes 皆經 `formatOrderOnePage`，不直出 `product_list` JSON。

### 驗收
- 對客輸出不得含 `[{"code":`、`"qty":` 等 raw JSON 片段。
- phase32-verify 檢查 formatOrderOnePage 使用 formatProductLinesForCustomer。

---

## Ticket 7：官網查不到的真相拆解

### 說明
建議新增 admin debug endpoint／UI：品牌 shopline 是否配置、最後一次 API 是否成功、preferSource、local/api 命中筆數。官網查單回覆可帶 debug-safe 摘要僅進 ai_log。本輪已具 `resolveOrderSourceIntent` 與 tool 的 preferSource，debug endpoint 可後續補上。

---

## Ticket 8：前端部署一致性與 SSE / polling

### 說明
chat 頁需有 debug badge（SSE/polling、build hash、flags），`VITE_DISABLE_SSE=1` 時不建立 EventSource。phase32-verify 靜態檢查前端具連線狀態可觀測與 VITE_DISABLE_SSE 讀取。

---

## Ticket 9：Bundle 安全

### 修改檔案
- 延續 Phase 31：`scripts/export-ai-bundle-context.mjs` 預設 redact 敏感鍵、mask PII；`scripts/verify-bundle-safety.mjs` 與 `npm run verify:bundle-safety` 已存在。

### 驗收
- `npm run verify:bundle-safety` 通過。

---

## Ticket 10：Verify 改成行為級

### 修改檔案
- `server/phase32-verify.ts`：含 Ticket 1 負向/純手機行為、Ticket 4 多視窗 log 與無早退、Ticket 5 CLEAR 關鍵字、Ticket 6 商品格式、Ticket 8 前端 flag、Ticket 9 bundle；並行為級檢查純手機意圖 `requiresProduct=true`、`allowPhoneOnly=false`。

### 驗收
- `npm run verify:phase32` 完整通過。

---

## 交付清單

- [x] 本報告 `docs/PHASE32_BUG_TICKET_REPORT.md`
- [x] `docs/PHASE32_RUNTIME_EVIDENCE.md`
- [x] `docs/PHASE32_DEPLOYMENT_PARITY_CHECKLIST.md`
- [x] `npm run verify:phase32` 可執行並通過
- [ ] 最新 SOURCE ZIP（需於產出 bundle 後附上）
