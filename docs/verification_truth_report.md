# Verification 真相（skipped ≠ 全綠）

## 為什麼會看到 `skipped: REVIEW_BUNDLE_SKIP_LONG_VERIFY=1`？

執行 **`npm run pack:review-bundle:quick`** 時會設此變數，腳本**刻意不跑**：

- `npm run verify:phase34`（整鏈含 phase24～34）  
- 各 phase **單獨** `tsx server/phaseXX-verify.ts`  

並在 `verify_phase34.txt`、`verify_phase24.txt`… 寫入 stub。  
**這不是通過驗證**，只是「加快打包」。

## 何謂「權威、非 skipped」輸出？

請執行 **`npm run pack:review-bundle`**（**不要**設 `REVIEW_BUNDLE_SKIP_LONG_VERIFY`）。  
完整鏈結束後，打包腳本會另存：

- `verify_output/verify_phase34_full.txt`（與 `verify_phase34.txt` 同內容之完整執行 log）  
- `verify_output/verify_phase34b_full.txt`  
- `verify_output/verify_phase_chain_full.txt`（摘要：整鏈依賴 verify:phase34）

若檔內仍出現 `skipped`，代表該次打包仍走了 quick 路徑。

## 各 verify 性質（簡表）

| 腳本 | 性質 |
|------|------|
| `check:server` | TypeScript 編譯檢查 |
| `verify:phase34` 鏈 | 含多個 **fixture／靜態／行為級** tsx，**非**完整 E2E webhook |
| `verify:phase34b` | 行為級 fixture + 字串／結構斷言 |
| `verify:hardening` | 專案內建硬化檢查 |

**發布門檻**：請以 **非 skipped 的完整 log** 為準；quick 包不當 release gate。
