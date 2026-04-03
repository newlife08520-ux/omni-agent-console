# Gemini 提案落差分析（客觀）

**對照來源**：`docs/multi-brand-agent-ops/gemini-10-pack/`（與上一層 `docs/multi-brand-agent-ops/*.md` 等價內容）。**本檔不吹捧、不為反對而反對**。

---

## A. 正確且值得採用的部分

| 提案要點 | 評語 |
|-----------|------|
| **Multi-agent（語意上：單輪單主腦 + 情境分工）** | 與現有 `reply-plan-builder`「一輪一 mode」一致；升級為 **Scenario** 後更易營運溝通。 |
| **Scenario isolation** | 與現況痛點一致：prompt 大雜燴、tool 全集；提案中 diet 與分情境片段 **對齊**已存在的 `order_lookup_prompt_diet`。 |
| **Tool whitelist** | 技術上必要；現況 `ai-reply.service` 確為全集合併，為誤用 tool 高風險區。 |
| **Prompt 物理隔離（分片段、分情境注入）** | 正確方向；需搭配 metadata／組態，否則仍會在「全域 system_prompt」處破功。 |
| **LLM Router 的價值** | 適合處理 **規則難寫邊界**（口語、多意圖、省略主詞）；應為 **補位** 而非唯一大腦。 |
| **Hybrid Router** | 與 CTO 指令與現有大量硬規則資產一致；Gemini 包 **07** 已寫硬規則優先。 |
| **E2E simulation / 測試矩陣** | 多品牌、多情境下 **必要**；Gemini **10** 測試矩陣方向正確（實際結果需以 CI／手動跑為準）。 |

---

## B. 需要修正或避免「太絕對」之處

| 議題 | 說明 |
|------|------|
| **Pure LLM Router 取代全部硬規則** | **不可**。法律／高風險關鍵字、訂單號格式、付款狀態推導等應維持 **決定性**；否則不可審計、不可除錯。 |
| **Hybrid 的必要性** | 已在 Gemini **07** 採納；實作時應明訂 **confidence 門檻**與 **fallback GENERAL** 行為，避免 LLM 無限擴權。 |
| **AFTER_SALES 絕對禁止查單工具** | **過度絕對**。現況 `aftersales_comfort_first` 明確要「先安撫＋查詢出貨」；售後語境常 **合法**需要 lookup。應改為 **預設關 + 規則子模式允許**。 |
| **Phase 0 先於「Phase 102」** | 若「Phase 102」意指 **跳過盤點直接做 Router／Schema 大改**：風險是重複既有 resolver 邏輯、與現有 `ReplyPlanMode` 衝突、難以回滾。**應先完成 Phase 0 與 shadow log**。 |
| **Lite Admin / trace 優先於炫技** | 10 品牌內部營運 **先能看見**「為何選此情境、開了哪些 tool」比先做複雜多 Agent UI 更有 ROI；與 Gemini **08～09** 方向一致。 |

---

## C. 最適合本專案的執行順序（建議）

1. **現在（Phase 0 後）**：凍結「大改行為」→ 上 **觀測**（scenario 映射 log、prompt_profile、tool 呼叫列表）；修復 **verify:r1** 等與 **fixture 缺失**（見 `MISSING_FILES_AND_ASSUMPTIONS.md`）。  
2. **下一步**：Hybrid **硬規則**抽出為單一模組介面（內部仍呼叫現有函式）；LLM router **可選**、預設關。  
3. **再下一步**：依 scenario 切 **prompt 片段**；**shadow** tool whitelist（記錄「若啟用會擋哪些 tool」）。  
4. **再來**：單品牌啟用 whitelist + 後台只讀除錯。  
5. **可晚做**：完整 draft/publish UI、多 Agent 並行對話、通用 SaaS 級 schema、大畫布編排器。

---

## Gemini 建議分類摘要

| 判定 | 項目 |
|------|------|
| **可立即採用（概念／文件層）** | Hybrid Router、四情境、tool whitelist、trace 欄位、與 `buildReplyPlan` 漸進整合（Gemini 07 選項 A）。 |
| **需修正後採用** | 任何「售後一律禁止查單 tool」表述；過早移除硬規則；過度複雜繼承 UI。 |
| **應延後** | 多 Agent 同時對話、完整版控產品化、與內部 10 品牌無關的通用抽象。 |
