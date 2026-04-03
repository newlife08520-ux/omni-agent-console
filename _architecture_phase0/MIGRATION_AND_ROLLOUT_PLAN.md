# 遷移與上線計畫（Phase 1～4）

**前提**：Phase 0 僅盤點與審核包；**本檔為規劃**，實作以審核後 PR 為準。

---

## Phase 1 — 可觀測性 + 組態邊界（低破壞）

- 擴充 `ai_logs`（或平行 JSON）記錄：`prompt_profile`、`plan_mode`、`brand_id`、**建議中的** `scenario`（可先與 plan 對齊映射）。
- 定義 **brand-level feature flag**（DB 或 `settings` 命名空間 key），預設全關；先允許「僅記錄不啟用 whitelist」的 shadow mode（**推測實作方式**，待審核定案）。
- Knowledge：`knowledge_files` 的 tag／category 欄位若已存在則開始編輯 UI；若無則單一 `metadata_json` 欄位（**最小增量**）。

**驗證**：對話回放可看到與現行行為一致的 log；無使用者可見行為變化（或僅內部後台）。

---

## Phase 2 — Hybrid Router + Scenario（漸進）

- 實作硬規則 pre-router；LLM router 為 fallback。
- Prompt：依 scenario 選片段（對齊現 `order_lookup_prompt_diet` 經驗擴展）。
- Tool whitelist：**先**在 sandbox 或單一測試品牌啟用。

**Feature flag**：`scenario_routing_enabled`、`tool_whitelist_enabled` 分開，利於除錯。

---

## Phase 3 — 全品牌灰度 + Lite Admin

- 後台：品牌維度檢視「生效 scenario 對應表／tool 清單／最近錯誤路由」。
- 逐品牌開啟 whitelist；保留 **單鍵關閉**（回退全集 tools）。

---

## Phase 4 — Draft / Publish / Rollback（精簡版）

- 設定變更先寫 draft；publish 寫版本號；rollback 指回上一版 snapshot。
- 避免完整 SaaS 版控；**10 品牌**以「可讀 diff + 超管 rollback」為足。

---

## 單品牌試跑建議

1. 選 **訂單量大、投訴型少** 或 **內部可控** 的品牌。  
2. 先開 **log-only** → **whitelist on staging** → **production 10%**（若有多實例）→ 全開。  

---

## 最高風險

| 風險 | 說明 |
|------|------|
| Tool whitelist 過窄 | 客戶真查單時無 tool → 幻覺或卡住 |
| Router 誤分類 | AFTER_SALES 誤成 PRODUCT_CONSULT → 錯誤話術 |
| 雙寫設定不一致 | Admin 顯示與 runtime 讀不同來源 |

---

## 回滾

- **立即**：關閉 `tool_whitelist_enabled` 與 `scenario_routing_enabled`（回到現況全集 tools + 現有 prompt 路徑）。  
- **DB**：Phase 1～2 應 **加欄位為主**，避免破壞性 migration；rollback 以 flag 為主，不必還原 DB。

---

## 必須先做 vs 可延後

| 先做 | 可延後 |
|------|--------|
| Trace／log 欄位、shadow 觀測 | 完整 Draft UI |
| Hybrid 硬規則（可重用現有 resolver） | 純 LLM 主導 router |
| 單品牌 whitelist 試驗 | 多 Profile、複雜繼承 |
| Lite Admin 只讀除錯頁 | 炫技式監控大屏 |
