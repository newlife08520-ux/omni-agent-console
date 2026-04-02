# VERIFY_TRUTH_MATRIX.md

**基準日**：2026-04-02。依 **現行原始碼**（`prompt-builder.ts`、`routes.ts` 拆分、`ai-reply.service.ts`、`phase*-verify.ts`）與 **實際執行 exit code** 交叉判定。  
**說明**：本表區分「護欄意圖是否仍合理」與「verify 腳本是否仍與 repo 結構對齊」；兩者不同步時標為 **uncertain** 或 **obsolete（測試過時）**。

---

## 總表

| verify 名稱 | 原始目的 | 現在是否仍有效 | fail 原因（實測） | 是否 blocking | 建議動作 |
|-------------|-----------|----------------|-------------------|---------------|-----------|
| phase25-verify.ts | 查單 prompt **極瘦**（無 CATALOG／KNOWLEDGE／IMAGE）、`prompt_profile` 命名、付款／日期／multi pack／routes 關鍵字 | **意圖 active**；**腳本部分 obsolete** | 第一個斷言：`assembleEnrichedSystemPrompt(..., order_lookup)` 的 `prompt_profile` 已改為 **`order_lookup_prompt_diet`**，不再等於 `order_lookup_ultra_lite`（見 `prompt-builder.ts` 約 L271） | **否**（產品行為仍可有 diet；壞的是測試字串） | **fix** verify 改期待值為 `order_lookup_prompt_diet`／`order_followup_prompt_diet`（或與現行 enum 對齊）；**或** **retire** 本檔若改由 phase34＋單元測試覆蓋 |
| phase26-verify.ts | 同上 ultra-lite profile、長度 &lt;1200、routes 內 latency／ai_log 關鍵字、normalizer、deterministic 契約 | **意圖 active**；**腳本部分 obsolete** | 與 phase25 相同：**`prompt_profile` 名稱**不符；且它讀 **`server/routes.ts`** 找 `deterministic_tool_reply_selected` 等——大量邏輯已拆到 **`routes/core.routes.ts` + `ai-reply.service.ts`**，靜態字串搜 `routes.ts` **易假陰／假陽** | **否** | **replace**：改讀 `core.routes.ts`／`ai-reply.service.ts` 或改為行為測試；**fix** profile 斷言 |
| phase27-verify.ts | Launch gating：契約、fast path、**ai_log telemetry**、latency parser、**multi_order_router vs active_order** 字串、ultra-lite 模組 | **混合** | 前半多項仍通過；**FAIL：`multi vs active renderer`**——`phase27-verify` 要求原始碼同時含 `reply_renderer: "multi_order_router"` 與 **`reply_renderer: "active_order_deterministic"`**。現況 **僅** `multi_order_router`（及 `phase29_more_orders_expand` 等）出現在 **`ai-reply.service.ts`**，**全 repo 無** `active_order_deterministic` 字串（已移除或從未在現分支） | **否**（除非營運仍要求「active deterministic」renderer 名必須存在） | **fix** verify：刪除對已退役字串的硬性要求，或改断言目前實際 renderer 集合；**retire** 若 telemetry 已由別處驗收 |
| phase29-verify.ts | **無外部 API** 的靜態回歸：phase29 展開、官網查無文案、chat 前端、sync 腳本等 | **意圖 active**；**檔案選取 obsolete** | **FAIL**：只讀 **`server/routes.ts`** 找 `phase29_more_orders_expand`。現行實作在 **`server/services/ai-reply.service.ts`**；`routes.ts` 僅註冊路由，**不含**該字串 | **否** | **fix**：改讀 `ai-reply.service.ts`（或合併多檔）；**keep** 其餘對 `superlanding`／`chat.tsx` 等檢查仍有意義 |
| phase31-verify.ts | Policy、local_only guard、**export 腳本資安**（redact／mask）、routes `noSingleClaim`、superlanding 合併 | **政策與 guard 多數仍 active**；**export 段失效** | **FAIL：ENOENT** `scripts/export-ai-bundle-context.mjs`——**repo 內不存在**任何 `export*.mjs`（曾預期給 bundle 匯出／審核用） | **否**（核心訂單邏輯不依賴該檔；缺的是「匯出資安自驗」） | **三選一**：(1) **fix** 補齊腳本或改指向現有 `export-runtime-addon-data.ts` 等並調整 assert；(2) **retire** phase31 內「讀 mjs」區塊；(3) 若從未上線視為 **歷史殘留假設** |
| phase33-verify.ts | T33 靜態＋情境：`detectLookupSourceIntent`、`orderLookupAck` **出現在 routes**、lookup_diagnostic 等 | **政策 active**；**routes 斷言 obsolete** | **FAIL：T33-4**——要求 **`server/routes.ts`** 含 `orderFeatureFlags.orderLookupAck`。現況 **`orderLookupAck` 僅見於 `ai-reply.service.ts` 與 `order-feature-flags.ts`**，`routes.ts` **無** 該字串 | **否** | **fix**：改搜 `ai-reply.service.ts`／`core.routes.ts`；**keep** policy／payment 相關 assert |
| phase34-verify.ts | **Runtime 行為級**：查單來源 P0、長數字單號、tool JSON sanitize、summary_only／local_only、**關閉** active-order deterministic 短路、付款標籤、persona 檔存在 | **active** | **通過（exit 0）** | **否**（作為目前最贴近「真行為」的護欄之一） | **keep**；並視為 **replace** 部分過時 phase25–29 靜態字串檢查的優先依據 |

---

## 逐項說明（對應你的七問）

### 1. phase25-verify.ts 是否仍屬現行有效護欄？

- **語意上**：是——仍應保證「查單模式不要灌入 CATALOG／KNOWLEDGE／IMAGE」與長度控制。
- **為何 fail**：實作已把 profile 命名從 `order_lookup_ultra_lite`／`order_followup_ultra_lite` 改為 **`order_lookup_prompt_diet`**（非 image 分支、`planMode` 為 order_lookup／order_followup 時），verify **未更新**。
- **若說「過時」**：過時的是 **測試中的字串常量**，不是「瘦 prompt」這條產品護欄。

### 2. phase26-verify.ts

- 同上：**瘦 prompt 護欄仍有效**；fail 主因同 **profile 名稱**。
- 額外風險：依賴 **`routes.ts` 大文件字串**；與現行 **拆分架構** 不一致，屬 **測試設計過時**。

### 3. phase27-verify.ts

- **有效部分**：契約、`order-ultra-lite` 模組、latency sample parser、與 `orderFeatureFlags` 等仍具參考價值。
- **為何 fail**：硬性要求 **`reply_renderer: "active_order_deterministic"`** 與程式碼現狀不符（該字串已不存在）；**multi_order_router** 仍存在於 `ai-reply.service.ts`。
- **結論**：護欄「多筆／單筆 renderer 要可觀測」仍合理；**具體 renderer 名稱**的斷言已與現行實作脫節 → **verify 過時**，需改斷言或退役。

### 4. phase29-verify.ts

- **仍想驗的東西**（phase29 展開、文案、前端 limit）大多仍合理。
- **為何 fail**：**誤把 `server/routes.ts` 當成 AI 核心實作宿主**；phase29 字串在 **`ai-reply.service.ts`**。
- **結論**：**目的 active，取樣檔案 obsolete**。

### 5. phase31 缺 `scripts/export-ai-bundle-context.mjs`

- **判定**：**漏檔或已退役的專用匯出腳本**——repo 內 **無** 對應 `.mjs`；另有 **`export-runtime-addon-data.ts`** 等 **不同路徑／格式** 的匯出（見 `scripts/`）。
- **不應無證據即說「應被刪除」**：比較穩健的說法是：verify **假設了一個從未提交或已下架的檔**；若要保留 phase31 的「bundle 資安」意圖，應 **改綁現存腳本** 或 **刪除該段 assert**。

### 6. phase33-verify.ts

- **政策層**（lookup source、phone summary）仍與現行 `order-lookup-policy` 一致。
- **為何 fail**：**T33-4** 錯把 **`orderFeatureFlags.orderLookupAck` 必須出現在 `routes.ts`**；實際使用在 **`ai-reply.service.ts`**。
- **結論**：**護欄概念 active**；**靜態搜尋路徑 obsolete**。

### 7. phase34-verify.ts 為何通過？覆蓋哪些現行核心路徑？

- **通過原因**：幾乎不依賴 `routes.ts` 巨檔字串；直接呼叫 **`order-lookup-policy`**、讀 **`tool-executor.service.ts`**、**`order-payment-utils`**、**`order-service`**、**`tool-llm-sanitize`**、**`ai-reply.service.ts`**（`planAllowsActiveOrderDeterministic` 恒 `false`）、並驗 **`buildDeterministicFollowUpReply` 回傳 null**（確定性追問關閉）。
- **現行核心覆蓋範圍（摘要）**：
  - **查單意圖與來源**：`detectLookupSourceIntent`、`deriveOrderLookupIntent`、長純數字單號、`extractLongNumericOrderIdFromMixedSentence`。
  - **Tool／LLM 邊界**：`finalizeLlmToolJsonString`、`orderLookupSummaryOnly`、`local_only` 摘要路徑。
  - **Minimal Safe Mode**：active-order deterministic 短路關閉。
  - **付款與對客文案**：`derivePaymentStatus`、`displayPaymentMethod`／`displayShippingMethod` 不洩 raw enum、失敗標籤。
  - **人格檔**：`docs/persona/*` 存在性。
- **未覆蓋**：例如 **prompt_profile 字串與 phase25 對齊**、**整條 webhook → queue → worker** E2E、**meta_page_settings** 資料面。

---

## Blocking 建議（給 release 決策）

- **目前無任一 phase25–33 fail 項**在程式碼層面自動構成「不可上線」證明；它們多數是 **測試與 repo 結構脫節**。
- **實質風險**在於：若長期無人 **fix／replace** 這些 verify，**真回歸**可能只依賴 **phase34 + r1-verify（後者尚缺 fixture）** 與手動測試。
