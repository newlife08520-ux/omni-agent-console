# Phase34B 精準補修報告

## 執行狀態：**PASS**

**實際終端機指令（不可捏造）：**

```bash
npm run verify:phase34b
```

**輸出摘要（2026-03-21 環境）：**

- `check:server`（`tsc -p tsconfig.server.json`）通過  
- `[phase34b-verify]` 6 項全綠：必修 1～5 + payKind 一致性  

---

## 分步驟執行說明

依要求採**分批交付**：先完成 **必修 1、2**（候選摘要 + 真實結構 fixture → `mapOrder` → `derivePaymentStatus`），再完成 **3、4、5**（品牌話術、denylist、`verify:phase34b`）。  
**不建議**在未跑通驗證前一次改動過多檔案而不跑終端。

---

## 改了哪些檔

| 檔案 | 內容 |
|------|------|
| `server/order-reply-utils.ts` | `formatLocalOnlyCandidateSummary`、`CUSTOMER_FACING_RAW_DENYLIST`、`findCustomerFacingRawLeak`、`displayPaymentMethod`／`displayShippingMethod`、`buildDeterministicFollowUpReply`（含已出貨＋追蹤之「何時收到」分支） |
| `server/routes.ts` | `local_only` 單筆：`formatLocalOnlyCandidateSummary`、`one_page_summary`／active context 與 deterministic reply 對齊 |
| `server/order-fast-path.ts` | `isLocalOnlySingle` 時候選摘要 +「候選訂單」前綴 |
| `server/superlanding.ts` | `deriveSuperlandingPaymentStatusRaw` 合併 nested `order`；`mapSuperlandingOrderFromApiPayload` 供 fixture |
| `server/order-payment-utils.ts` | 一頁 `payRaw` 中文失敗訊號（紅叉／未成立等） |
| `docs/runtime-audit/superlanding-esc20981-linepay-fail.fixture.sanitized.json` | **扁平**、去識別化失敗單參考（與 `orders.json` 單筆形狀一致） |
| `docs/runtime-audit/superlanding-esc20981-nested-order-wrapper.fixture.sanitized.json` | **nested `order` + `gateway_status`** 補充形狀 |
| `server/phase34b-verify.ts` | 行為級 fixture + reply 字串斷言 |
| `package.json` | `verify:phase34b` |
| `server/phase31-verify.ts`（若已併入） | fast path 文案含「候選訂單」 |

---

## 鎖住的案例（Regression）

1. **local_only 單筆**：對客為候選摘要，無「幫您查到了／我查到這筆了」、無完整 one-page 欄位（無「付款方式：」「電話：」「收件人：」列）。  
2. **ESC20981 類**：`docs/runtime-audit/*.fixture.sanitized.json` → `mapSuperlandingOrderFromApiPayload` → `derivePaymentStatus` → **`failed`**，label 含「付款失敗」「訂單未成立」。  
3. **品牌話術**：待出貨無追蹤 + 出貨相關問句 → 5／7–20 工作天模板；COD +「怎麼還沒寄」→ 非付款失敗；有追蹤 +「什麼時候收到」→ 道歉＋物流、**不含** 7–20 預購主模板。  
4. **Denylist**：`formatOrderOnePage`／single renderer／multi `one_page_full`／follow-up 回覆字串經 `findCustomerFacingRawLeak` 掃描，不得獨立出現 `pending`／`to_store`／`credit_card`。

---

## 仍未覆蓋或刻意不模擬者

- **真實 HTTP webhook 整段**：未在本 repo 內起 express 打 `/webhook`；僅以與 audit 一致的 **JSON 形狀** + 同一條 `mapOrder`／`derivePaymentStatus` 路徑驗證。  
- **Shopline 失敗單**：本輪 fixture 聚焦一頁商店；若需同級 Shopline fixture 可另增 `shopline-*.fixture.sanitized.json` 再掛進 `phase34b-verify`。  
- **LLM 產文**：verify 只鎖 **deterministic／formatter** 路徑；模型自由生成段落仍依 prompt／guard，不在本腳本斷言範圍。

---

## Fixture 欄位說明（必修 2）

因無法取得真實 ESC20981 原始 JSON，採 **去識別化** 且對齊已知 `orders.json` 扁平欄位，並加上常見金流失敗鍵：

- `system_note.message`：含「未成立／紅叉」語意  
- `gateway_status`: `"failed"`  
- `payment_result`: `null`  
- `prepaid`: `false`、`paid_at`: null  
- `payment_method`: `line_pay`（與 `REQUIRES_PREPAY_METHOD` 一致）  

若線上實際為 **nested `order`**，`deriveSuperlandingPaymentStatusRaw` 已讀取 `order.status`／`order.gateway_status`／`order.system_note.message` 併入 raw。

詳見：`docs/runtime-audit/superlanding-esc20981-*.fixture.sanitized.json`。

---

## 驗證要求（再次強調）

必須在終端執行：

```bash
npm run verify:phase34b
```

若有失敗，應依報錯修正程式後重跑，**不可**口頭宣稱通過而未實跑。
