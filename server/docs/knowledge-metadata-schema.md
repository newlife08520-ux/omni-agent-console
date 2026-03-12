# knowledge_files Metadata 化方案（草案）

## 目標

每段知識具備適用條件，只有當「商品類別 + 當前意圖 + 當前 mode」都匹配時才注入 prompt，避免知識被全域亂套用。

## Schema 草案

### 新增欄位（knowledge_files）

| 欄位 | 型別 | 說明 |
|------|------|------|
| `category` | TEXT | 適用品類：`sweet` \| `bag` \| `cleaning` \| `skincare` \| `all`（空或 null 視為 all） |
| `intent` | TEXT | 適用意圖：`shipping` \| `return` \| `product_qa` \| `order_lookup` \| `all` |
| `allowed_modes` | TEXT | JSON 陣列，例：`["order_lookup","aftersales_comfort_first"]`；空或 null 表示全部允許 |
| `forbidden_modes` | TEXT | JSON 陣列，例：`["handoff","return_form_first"]`；這些 mode 下不得注入 |
| `tone` | TEXT | 語氣：`factual` \| `promo` \| `operational`；用於與 no-promo mode 交叉檢查 |

### 過濾邏輯（buildKnowledgeBlock）

組裝知識區塊時傳入當前 context：`productScope`、`planMode`。

- 若 `category` 非 `all` 且非 null，則當前 `productScope` 須與其一致（或當前未鎖定時不注入該段）。
- 若 `intent` 非 `all`，則當前主要意圖須與其一致。
- 若 `allowed_modes` 有值，則 `planMode` 須在該陣列內。
- 若 `forbidden_modes` 有值，則 `planMode` 不得在該陣列內。
- 若 `planMode` 為 no-promo（handoff / return_form_first / order_lookup 等），且該段 `tone === 'promo'`，則不注入。

## 逐步遷移

1. **Phase 1**：DB 新增上述欄位，預設皆為 null / 空，行為與現狀相同（全部注入）。
2. **Phase 2**：在管理後台或匯入流程支援編輯 category / intent / allowed_modes / forbidden_modes / tone。
3. **Phase 3**：`buildKnowledgeBlock(brandId, context?)` 改為接受 context，並依 metadata 過濾；未標記的檔案暫時視為 `all`，仍全部注入。
4. **Phase 4**：將現有知識逐批標記（見下），並觀察 content-guard 命中率是否下降。

## 哪些現有知識要先標記

目前**非**存在 `knowledge_files` 表、而是寫在程式裡的知識：

| 來源 | 內容摘要 | 建議 metadata |
|------|----------|----------------|
| routes handoffBlock 出貨說明 | 甜點類 3 天內出貨、其他 7–20 工作天 | 已改為依 `productScope` 動態組裝，未進 DB。若日後拆成知識檔：`category=sweet` 或 `other`，`intent=shipping`，`allowed_modes=["order_lookup","aftersales_comfort_first"]`，`forbidden_modes=["handoff"]`，`tone=factual` |

若專案內已有上傳的知識檔（`knowledge_files` 有資料）：

- **甜點／出貨相關**：`category=sweet`，`intent=shipping`，`allowed_modes=["order_lookup","aftersales_comfort_first"]`，`forbidden_modes=["handoff","return_form_first"]`，`tone=factual`。
- **清潔／商品說明**：`category=cleaning`，`intent=product_qa`，`allowed_modes=["answer_directly"]`，`forbidden_modes=["handoff","return_form_first","order_lookup"]`，`tone=factual`。
- **通用 FAQ**：`category=all`，`intent=all`，不設 allowed/forbidden，`tone=factual`。

## 檔案變更清單（實作時）

- `shared/schema.ts`：KnowledgeFile 新增可選欄位 category, intent, allowed_modes, forbidden_modes, tone。
- `server/db.ts`：migrate 為 knowledge_files 新增上述欄位。
- `server/storage.ts`：getKnowledgeFiles 回傳新欄位；若需依 context 過濾，可新增 getKnowledgeFilesForContext(brandId, context) 或於 buildKnowledgeBlock 內過濾。
- `server/routes.ts`：buildKnowledgeBlock(brandId, context?) 依 metadata 過濾後再組字串。
