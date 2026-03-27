# PERSONA_SINGLE_SOURCE_OF_TRUTH.md（R1-6）

## 文件 vs 執行期

| 來源 | 角色 |
|------|------|
| **`settings.system_prompt`（SQLite `settings` 表）** | **主規則載體之一**；經 `buildGlobalPolicyPrompt()` 等讀入組裝。 |
| **`brands.system_prompt`（各品牌列）** | **品牌語氣／規範**；與全域 prompt 一併組裝。 |
| **`docs/persona/*.txt`** | **撰寫參考與對齊標準**；若未寫回 DB，**以 DB + `prompt-builder` 輸出為準**。 |

## `prompt-builder`（`server/services/prompt-builder.ts`）

- **角色**：**組裝**（全域政策、品牌語氣、模式、查單規則區塊等），**不應**在程式內用另一套文字**覆蓋**已生效的 DB 人格，除非程式碼明確載為「硬編碼規則」（例如安全／查單 `ORDER_LOOKUP_RULES` 注入）。

## Deterministic template / normalizer

| 元件 | 角色 |
|------|------|
| **`order-reply-utils`**（如 `buildDeterministicFollowUpReply`、`BRAND_DELAY_SHIPPING_TEMPLATE`） | **對客一致話術**（久候、COD、付款說明），與 LLM 並行時作 **單一模板來源**。 |
| **`derivePaymentStatus`（`order-payment-utils`）** | **付款狀態單一真相**；deterministic 與 active context 皆應對齊，避免 pending/COD 誤判。 |

## 建議停用／遷移的舊規則

- **任何**鼓勵「純手機就直接單筆定案」的敘述：應與 `order-lookup-policy` / `ORDER_LOOKUP_RULES` 一致，改為商品+手機或「全部訂單」語意。
- **對客**出現 `pending`、`to_store`、`credit_card` 等 raw：沿用 `findCustomerFacingRawLeak` 與 `displayPaymentMethod` / `displayShippingMethod` 方針。

## 本輪 R1 相關程式檔（人格與話術落地）

- `server/order-reply-utils.ts` — 久候模板、對客顯示、local_only 摘要格式。
- `server/routes.ts` — `<ORDER_LOOKUP_RULES>` 注入（若該檔於你分支存在）。
- `server/order-lookup-policy.ts` — 查單意圖單一真相。
