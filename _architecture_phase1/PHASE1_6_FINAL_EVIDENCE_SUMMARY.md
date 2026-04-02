# Phase 1.6 Final Evidence 執行總結

本檔需與實際產出之 `pilot_ai_logs_evidence.json` 對齊。若僅完成程式與 bundle、尚未以真 key 跑 harness，實測列應標「未執行」。

## 八題簡答

1. **是否經 ai-reply 主流程**：設計上僅經 `autoReplyWithAI`。無 OPENAI_API_KEY 時 harness exit 2，未寫四筆 log。
2. **是否真用 OPENAI_API_KEY**：成功產出 JSON 時為是；無金鑰環境為否。
3. **四 scenario 是否落庫**：成功跑完 `verify:phase16` 時為是；否則否。
4. **route_source 分布**：成功後見 JSON 內 `route_source_summary`；預設四句多為 rule 或 legacy_fallback。
5. **tools_available_json 與 whitelist**：成功路徑下與 `filterToolsForScenario` 一致。
6. **tools_called**：視路徑而定，見各列與 `phase16_trace_summary_redacted.json` 之 `tools_called_present`。
7. **是否足支持隔離單品牌 pilot**：程式可支持；證據包須含真 key 跑出的 zip。
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

## 本機真取證通過後請回填（審核用）

於具 `OPENAI_API_KEY`、隔離 `DATA_DIR` 下執行 `npm run verify:phase16` 與 `npm run zip:pilot-evidence` 成功後，請將下列內容自 `pilot_ai_logs_evidence.json` 摘錄至此段（或另附檔）：

| 項目 | 回填 |
|------|------|
| verify:phase16 | （成功／失敗，exit code） |
| route_source_summary | （JSON 物件） |
| selected_scenario_summary | （JSON 物件） |
| tools_called | （四筆是否皆非空；或列 tool 名稱／`return_form_first` 等） |
| 足支持 isolated single-brand pilot | （是／否與一句理由） |

**一併提交審核之檔案（本機產出，勿 commit 金鑰）**：`PHASE1_PILOT_FUNCTIONAL_EVIDENCE.zip`、本次終端完整輸出另存之 `verify_phase16.txt`、本檔更新後版本。
