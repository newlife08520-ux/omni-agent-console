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

## 唯一決策（R1-6 Locked）

1. **Runtime 人格主體**：**`settings.system_prompt` + 各品牌 `brands.system_prompt`**（SQLite）。  
2. **`docs/persona/*.txt`**：**設計稿／對齊參考**，**不是** runtime source；未寫回 DB 則 **以 DB 為準**。  
3. **Deterministic 模板**（`BRAND_DELAY_SHIPPING_TEMPLATE`、`buildDeterministicFollowUpReply`、COD／付款句）：**服從**營運語義與安全邊界；**不**覆寫 DB 裡的品牌語氣長文，但**可**在查單／久候等硬規則上優先（與 `ORDER_LOOKUP_RULES` 並列）。  
4. **`normalizeCustomerFacingOrderReply`（`customer-reply-normalizer.ts`）**：**僅能收斂**（去冗詞、禁空洞套話），**不得**改變查單政策、付款分類或是否轉人工等**策略**。

## 保留 / 遷移 / 刪除（清單）

| 動作 | 項目 |
|------|------|
| **保留** | DB `system_prompt`；`prompt-builder` 組裝；`ORDER_LOOKUP_RULES`；`derivePaymentStatus`；`displayPaymentMethod` / `displayShippingMethod` |
| **保留** | R1 新增之 `buildProvisionalLocalOnlyActiveContextFromOrder`、`lookup_provisional` 語意 |
| **遷移** | `docs/persona` 中與查單／純手機政策衝突的敘述 → 應改寫後同步進 DB 或刪除衝突段 |
| **刪除／停用** | 任何仍暗示「只給手機就幫查單筆」的 tool 描述、help 字串（以 `order-lookup-policy` 為準） |

## Masked effective system prompt 匯出

```bash
cd Omni-Agent-Console
npx tsx server/scripts/export-effective-prompt-masked.ts ./docs/runtime_evidence/effective_prompt_masked.md
```

說明見 `docs/runtime_evidence/README.md`（目錄已納庫，無需手動建立）。

## 本輪 R1 相關程式檔（人格與話術落地）

- `server/order-reply-utils.ts` — 久候模板、對客顯示、local_only 摘要格式。
- `server/routes.ts` — `<ORDER_LOOKUP_RULES>` 注入（若該檔於你分支存在）。
- `server/order-lookup-policy.ts` — 查單意圖單一真相。
