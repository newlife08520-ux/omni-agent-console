# Persona／話術層級對照（哪一層在線上較常贏）

| 層級 | 來源 | 典型用途 |
|------|------|----------|
| Global policy | `settings.system_prompt` | 全域語氣、安全 |
| Brand tone | `brands.system_prompt` | 品牌稱呼、禁語 |
| Builder 組裝 | `assembleEnrichedSystemPrompt` | 查單 ultra-lite vs 全量 |
| 查單工具結果 | `routes` deterministic JSON | 多筆／local_only 候選摘要 |
| 售後追問 | `buildDeterministicFollowUpReply` | 出貨延遲、COD、已出貨 |
| 對客修飾 | `normalizeCustomerFacingOrderReply` | 軟化、禁語 |

**延遲／道歉**：有 active order 且命中追問關鍵字時，**deterministic 模板**通常優先於 LLM 自由發揮；詳見 `order-reply-utils` 與 `routes` 分支。

與 `docs/persona/*.txt` 不一致時：**以 DB + 上表程式路徑為準**。
