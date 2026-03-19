# Phase 32 Runtime 證據

本文件記錄 Phase 32 bug-ticket 對應的 runtime 可驗證行為與日誌證據。

---

## 1. 官網偏好不殘留（Ticket 1）

### 預期行為
- 使用者輸入「官網 0910022130」後，再輸入「0963187463」或「不是官網的」時，查單 **不得** 使用 `preferSource: "shopline"`，回覆不得出現「（官網）」。
- 日誌中不應出現 `[AI Tool Call] 官網查單：優先 SHOPLINE` 當最後一則使用者訊息為純手機或負向語句時。

### 驗證方式
- 執行 `npm run verify:phase32`，行為級檢查：
  - `resolveOrderSourceIntent("不是官網的", []) === "unknown"`
  - `resolveOrderSourceIntent("0963187463", ["官網 0910022130"]) === "unknown"`
- 手動：依序送「官網 0910…」→「0963…」→ 檢查該輪 tool 呼叫之 context 無 `preferShopline: true`（或等同 preferSource 不為 shopline）。

---

## 2. phone-only 不直接單筆定案（Ticket 2）

### 預期行為
- 僅傳手機號且意圖非「全部訂單／其他訂單」時，系統應要求「商品名＋手機」或回摘要，不直接回單筆完整訂單為唯一答案。
- 若為 local_only 單筆，回覆應含「目前從已同步資料先看到 1 筆…」或「再幫您確認是否還有其他單」。

### 驗證方式
- `npm run verify:phase32` 行為級：`deriveOrderLookupIntent("0912345678", [], null)` 之 `requiresProduct === true`、`allowPhoneOnly === false`。
- 手動：送「我要查訂單」→「0912345678」，預期不應直接得到單筆完整訂單當唯一答案（應為補問或帶說明之摘要）。

---

## 3. local_only 單筆 guard（Ticket 3）

### 預期行為
- `UnifiedOrderResult` 當 `data_coverage === "local_only"` 且 `orders.length === 1` 時，`needs_live_confirm === true`。
- fast path 與 tool path 單筆 local_only 時，對客回覆帶說明，不單筆定案。

### 驗證方式
- `npm run verify:phase31`、`npm run verify:phase32` 通過。
- 日誌可搜尋 `data_coverage=local_only`、`needs_live_confirm` 確認回傳結構。

---

## 4. same-page 多視窗不漏單（Ticket 4）

### 預期行為
- `lookupOrdersByPageAndPhone()` 在 totalEntries > 3000 時走多日期視窗合併，**不在單一視窗命中後早退**，最終回傳為多視窗去重後的合併結果。
- 日誌出現可觀測：`page_phone_window=7` / `30` / `90` / `365`、`window_hits=...`、`cumulative_unique_hits=...`。

### 驗證方式
- `npm run verify:phase32` 靜態：superlanding 含 `page_phone_window=`、`cumulative_unique_hits`，且無首窗早退之 regex。
- 若具備測試環境：同一 page、同一手機、兩筆訂單分別落在 7 天與 30 天視窗，預期回傳 2 筆，且 log 可見兩次 window 的 cumulative_unique_hits 遞增。

---

## 5. active order 切換（Ticket 5）

### 預期行為
- 使用者輸入「換另一筆」「查另一張」「不是這張」「重查一下」等關鍵字後，`storage.clearActiveOrderContext(contactId)` 被呼叫，下一輪查單不沿用舊 selected order。

### 驗證方式
- phase32-verify 靜態：routes 之 CLEAR_ACTIVE_ORDER_KW 含上述關鍵字。
- 手動：先查出一筆並產生 active context，再送「換另一筆」或「重查一下」，下一句查單應重新跑 lookup，而非沿用前一筆。

---

## 6. 商品明細無 raw JSON（Ticket 6）

### 預期行為
- 對客回覆之訂單內容一律經 `formatOrderOnePage` → `formatProductLinesForCustomer`，輸出不應含 `[{"code":`、`"qty":` 等 raw JSON 片段。

### 驗證方式
- phase32-verify 靜態：order-reply-utils 之 formatOrderOnePage 使用 formatProductLinesForCustomer，且輸出含「商品：」人類可讀格式。
- 手動：查單回覆檢視商品欄位為「品名 × 數量」格式，無 JSON 字串。

---

## 7. Bundle 安全（Ticket 9）

### 預期行為
- `node scripts/export-ai-bundle-context.mjs <out.json>` 產出之 JSON 不含 raw API key、token、密碼；電話／email 等 PII 已遮罩。

### 驗證方式
- `npm run verify:bundle-safety` 通過。
- 開啟產出 JSON，確認 `settings_ai_related` 中敏感鍵為 `[REDACTED]`，電話為遮罩格式。

---

## 8. verify:phase32 完整輸出

執行下列指令應全部通過並無錯誤：

```bash
npm run check:server
npm run verify:phase32
```

預期最後一行為：`[phase32-verify] OK — Tickets 1–10 靜態與行為級檢查通過`。
