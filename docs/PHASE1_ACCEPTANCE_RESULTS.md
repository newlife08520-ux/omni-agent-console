# Phase 1 驗收結果記錄

依 **Phase1-驗收案例與步驟.md** 與計劃書 E1～E5（若有）執行後，將結果填寫於此。

---

## A～F 驗收案例（Phase1-驗收案例與步驟.md）

| 案例 | 輸入 | 預期 | 結果 | 備註 |
|------|------|------|------|------|
| **A** | 你們東西很爛 | 不得 high_risk_short_circuit | **PASS** | phase1-verify：不為 legal_risk |
| **B** | 我要提告 / 我要找消保官 | 必須 legal_risk → handoff | **PASS** | phase1-verify：B1/B2 皆 legal_risk |
| **C** | 能轉人工嗎 | 直接 handoff | **PASS** | phase1-verify：human_request + handoff |
| **D** | 人呢 | **不** handoff（止血規則） | **PASS** | phase1-verify：人呢 → 不 handoff |
| **E** | 第一句：我要退貨 → 第二句：說錯，我要查出貨速度 | 第二句意圖 order_lookup | **PASS** | phase1-verify：correction override → order_lookup |
| **F** | 我訂很久了很煩不要了幫我轉人工 | 最終只走 handoff | **PASS** | phase1-verify：混句含轉人工 → handoff |

---

## 可重播腳本

```bash
npx tsx server/phase1-verify.ts
```

**腳本結果**：62 通過、1 失敗。失敗項為「Awkward. 同一種資料重問至少三次 → 轉人工」（與 Phase 1 止血項目無關，為既有邏輯）。

---

## E1～E5（計劃書驗收劇本，若有）

若計劃書中有定義 E1～E5 情境，請於下方逐條記錄：

| 編號 | 情境摘要 | 預期 | 結果 | 備註 |
|------|----------|------|------|------|
| E1 | （依計劃書填寫） |  | （待跑） |  |
| E2 |  |  | （待跑） |  |
| E3 |  |  | （待跑） |  |
| E4 |  |  | （待跑） |  |
| E5 |  |  | （待跑） |  |

---

## Phase 1 止血項目快速檢查

| 項目 | 說明 | 需人工／可重播 |
|------|------|----------------|
| 訂單摘要「門市地址」/「地址」 | 依 delivery_target_type 或 CVS 關鍵字正確顯示 | 需人工目視（有訂單時） |
| 前台 `GET /api/orders/lookup` | 僅查當前品牌（allowCrossBrand=false） | 可重播：呼叫 API 帶 brand_id，確認不回他品牌訂單 |
| 查單先送「我幫您查詢中～」 | 進入 order lookup tool 時先送出一則再查 | 需人工或 webhook 實測 |
| 追問確定性回覆 | 出貨/物流/到貨追問 → reply_source=active_order_short_circuit | 可查 ai_log.reply_source |
| `lookup_more_orders` | 依 active context 的 page_id 查同頁+同手機 | 需人工（先查單再問更多訂單） |

**結案判定**：上述項目以程式與腳本可驗證者已完成；需人工者已標記，不阻擋 Phase 2。

---

## 實戰案例（可選填）

| 案例 | 輸入／情境 | 預期 | 結果 | 備註 |
|------|------------|------|------|------|
| 1 | 客戶提供訂單編號查單 | 先送「我幫您查詢中～」再回訂單摘要 | （待人工） |  |
| 2 | 客戶說官網買的＋訂單號 | 以官網（Shopline）優先查單（lookup_order_by_id + preferSource） | （待人工） | 已實作 |
| 3 | 客戶說官網買的＋僅電話 | 以電話查官網訂單（lookup_order_by_phone，不需商品名） | （待人工） | 已實作 |
| 4 | 追問「出貨了嗎」 | 確定性回覆、reply_source=active_order_short_circuit | （待人工） |  |
