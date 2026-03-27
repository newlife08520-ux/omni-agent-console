# 實際生效的 Persona／Prompt（Runtime）

## 單一真相在哪裡？

1. **`settings` 表 `system_prompt`（key）**  
   - 由 `buildGlobalPolicyPrompt()` 讀取（`server/services/prompt-builder.ts`）。  
   - **不是** `docs/persona/*.txt` 檔案本身，除非後台曾把內容寫回 DB。

2. **`brands.system_prompt`**  
   - 品牌語氣區塊，`buildBrandPersonaPrompt()`。

3. **送進模型的完整字串**  
   - `assembleEnrichedSystemPrompt()` 依 `planMode`、是否含圖、是否查單後追問等，組出 **ultra-lite 或 full**。  
   - 查單／售後 **deterministic 模板**與 **customer-reply-normalizer** 可能改寫**對客**字串，與「模型看到的 system」分層。

## `docs/persona/` 是什麼？

人類可讀的**規格／草稿**；**若未同步寫入 DB，以 DB + prompt-builder 為準**。

## 遮罩匯出怎麼拿？

打包會產生 **`verify_output/system_prompt_effective.md`**（由 `npm run export:review-prompt-masked`；匯出時會跳過一頁商店 catalog API，見該檔開頭說明）。

## 衝突時誰贏？（實務）

| 情境 | 較常生效層 |
|------|------------|
| 查單 deterministic 已產出 | 程式模板 + normalizer，LLM 僅補述 |
| 一般閒聊 | DB global + brand + builder 組裝 |
| 延遲／出貨話術（有 active context） | `order-reply-utils` deterministic 分支 |

細部對照可搜程式：`buildDeterministicFollowUpReply`、`normalizeCustomerFacingOrderReply`。
