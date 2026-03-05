# 公開留言分流 — 重啟後實測回報

## 1. 完成狀態

**已完成並驗收通過**

（已重啟後端、重跑 `node script/run-divert-acceptance.js`，B 組全數走 line_redirect，A/C/D/E 符合預期。）

---

## 2. B 組逐筆結果

| 留言 | final_intent | reply_flow_type | 是否導 LINE | 是否仍誤走商品頁 | 是否通過 |
|------|--------------|-----------------|-------------|------------------|----------|
| 想知道哪款比較適合我 | dm_guide | line_redirect | 是 | 否 | 通過 |
| 可以幫我推薦嗎 | dm_guide | line_redirect | 是 | 否 | 通過 |
| 想了解更詳細 | dm_guide | line_redirect | 是 | 否 | 通過 |
| 幫我挑一下 | dm_guide | line_redirect | 是 | 否 | 通過 |
| 哪款比較適合 | dm_guide | line_redirect | 是 | 否 | 通過 |

B 組 5 句皆由 **deterministic keyword rule（Step 0b）** 命中，不經 AI 分類，直接產「簡答第一則 + LINE 話術第二則」，reply_flow_type=line_redirect，未走商品頁。

---

## 3. A–E 驗收總表

| 組別 | 是否通過 | 若失敗 root cause | 是否已修復 |
|------|----------|-------------------|------------|
| **A. 一般詢問** | 通過 | — | — |
| **B. 中等複雜** | 通過 | （此前為 AI 未穩定回傳 dm_guide） | 已補 Step 0b 關鍵字規則，穩定走 LINE |
| **C. 訂單/售後** | 通過 | — | — |
| **D. 客訴/退款/爭議** | 通過 | — | — |
| **E. 活動** | 通過 | — | — |

---

## 4. 已補之 deterministic keyword rule（B 組用）

B 組已通過，以下為本次實作之規則，供對照：

- **檔案**：`server/meta-comment-guardrail.ts` 新增 `checkLineRedirectByRule(message)`。
- **關鍵字**：適合我、推薦我、幫我推薦、更詳細、想了解更詳細、幫我挑、哪款比較、不知道怎麼選。
- **流程**：在 suggest-reply 的 Step 0（高風險 guardrail）之後、Step 1（一般規則）之前執行 Step 0b；命中則不呼叫 AI，直接產第一則（OpenAI 短回覆）+ 第二則（line_general 模板 reply_dm_guide），寫入 ai_intent=dm_guide、reply_flow_type=line_redirect、classifier_source=rule。

---

*實測時間：重啟後端後執行 `node script/run-divert-acceptance.js` 之完整輸出。*
