# Phase 1.7 隔離單品牌 Pilot 執行清單（Runbook）

> **範圍**：僅 **一個** pilot 品牌、**不**做多品牌 rollout、**不**做 UI／畫布、**不** merge `main`。  
> **前提**：後端已於 feature branch `phase1/agent-ops-backend` 就緒；真取證見 `PHASE1_6_FINAL_EVIDENCE_SUMMARY.md`。

---

## 1. 哪個品牌適合先開

| 條件 | 說明 |
|------|------|
| **單一指定** | 由產品／營運 **書面指定一個 brand_id**，試驗期間不擴第二個品牌。 |
| **流量與風險** | 優先 **量較小或可承受誤判** 的品牌；避免一開始就上主力檔期品牌。 |
| **技術就緒** | 查單路徑若需驗證：該品牌 **SuperLanding／Shopline 等憑證** 已設定且可查測試單（與 phase16 harness 類似情境）。 |
| **人員** | 有 **專責窗口** 可每日看對話與 trace，異常時可即時人工接手。 |

**不適合**：同時把多個品牌設 `enabled: true`（超出 isolated pilot 範圍）。

---

## 2. 哪些 flags 要開（pilot 標準組）

寫入 **`brands.phase1_agent_ops_json`**（單一 pilot 品牌），建議首輪：

```json
{
  "enabled": true,
  "hybrid_router": true,
  "scenario_isolation": true,
  "tool_whitelist": true,
  "trace_v2": true
}
```

| Flag | Pilot 建議 | 用途摘要 |
|------|------------|----------|
| **enabled** | **必開** | 總開關；關閉則整段 Phase1 不生效。 |
| **hybrid_router** | **開** | 硬規則 + LLM／legacy 混合路由。 |
| **scenario_isolation** | **開** | 情境化 prompt 區塊，降低跨情境污染。 |
| **tool_whitelist** | **開** | 依情境限制可呼叫工具。 |
| **trace_v2** | **開** | `ai_logs` 寫入 `selected_scenario`、`route_source`、`tools_available_json` 等，供營運與除錯。 |

---

## 3. 哪些 flags／選項先不要開（或延後）

| 項目 | 建議 |
|------|------|
| **allow_after_sales_order_verify** | **先關**（`false` 或省略）。除非業務明確要在售後情境開查單工具並已測過誤觸風險。 |
| **scenario_overrides** | **先不填或極小**（例如僅一句 `prompt_append`）。避免首週就疊多情境覆寫，難以判斷回歸來源。 |
| **logistics_hint_override** | 非必要可先省略；必要時再補一句，避免與品牌長文 SOP 打架。 |
| **其他品牌同開 Phase1** | **禁止**於 pilot 第一階段（維持單品牌）。 |

---

## 4. 如何快速回滾

**首選（秒級、無需 deploy）**

1. 將該品牌 `phase1_agent_ops_json` 改為 **`"enabled": false`**（或清空欄位）。  
2. 重啟 worker／API（若你們有快取品牌設定；無快取則下一則訊息即生效）。  

**效果**：回到 **Phase1 前**行為（與 `parsePhase1BrandFlags` 預設一致）；`ai_logs` 新欄位可為 null，舊讀取邏輯應忽略。

**詳細**：`_architecture_phase1/PHASE1_6_ROLLBACK_RECHECK.md`、`PHASE1_RISK_AND_ROLLBACK.md`。

---

## 5. 如何人工接手

| 機制 | 說明 |
|------|------|
| **客戶端轉人工** | 模型可呼叫 **`transfer_to_human`**（白名單內）；或既有 **handoff／高風險短路** 流程。 |
| **後台標記** | 將聯絡人 **`needs_human`／`awaiting_human`** 等狀態交既有案件流程（以你們 Console 既有操作為準）。 |
| **AI 靜音** | 必要時使用既有 **AI mute／值班時段** 規則，避免試驗中機器人與人工搶話。 |
| **Runbook 原則** | Pilot 期間 **指定值班客服** 看「試驗品牌」收件匣；異常對話 **不**依賴自動結案。 |

（本 runbook **不**新增 UI；僅描述既有能力。）

---

## 6. 每日要追哪些 trace 指標

資料來源：**`ai_logs`**（`trace_v2` 開啟時）。建議 **每日**對 **pilot brand_id** 篩選：

| 指標 | 欄位／做法 | 目的 |
|------|------------|------|
| **情境分布** | `selected_scenario` 計數 | 是否過度集中在某一情境或異常為 null。 |
| **路由來源** | `route_source`（rule／llm／legacy_fallback） | LLM 比例突增＝可能有邊界句或解析問題。 |
| **工具使用** | `tools_called`、`reply_source` | 查單工具是否異常暴增、錯誤 tool 名稱。 |
| **可用工具快照** | `tools_available_json`（抽樣） | 與預期 whitelist 是否一致（尤其 ORDER_LOOKUP vs AFTER_SALES）。 |
| **延遲** | `response_time_ms`、`first_customer_visible_reply_ms`（若有） | 體感變慢或 timeout 前兆。 |
| **轉人工率** | `transfer_triggered`、`reply_source=handoff` 等 | 業務是否被轉人工壓垮。 |

**建議**：固定輸出 **簡單 SQL／報表範本**（由 DBA／工程執行），例如：昨日 pilot 品牌 `COUNT(*)` by `selected_scenario`、`route_source`。

---

## 7. 試驗前檢查表（Checklist）

- [ ] 僅 **一個** `brand_id` 設為 pilot，`phase1_agent_ops_json` 已套用 **§2** JSON。  
- [ ] 其他品牌 **enabled 均為 false** 或未設定。  
- [ ] **OpenAI**（或你們實際模型）**API key** 在環境或設定中有效。  
- [ ] 值班與 **回滾負責人** 已讀 **§4、§5**。  
- [ ] 已約定 **試驗起訖日**；結束後要嘛關閉 Phase1，要嘛進入下一階段評估（**仍不**代表可 merge `main`）。

---

## 8. 與版本庫的關係

- 實作與文件：**feature branch `phase1/agent-ops-backend`**。  
- **不要**將本 pilot 合併進 **`main`**，直到產品／技術另行簽核（見 `PHASE1_6_GO_NO_GO.md`）。

---

**文件版本**：Phase 1.7 isolated pilot 營運用；不含 UI／畫布／多品牌 rollout 規格。
