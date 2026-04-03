# Phase 1.6 Final Evidence 執行總結

本檔需與實際產出之 `pilot_ai_logs_evidence.json` 對齊。若僅完成程式與 bundle、尚未以真 key 跑 harness，實測列應標「未執行」。

## 八題簡答

1. **是否經 ai-reply 主流程**：設計上僅經 `autoReplyWithAI`。無 OPENAI_API_KEY 時 harness exit 2，未寫四筆 log。
2. **是否真用 OPENAI_API_KEY**：成功產出 JSON 時為是；無金鑰環境為否。
3. **四 scenario 是否落庫**：成功跑完 `verify:phase16` 時為是；否則否。
4. **route_source 分布**：成功後見 JSON 內 `route_source_summary`；實測可為 **rule + llm** 混合（見下節），**legacy_fallback** 亦可能出現於其他訊息。
5. **tools_available_json 與 whitelist**：成功路徑下與 `filterToolsForScenario` 一致。
6. **tools_called**：視路徑而定，見各列與 `phase16_trace_summary_redacted.json` 之 `tools_called_present`。
7. **是否足支持隔離單品牌 pilot**：程式可支持；**真 key 跑通 harness 並產 zip 後**，可支持「隔離 DATA_DIR、單品牌 flags on」之 pilot 論證（仍非 production 全站）。
8. **為何不 merge main**：缺線上長鏈、多品牌、llm 樣本與運維演練；合併前應有可重現 pilot zip。

## 本機補齊證據

隔離 `DATA_DIR`，設定 `OPENAI_API_KEY` 或根目錄 `.env`，執行 `npm run verify:phase16` 再 `npm run zip:pilot-evidence`。

## 本輪 bundle 建置實測（無金鑰環境）

- `npm run bundle:impl-v4` 內嵌之 `verify_phase16.txt`：**exit code 2**，原因：無 `OPENAI_API_KEY` 且無 `.env`。
- `pilot_ai_logs_evidence.json`／**PHASE1_PILOT_FUNCTIONAL_EVIDENCE.zip**：**未產出**（見 bundle 內 `manifests/manifest.json` 之 `pilot_evidence`）。
- 請於具金鑰之本機重跑後，將本節更新為實際 `route_source_summary` 與 zip 路徑。

## Git（本輪收斂）

- **Feature branch**：`phase1/agent-ops-backend`（Phase 1／1.5／1.6 後端與取證腳本已提交於此分支）。
- **未 merge `main`**。
- **不納入版本庫**：各種 `*.zip`、`_BUNDLE_*_STAGING/`、`_evidence_run/` 下實跑產物（請本機產出後自行留存供審核）。

## 本機真取證紀錄（已成功跑一次）

以下摘自 `_evidence_run/phase16/pilot_ai_logs_evidence.json`（去敏；不含 API key）。

| 項目 | 實測 |
|------|------|
| **環境** | local；`DATA_DIR` 隔離：`…\_evidence_run\phase16_final` |
| **verify:phase16** | **成功**（exit **0**）；終端見 `[phase16-pilot-proof] OK wrote …pilot_ai_logs_evidence.json` |
| **zip:pilot-evidence** | **成功**；產物：repo 根目錄 **`PHASE1_PILOT_FUNCTIONAL_EVIDENCE.zip`** |
| **主流程** | `createAiReplyService().autoReplyWithAI`；**真使用** OpenAI（`used_llm: 1` 四筆） |
| **Webhook** | 否（腳本直連；日誌 `[LINE] pushLineMessage` 因無真 token 可略） |

### route_source_summary

```json
{ "rule": 2, "llm": 2 }
```

- **rule**：ORDER_LOOKUP（`order_id_in_sentence`）、AFTER_SALES（`return_refund_complaint`）
- **llm**：PRODUCT_CONSULT、GENERAL（`llm_classified`）
- **legacy_fallback**：本四則為 **0 筆**

### selected_scenario_summary

```json
{ "ORDER_LOOKUP": 1, "AFTER_SALES": 1, "PRODUCT_CONSULT": 1, "GENERAL": 1 }
```

### tools_called 與 whitelist

| 情境 | tools_available_json（摘要） | tools_called |
|------|-----------------------------|--------------|
| ORDER_LOOKUP | 含 `lookup_order_by_id` 等查單工具 + `transfer_to_human` | **`["lookup_order_by_id"]`**（LLM 呼叫查單） |
| AFTER_SALES | 僅 `transfer_to_human` | `[]` |
| PRODUCT_CONSULT | 僅 `transfer_to_human` | `[]` |
| GENERAL | 僅 `transfer_to_human` | `[]` |

`tools_available_json` 與 **tool whitelist／情境**一致；**response_source_trace** 四筆皆為 **`llm`**（回覆由 LLM 路徑產出）。

### 是否足支持 isolated single-brand pilot

**是**——在「隔離 DB、單一 pilot 品牌、flags 全開、真 key」前提下，四情境皆落庫且 trace 欄位齊備，並已產 **PHASE1_PILOT_FUNCTIONAL_EVIDENCE.zip**（內含 `pilot_ai_logs_evidence.json`、`README_PILOT_EVIDENCE.md`、`phase16_trace_summary_redacted.json`）。

### 提交審核請附（本機檔案，勿 commit 金鑰／zip 可選是否進 repo）

- `PHASE1_PILOT_FUNCTIONAL_EVIDENCE.zip`
- 終端完整輸出另存之 **`verify_phase16.txt`**（建議 UTF-8）
- 本檔（已更新）
