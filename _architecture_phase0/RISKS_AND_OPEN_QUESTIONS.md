# 風險與未決議題

---

## 高風險

| ID | 風險 | 緩解方向 |
|----|------|-----------|
| R1 | Tool whitelist 過窄 → 幻覺或無法查單 | 預設寬鬆；子模式規則開 lookup；監控 tool_calls |
| R2 | Router 誤判 → 錯情境 prompt | Hybrid + 低信心 fallback GENERAL + 人工抽樣 |
| R3 | 全域 `settings.system_prompt` 過長 | 與營運協議瘦身；分離「法遵」與「語氣」 |
| R4 | Meta 與一對一合併過急 | 分里程碑；Meta 沿用獨立表與路由 |

---

## 目前無法完全確認（待證據）

1. **Production DB** 各表筆數、知識檔是否已填 metadata——本包僅含 **開發機** `omnichannel.db` 取樣（若匯出成功）。  
2. **`ai_logs` 實際欄位內容**是否已含足夠 trace——依匯出列判斷；若無列則 **0 筆或表空**。  
3. **Worker 與 API 路徑**是否 100% 共用同一套 prompt／tools 邏輯——需 diff `ai-reply.worker` 與 service（本 Phase 0 以 `ai-reply.service.ts` 為主證據）。  
4. **Instagram** 是否納入短期 channel 綁定——schema 以 line/messenger 為主（見 `shared/schema.ts`）。  

---

## 資料／log 缺口

- `docs/runtime-audit/superlanding-esc20981-linepay-fail.fixture.sanitized.json`：**repo 內不存在** → `verify:r1` 失敗（見 verify_logs）。  
- 正式 **LINE／Meta webhook** 原始 payload：**不可**放入審核包；僅能放 **masked 範本**（見 `runtime_snapshot/masked_samples` 或既有 `review_bundle/samples` 複本）。  

---

## 需 ChatGPT（或人類）審核後才能定案

- 四情境是否涵蓋所有 `primary_intent`（例如 complaint 是否獨立）。  
- 第一個試跑品牌與 **flag 預設值**（全關 vs shadow）。  
- Knowledge 分類由 **營運**定義還是先技術 tag 自由填。  
