# 本機隔離取證（非正式環境）

- **DATA_DIR**：`_evidence_run/data`（與專案根目錄 `omnichannel.db` 完全分離）。
- **指令**：
  ```powershell
  $env:DATA_DIR = (Resolve-Path ".\_evidence_run\data").Path
  npx tsx scripts/capture-minimal-live-evidence.ts
  ```
- **產物**：`_evidence_run/out/`（匿名 DB 匯出、`rawish_trace_local_capture.json`、見該目錄 `CAPTURE_SUMMARY.json`）。
- **勿提交**：`data/`、`out/` 建議由 `.gitignore` 排除；ZIP 審核包另行交付。
