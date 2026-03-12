# Prompt 單一真相與 Runtime 追蹤報告

**產出目的**：在正式改碼前，把後台兩層 prompt 的儲存、讀取、組裝與 reply path 徹底查清，並落地權責切分、Effective Prompt Preview、區分「prompt 沒生效」與「該輪沒進 LLM」、txt 與 DB 關係、改檔清單。

---

## 一、兩層後台欄位是否為正式 runtime source of truth

### 1.1 儲存位置（已確認）

| 後台欄位 | 資料表 | 欄位／鍵 | 讀取方式 |
|----------|--------|----------|----------|
| **全域系統指令** | `settings` | key = `system_prompt`，value = 字串 | `storage.getSetting("system_prompt")` |
| **品牌專屬 AI 指令** | `brands` | 欄位 `system_prompt` (TEXT) | `storage.getBrand(brandId)?.system_prompt` |

- **settings**：`server/storage.ts` 使用 `INSERT OR REPLACE INTO settings (key, value)`；get 用 `SELECT value FROM settings WHERE key = ?`。
- **brands**：`shared/schema.ts` 的 `Brand.system_prompt`；`server/storage.ts` 與 `server/db.ts` 的 brands 寫入/讀取皆含 `system_prompt`。

**結論**：這兩個欄位是 DB 中實際被讀寫的來源，不是假欄位。

### 1.2 getEnrichedSystemPrompt 是否真的讀取這兩個欄位

**是。** 實作在 `server/routes.ts` 的 `getEnrichedSystemPrompt(brandId?: number)`：

```ts
const basePrompt = storage.getSetting("system_prompt") || "你是一位專業的客服助理。";
let brandBlock = "";
if (brandId) {
  const brand = storage.getBrand(brandId);
  if (brand?.system_prompt) {
    brandBlock = "\n\n--- 品牌專屬指令 ---\n" + brand.system_prompt;
  }
}
// ... 其後組裝 handoffBlock、humanHoursBlock、catalogBlock、knowledgeBlock、imageBlock
return basePrompt + brandBlock + handoffBlock + humanHoursBlockWithStatus + catalogBlock + knowledgeBlock + imageBlock;
```

- **全域**：`basePrompt` 來自 `getSetting("system_prompt")`。
- **品牌**：`brandBlock` 來自 `brand.system_prompt`。
- **handoffBlock**：同函式內**硬編碼字串**，**不是**從 DB 讀取；疊加在 `brandBlock` 之後、`humanHoursBlock` 之前。

### 1.3 handoffBlock 疊加層級

- **層級**：在 `getEnrichedSystemPrompt` 內，順序為  
  `basePrompt` → `brandBlock` → **handoffBlock** → `humanHoursBlockWithStatus` → `catalogBlock` → `knowledgeBlock` → `imageBlock`。
- **內容**：訂單出貨與退換貨規則、F2、轉人工條件、語氣與禁止、AI 身分透明等（約 302–337 行）。
- **是否為 DB 可編輯**：否，目前為程式碼內固定字串。

### 1.4 哪些 reply path 會吃到 prompt，哪些不會

只有**真正呼叫 LLM 的那條路徑**會用 `getEnrichedSystemPrompt` 的結果當 system prompt。其餘皆為短路，**不會**讀取或使用該 prompt。

| Reply path | 是否呼叫 getEnrichedSystemPrompt | 是否進 LLM | 說明 |
|------------|----------------------------------|------------|------|
| **L1 Gate 跳過**（awaiting_human / high_risk / needs_human / isAiMuted） | 否 | 否 | Phase 0 起會寫 ai_log（reply_source=gate_skip），再 return |
| **L2 高風險短路**（detectHighRisk 命中） | 否 | 否 | 寫 system 訊息、createAiLog（model: "risk-detection"）、return |
| **L3 安全確認分流**（classifyMessageForSafeAfterSale 命中） | 否 | 否 | 固定模板回覆、createAiLog（model: "safe-after-sale-classifier"）、return |
| **L4 圖片＋極短/模糊文字**（hasRecentImage + isShortOrAmbiguousImageCaption） | 否 | 否 | 固定模板、createAiLog（model: "safe-after-sale-classifier"）、return |
| **L7 return_form_first 固定模板**（plan.mode === "return_form_first"） | 否 | 否 | 固定退換貨＋表單文案、createAiLog（model: "reply-plan"）、return |
| **LLM 路徑**（上述皆未 return） | **是** | **是** | `systemPrompt = await getEnrichedSystemPrompt(...)`，再追加本輪 mode 說明，送 OpenAI |

因此：  
- **會吃到 prompt 的**：只有「進入 LLM 的那一輪」；且該輪的 prompt = 全域 + 品牌 + handoffBlock + 人工時段 + 目錄 + 知識庫 + 圖片素材 + 本輪追加（handoff/F2/久候型等）。  
- **不會吃到 prompt 的**：L1 靜音、L2 高風險、L3 安全確認、L4 圖片短標題、L7 return_form_first；這些 path 都不會呼叫 `getEnrichedSystemPrompt`。

---

## 二、Prompt 權責切分（落地原則）

以下為單一真相的權責劃分，之後改碼與文件皆依此為準：

| 區塊 | 唯一職責 | 禁止 |
|------|----------|------|
| **全域系統指令**（settings.system_prompt） | 全品牌共用的**底層行為規則**（例如：身分為客服助理、不假裝真人、基本禮貌與禁止事項）。 | 不放品牌專屬人設、不放流程/模式判定、不放 handoff/return 等主流程決策。 |
| **品牌專屬 AI 指令**（brands.system_prompt） | **品牌人格、語氣、禁語、品牌專屬表達偏好**（例如：稱呼方式、用詞風格、品牌名稱用法）。 | 不放全品牌共用規則、不放流程邏輯（mode/handoff/return/off-topic）、不放 output 長度/格式等「控制層」決策。 |
| **handoffBlock**（目前程式碼內） | 僅作 **mode 補充說明**：在 state/plan 已決定本輪 mode 的前提下，說明該 mode 下可做/不可做、語氣與 F2。 | **不可搶主流程判定**；不可取代 state resolver 或 reply plan 的決策；不可再塞入「若…則轉人工」等決策邏輯，只描述「本輪若已判定 handoff，應如何表達」。 |
| **流程邏輯**（mode、handoff、high risk、return flow、off-topic、output guard） | 由 **state resolver + reply plan builder + 短路邏輯** 在程式層決定；prompt 只接收「本輪 mode」與「本輪契約」，不負責「要不要轉人工」「要不要給表單」。 | 不得主要依賴 prompt 做流程決策；不得用大段 handoffBlock 文字「希望模型自己懂」來取代程式判斷。 |

落地時建議：  
- 將 handoffBlock 精簡為「mode 補充說明 + 語氣/F2」，與 state/plan 文件對齊。  
- 必要時把 handoffBlock 拆成「營運邏輯版」與「本輪 mode 契約」兩段，後者由 plan.mode 決定是否注入，避免重複與奪權。

---

## 三、Effective Prompt Preview / Runtime Prompt Trace（最小可行）

目標：在 AI 測試沙盒或 debug 模式能看到「這輪用什麼 prompt、有沒有進 LLM、回覆從哪來」。

### 3.1 現有基礎

- **GET /api/sandbox/prompt-preview**（`server/routes.ts`）：  
  已回傳 `global_prompt`、`brand_prompt`、`full_prompt_preview`（截斷 2000 字）、`full_prompt_length`、`context_stats`。  
  不足：無 hash/version、無 channel_id、無「本輪 mode / 是否進 LLM / reply_source」。

### 3.2 建議最小可行方案

**A. 擴充 GET /api/sandbox/prompt-preview（或新增 debug 端點）**

回傳欄位建議：

| 欄位 | 說明 |
|------|------|
| `brand_id` | 當前品牌 ID（與 runtime 一致） |
| `channel_id` | 可選，若請求帶 channel 或 contact 則帶出 |
| `global_prompt` | 同上，來自 settings |
| `brand_prompt` | 同上，來自 brands |
| `global_prompt_hash` 或 `global_prompt_version` | 例如對 `global_prompt` 做簡短 hash（前 8 字元）或「最後更新時間」當 version |
| `brand_prompt_hash` 或 `brand_prompt_version` | 同上，針對品牌 prompt |
| `handoff_block_included` | 是否含 handoffBlock（固定 true，若未來抽成設定可改） |
| `handoff_contract_hash` | 可選，本輪若注入 mode 契約，可對該段做 hash |
| `final_assembled_preview` | 與現有 full_prompt_preview 對齊，可截斷（如 2000 字） |
| `final_assembled_length` | 與現有 full_prompt_length 對齊 |

**B. Runtime 每輪回覆寫入 ai_logs 的擴充欄位（見第四節）**

在實際 webhook/autoReplyWithAI 路徑，每次寫入 `createAiLog` 時一併寫入：

- `reply_source`：`fixed_template` | `llm` | `handoff` | `high_risk_short_circuit` | `safe_confirm_template` | `image_short_caption` | `gate_skip`（若之後對 gate 也寫 log）
- `used_llm`：true / false  
- `plan_mode`：本輪 `plan.mode`（若未走到 plan 則 null 或空）  
- `reason_if_bypassed`：未進 LLM 時簡短原因（例如 "high_risk"、"return_form_first"、"safe_confirm"）

這樣在後台「對話詳情／AI 紀錄」即可區分：  
- 該輪**沒進 LLM**（used_llm=false，reason_if_bypassed 有值）→ 不是「prompt 沒生效」，而是根本沒用到 prompt。  
- 該輪**有進 LLM**（used_llm=true，reply_source=llm 或 handoff）→ 才適合討論 prompt 是否有生效。

**C. 沙盒測試時顯示「本輪是否會進 LLM」**

- 若在沙盒中模擬「同一個 state/plan」，可依現有邏輯算出本輪是否會走短路；  
- 或在 sandbox 回應中加上一欄 `simulated_reply_source` / `would_use_llm`（僅供參考），方便對照實際 webhook 的 ai_log。

---

## 四、區分「prompt 沒生效」與「該輪根本沒進 LLM」

### 4.1 問題

測到「跟預期不一樣」時，可能是：  
1. 該輪被 gate 或短路，**根本沒進 LLM**（prompt 沒被使用）；  
2. 該輪有進 LLM，但**模型沒照 prompt 回**（prompt 沒生效）。

目前 ai_logs 只有 `model`、`result_summary` 等，無法直接區分 1 與 2。

### 4.2 建議補齊欄位（寫入 createAiLog 時）

| 欄位 | 型別 | 說明 |
|------|------|------|
| `used_llm` | boolean | 本輪是否呼叫 OpenAI（true=有進 LLM） |
| `plan_mode` | string \| null | 本輪 reply plan 的 mode（若未執行到 plan 則 null） |
| `whether_fixed_template` | boolean | 是否為固定模板回覆（return_form_first / safe_confirm / image_short_caption 等） |
| `reason_if_bypassed` | string \| null | 若未進 LLM，簡短原因（如 "high_risk"、"return_form_first"、"safe_confirm"、"image_short_caption"、"gate_skip"） |

可選：將 `reply_source` 統一為一枚舉（如上節），與 `reason_if_bypassed` 二擇一或並存（reply_source 較利於查詢與報表）。

### 4.3 各 path 建議寫入值（對照表）

| Path | used_llm | plan_mode | whether_fixed_template | reason_if_bypassed |
|------|----------|-----------|------------------------|--------------------|
| L1 Gate 跳過 | 若未來寫 log：false | null | - | gate_skip |
| L2 高風險短路 | false | null | true（系統訊息） | high_risk |
| L3 安全確認 | false | null | true | safe_confirm |
| L4 圖片短標題 | false | null | true | image_short_caption |
| L7 return_form_first | false | return_form_first | true | return_form_first |
| LLM 路徑（含 handoff 後呼叫 transfer） | true | plan.mode | false | null |

**Phase 0 已落地**：ai_logs 已新增 `reply_source`、`used_llm`、`plan_mode`、`reason_if_bypassed`；各 reply path（含 L1 gate_skip）皆寫入對應值。GET /api/sandbox/prompt-preview 已擴充 brand_id、global_prompt_hash、brand_prompt_hash、final_assembled_*、可選 message= 時回傳 simulated_reply_source 與 would_use_llm。

---

## 五、txt 檔與後台 prompt 的關係

**現況**：  
- `ai客服人格.txt`、`全區域人格設定.txt` 未在專案內找到，可能為外部或未納版控。  
- 實際 runtime 使用的只有：**settings.system_prompt**（全域）+ **brands.system_prompt**（品牌）+ **程式碼內 handoffBlock**。

**原則**：不能再兩套並存、彼此脫鉤。二選一如下。

### 方案 A（建議）：以後台 DB prompt 為唯一正式來源，txt 只當備份文件

- **正式 source of truth**：全域 = `settings.system_prompt`，品牌 = `brands.system_prompt`；handoffBlock 維持程式碼或未來抽成「營運規則檔」但由部署管道更新，不與 txt 同步。
- **txt 角色**：僅作為**備份／說明文件**（例如匯出 DB 內容成 `ai客服人格.txt`、`全區域人格設定.txt`），或供離線查閱；**不參與 runtime 讀取**。
- **優點**：實作簡單、單一來源、後台所見即所得。  
- **落地**：在文件（如本報告或 系統回話邏輯.md）中寫明「人格／系統指令以後台設定為準；txt 若存在則僅為備份或離線參考」。

### 方案 B：建立 txt / version-controlled prompt 與 DB 的同步機制

- **來源**：以版控內的 txt 或 YAML 為「主稿」，部署或後台「同步到 DB」時寫入 `settings` / `brands.system_prompt`。
- **方向**：單向（txt → DB）或雙向（需解決衝突策略）。
- **缺點**：需額外同步腳本、權限與流程設計，且後台改動若不回寫版控會再次脫鉤。
- **適用**：若團隊強需求「所有 prompt 改動都走版控審查」再考慮。

**正式採用**：**方案 A** — DB prompt 為唯一正式來源，txt 僅作備份／離線參考，不參與 runtime。若之後要版控審查，可在方案 A 基礎上做「後台匯出 → 提交版控」或「CI 從 DB 匯出到 repo」的單向匯出。

---

## 六、若需改檔：先列清單再改

以下為「與兩層 prompt、runtime 組裝、短路路徑、trace 相關」的檔案清單；實際改碼時請依此範圍動工，並維持本報告的單一真相與權責切分。

### 6.1 後台 AI 與知識庫頁面（儲存／讀取）

| 檔案 | 用途 |
|------|------|
| `client/src/pages/knowledge.tsx` | 載入/儲存全域系統指令（GET/PUT /api/settings，key=system_prompt）、品牌專屬指令（PUT /api/brands/:id，system_prompt）；顯示「系統指令與知識庫」。 |
| `client/src/components/brand-channel-manager.tsx` | 品牌表單含「品牌專屬 AI 系統指令」欄位（brandForm.system_prompt），提交時寫入 brands。 |

### 6.2 Runtime prompt 組裝

| 檔案 | 用途 |
|------|------|
| `server/routes.ts` | `getEnrichedSystemPrompt`：讀取 global + brand，組裝 handoffBlock、humanHours、catalog、knowledge、image；本輪追加 handoff/F2/久候型等。 |

### 6.3 會繞過 LLM 的 short-circuit 路徑（皆在 routes.ts）

| 位置（概念） | 說明 |
|--------------|------|
| autoReplyWithAI 開頭 | L1 Gate：awaiting_human / high_risk / needs_human / isAiMuted → return（目前不寫 ai_log） |
| detectHighRisk 後 | L2 高風險 → createAiLog，return |
| classifyMessageForSafeAfterSale 後 | L3 安全確認模板 → createAiLog，return |
| hasRecentImageFromUser + isShortOrAmbiguousImageCaption | L4 圖片短標題模板 → createAiLog，return |
| plan.mode === "return_form_first" | L7 固定退換貨表單 → createAiLog，return |

### 6.4 需要新增或調整的 trace / preview / hash / debug

| 項目 | 檔案 | 說明 |
|------|------|------|
| ai_logs 新欄位 | `shared/schema.ts`（AiLog）、`server/storage.ts`（createAiLog）、`server/db.ts`（migrate ai_logs） | used_llm、plan_mode、whether_fixed_template、reason_if_bypassed（或 reply_source） |
| 各 path 寫入新欄位 | `server/routes.ts` | 每個 createAiLog 呼叫處傳入上列欄位 |
| Prompt preview 擴充 | `server/routes.ts`（GET /api/sandbox/prompt-preview 或新 debug 端點） | brand_id、channel_id（可選）、global_prompt_hash/version、brand_prompt_hash/version、handoff_contract_hash（可選）、final_assembled_preview/length |
| 文件 | `docs/系統回話邏輯.md` 或本報告 | 註明兩層 prompt 的 DB 來源、權責、與「哪些 path 不吃 prompt」；txt 採方案 A 或 B |

### 6.5 不改動但需對照的檔案

| 檔案 | 對照用途 |
|------|----------|
| `server/conversation-state-resolver.ts` | state 決定 intent/needs_human，不讀 prompt |
| `server/reply-plan-builder.ts` | plan.mode 決定本輪唯一 mode，不讀 prompt |
| `server/storage.ts` | getSetting("system_prompt")、getBrand().system_prompt 的實際讀取 |

---

## 七、總結

1. **兩層後台欄位**：全域 = `settings.system_prompt`，品牌 = `brands.system_prompt`；兩者皆為 runtime 正式來源，`getEnrichedSystemPrompt` 有讀取。  
2. **handoffBlock**：在 getEnrichedSystemPrompt 內、brandBlock 之後疊加，為程式碼內固定字串，不從 DB 讀。  
3. **只有 LLM 路徑**會吃到完整組裝 prompt；L1/L2/L3/L4/L7 均為短路，不吃 prompt。  
4. **權責**：全域＝底層規則，品牌＝人格/語氣/禁語，handoffBlock＝mode 補充說明不奪權；流程邏輯由 state/plan 決定。  
5. **Effective Preview / Trace**：擴充 sandbox prompt-preview（或 debug 端點）與 ai_logs 欄位，可區分「沒進 LLM」與「prompt 沒生效」。  
6. **txt 與 DB**：建議方案 A（DB 為唯一正式來源，txt 僅備份）；若選 B 需另做同步機制。  
7. **改檔清單**：已列於第六節；實作時先列清單再改，避免遺漏。

以上為改碼前的單一真相與落地依據；實際程式修改請依此報告與衝突診斷報告一併執行。
