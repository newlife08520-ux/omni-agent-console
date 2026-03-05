# 客訴/退款/高風險規則先擋 — 驗收回報

## 1. 完成狀態

**已完成並驗收通過**

- 前 7 筆（高風險）全部無第二則導購，且 classifier_source 皆為 `rule`。
- 後 3 筆（一般詢問）維持正常雙段式，classifier_source 為 `ai`。
- 10 筆逐筆執行 suggest-reply 並檢查回傳欄位，全部符合驗收條件。

---

## 2. Root cause

### 為什麼 AI 會把客訴誤判成 spam_competitor

- 單靠 AI 做一次分類時，同一句「我要退款」「我要客訴」在不同 run 下可能被歸到不同 intent（例如 spam_competitor、complaint、refund 等），屬於模型不確定性。
- 若被誤判為 spam_competitor 或一般詢問，流程會繼續走「雙段式＋導購」，導致在客訴/退款情境下仍產出第二則導購，造成品牌風險。

### 這次為什麼要改成 rule first、AI second

- **確定性**：關鍵字規則在相同輸入下結果一致，不依賴單次 AI 推論。
- **先擋再補**：高風險語意先用規則擋下，只產安撫第一則、不產第二則、不導購；其餘才交給 AI 做意圖分類與雙段式回覆。
- **可觀測**：`classifier_source`（rule | ai）與 `matched_rule_keyword` 讓營運能區分「規則擋下」與「AI 分類」，方便除錯與覆核。

---

## 3. 改了哪些檔案

| 檔案 | 改動摘要 |
|------|----------|
| `server/meta-comment-guardrail.ts` | 新增。四類關鍵字（退款/退貨、客訴/抱怨、售後/物流、品質/商品問題）、`checkHighRiskByRule()`、固定安撫文案；命中回傳 intent 為 complaint 或 refund_after_sale。 |
| `server/routes.ts` | suggest-reply 最前 Step 0 先呼叫 guardrail；命中則直接寫入 intent、priority=urgent、ai_suggest_human=1、reply_first=安撫、reply_second=null、reply_link_source="none"、classifier_source="rule"、matched_rule_keyword，並 return；未命中才走 AI。三處 return 皆帶上 classifier_source、matched_rule_keyword。 |
| `server/db.ts` | meta_comments 表新增欄位 classifier_source、matched_rule_keyword（ALTER TABLE）。 |
| `shared/schema.ts` | MetaComment 型別新增 classifier_source: "rule" \| "ai" \| null、matched_rule_keyword: string \| null。 |
| `server/meta-comments-storage.ts` | updateMetaComment 支援寫入 classifier_source、matched_rule_keyword。 |
| `client/src/pages/comment-center.tsx` | 詳情區顯示「分類來源」、命中關鍵字、「第二則導購已關閉（高風險僅安撫）」。 |
| `script/run-guardrail-acceptance.ps1` | 既有 10 筆案例腳本（PowerShell，使用 WebSession 保留 Cookie）。 |
| `script/run-guardrail-acceptance.js` | 新增 Node 版驗收腳本，登入帶 Cookie 後逐筆呼叫 suggest-reply，輸出驗收表並 exit(0/1)。 |

---

## 4. 驗收結果表

| # | 測試文案 | classifier_source | matched_rule_keyword | final_intent | is_high_risk | reply_second | 是否通過 |
|---|----------|-------------------|----------------------|--------------|--------------|--------------|----------|
| 1 | 我要退款 | rule | 退款 | refund_after_sale | true | N | 通過 |
| 2 | 我要客訴 | rule | 客訴 | complaint | true | N | 通過 |
| 3 | 你們都不回訊息 | rule | 不回訊息 | refund_after_sale | true | N | 通過 |
| 4 | 上週訂的還沒收到 | rule | 還沒收到 | refund_after_sale | true | N | 通過 |
| 5 | 這品質也太差 | rule | 太差 | complaint | true | N | 通過 |
| 6 | 商品有瑕疵 | rule | 瑕疵 | complaint | true | N | 通過 |
| 7 | 我不要了可以取消嗎 | rule | 不要了 | refund_after_sale | true | N | 通過 |
| 8 | 請問多少錢 | ai | - | price_inquiry | false | Y | 通過 |
| 9 | 請問哪裡買 | ai | - | where_to_buy | false | Y | 通過 |
| 10 | 這款敏感肌可以用嗎 | ai | - | ingredient_effect | true* | Y | 通過 |

\* 第 10 筆 is_high_risk 為 true 來自 AI 側（如成分/膚質建議轉人工），仍產出第二則，符合「一般詢問維持雙段式」之驗收。

---

## 5. 尚未完成項目

- **關鍵字擴充**：若實際上線出現新客訴用語（例如「雷」「踩雷」「不推」「慎入」），可再補進規則。
- **同義/錯字**：目前為精確子字串匹配，未做同義詞或常見錯字（如「退欵」「退钱」）擴展；若有需求可加正規化或擴表。
- **閾值與標記**：suggested_hide、suggested_handoff 目前依既有邏輯與 priority/ai_suggest_human；若需「命中規則即一律建議隱藏」可再細調。

---

## 6. 自我檢討

### 為什麼這次不能只調 prompt

- Prompt 只能降低誤判機率，無法保證「同一句永遠不導購」；模型輸出有隨機性，單次分類不可靠。
- 客訴/退款屬於高品牌風險，必須用**確定性規則**先擋，再讓 AI 處理其餘情境，才能達到「絕不在此類留言下產第二則導購」的目標。

### 若正式上線，最容易傷品牌的誤判是哪 3 種

1. **客訴/退款被當一般詢問**：繼續導購或推銷，會讓用戶覺得不被重視、甚至公審。
2. **催單/未收到被當 spam**：回覆制式或忽略，導致客訴升級、負評。
3. **品質/過敏抱怨被當一般詢問**：仍產第二則導購，易被視為只顧賣貨不顧售後，傷害信任。

---

*驗收執行方式：先啟動 server，再執行 `node script/run-guardrail-acceptance.js` 或 `.\script\run-guardrail-acceptance.ps1`。*
