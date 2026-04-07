# 10 — 安全：`content-guard`、捏造防護、Persona、檢查清單

## `content-guard.ts`

- 偵測回覆是否 **像捏造訂單**（例如出現金額／單號樣式卻未呼叫查單工具）。  
- 與本包內 **`intent-and-order.ts`**（訂單號分類、人類請求轉人工等）互補。

## `tool-llm-sanitize.ts`

- **`finalizeLlmToolJsonString`**：對查單工具 JSON **刪敏感欄位／遮罩 PII／人類化狀態字**後再給模型。  
- **`maskName` / `maskPhone`**：與 `order-reply-utils` 對客隱碼邏輯對齊。

## `PHASE97_MASTER_SLIM.txt`（Global Persona）

- **查單絕對禁止**：未呼叫工具前不可編造訂單號、金額、付款方式、物流。  
- **格式**：要求使用工具回傳的 **`one_page_summary` / `one_page_full`**，**不可改寫成散文**；COD 不可誤導為線上已付。  
- **說話方式**：語助詞、emoji 節奏、同理心、避免官腔（細節見原文）。

## 給模型（GPT／Gemini）用的操作檢查清單

1. 客人要查單 → **必須**走工具，成功後優先 **逐字使用** `one_page_summary`。  
2. 多筆 → 遵守工具 `sys_note`（簡表／逐筆完整／最近 5 筆等）。  
3. 付款為 **貨到付款／超商取貨付款／宅配代收** → **不可**要求客人先線上付清。  
4. **Shopline** 與 **一頁商店** 編號型態不同 → 不要堅持單一格式。  
5. 狀態顯示 **等待付款確認** 時 → 語意是「已通知、待客人完成付款」，不要說成「系統故障」。  
6. 轉人工後 → 不重複 AI 搶答（見 webhook 與 `needs_human` 邏輯）。

## 本包使用方式建議

- **Gemini**：上傳 `gemini/01`～`10`，必要時再附加單一 `source/*.ts` 深讀。  
- **GPT**：可直接丟整包 `source/` 或 ZIP，請模型對照本系列 MD 做 code review／文件化。

---

**結束。與 `01` 連成完整導讀鏈。**
