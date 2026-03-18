# Phase 2.6 驗收報告

## 驗收條件對照

| 項目 | 狀態 | 說明 |
|------|------|------|
| Generic deterministic，非工具名白名單 | ✅ | `routes.ts` 依 JSON 契約採用最後一筆 |
| 五種單筆 tool deterministic | ✅ | by_id / product_phone / date / more_sl / more_shopline |
| 最後一哩 normalizer | ✅ | order_lookup / followup 模式較硬 |
| ultra-lite prompt | ✅ | 非 slice 肥 prompt；profile 已更名 |
| latency log | ✅ | lookup_ack、first_visible、final、second_llm_skipped、final_renderer |
| ai_log | ✅ | deterministic 時 `reply_source=deterministic_tool`、`used_llm=0`、`reason_if_bypassed` |
| `verify:phase26` 全綠 | ✅ | 見 RUNTIME_EVIDENCE |

## 建議人工 12 題抽測

依計畫書第五節：單號／混合句／多筆各情境／追問付款出貨／語氣與速度體感。

## 結論

**可封板進 staging／production 前最後一輪人工對話驗收**；自動化已覆蓋 webhook 契約、normalizer、prompt 與 log 關鍵字。
