# Phase 2.5 Baseline（改動前紀要）

| 項目 | 改動前 |
|------|--------|
| order_lookup prompt | 整包 global + brand + human + flow + **CATALOG + KNOWLEDGE + IMAGE** |
| order_followup | 同上（無獨立瘦身） |
| product+phone 多筆（API） | 回 one_page_full + note，**未** deterministic_skip_llm |
| date+contact Shopline | API 全量再篩聯絡人，**未**嚴格日期區間 |
| more_orders / shopline 多筆 | LLM 整理為主，**未**統一聚合與 multi context |
| pending vs failed | prepaid=false 易落入 failed |

以上已於 Phase 2.5 程式中收斂。
