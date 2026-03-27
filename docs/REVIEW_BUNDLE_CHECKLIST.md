# Review Bundle 產物對照表

## 在哪裡執行打包？

- **正確目錄**：內層 **`Omni-Agent-Console/`**（須同時有 `package.json` 與 **`server/`**）。
- **外層倉庫根**（僅有轉發用 `package.json` 時）：可執行  
  `npm run pack:review-bundle` 或 `npm run pack:review-bundle:quick`（會 `cd Omni-Agent-Console` 再跑）。
- ZIP 預設寫入 **內層專案根**，並嘗試複製到**桌面**。
- **`pack-review-bundle.ps1`**：自 `scripts\` 目錄往上找第一個同時具備 **`package.json` + `server/`** 的資料夾當專案根，避免誤把 `scripts` 當根而產生 `scripts\scripts\…` 或極小無效 ZIP。
- 若 npm 出現 **`ENOENT package.json`**：代表內層 **`Omni-Agent-Console` 目錄不完整**，請確認本機／同步後該資料夾內有完整專案再打包。

## 疑難排解（Windows）

| 現象 | 處理 |
|------|------|
| **`%1 不是有效的 Win32 應用程式`** | 舊版曾對 `npm`／`npm.ps1` 直接 `Start-Process`。請使用目前腳本：**經 `cmd.exe /c` 呼叫 `npm.cmd`／`npx.cmd`**（已內建於 `pack-review-bundle.ps1`）。 |
| **`exit -4058`、找不到 module、ZIP 只有幾十 KB** | 專案根被誤判為 `scripts\`。請在 **`Omni-Agent-Console`**（與 `server/` 同層）執行，或由倉庫根執行轉發的 `npm run pack:review-bundle:quick`。腳本會往上尋找 **`package.json` + `server/`**。 |
| **完整包沒產生** | 總體積壓縮後若 **> 499 MiB** 會**刻意略過**完整包，請改用 **EVIDENCE** + **SOURCE-Pxx** 多卷。 |

## 已在專案 `docs/` 內（會一併拷進 ZIP 的 `docs/`）

| 項目 | 檔案 |
|------|------|
| Shopline／索引「全為 0」說明 | `shopline_truth_report.md` |
| DB／匯出 parity、verify 為何 skipped | `EXPORT_PARITY_FOLLOWUP_20260323.md` |
| 官網查單 DEMO 遮罩範例（非 live API） | `review-bundle/shopline_lookup_success_demo.masked.md` |

## 僅在打包 staging 的 `verify_output/`（ZIP 內）

| 項目 | 檔案 |
|------|------|
| DB 診斷 JSON | `diagnose_review_bundle_db.txt` |
| 訂單索引統計 | `stats_order_index.txt` |
| 遮罩後的 system prompt 素材 | `system_prompt_effective.md` |
| phase34 整鏈／phase24～33 單跑日誌 | `verify_phase34.txt`、`verify_phase24.txt`… |

- **完整 verify（不 skip）**：請執行 `npm run pack:review-bundle`，且**不要**設定 `REVIEW_BUNDLE_SKIP_LONG_VERIFY`。通常需 **5～20+ 分鐘**。
- **快速包（verify_phase34 與 phase24～33 為 stub）**：`npm run pack:review-bundle:quick`

## ZIP 輸出路徑（每次打包戳記相同後綴）

| 類型 | 檔名 |
|------|------|
| **完整包** | `Omni-Agent-Console-REVIEW-BUNDLE_*.zip`（**超過 499 MiB 會自動略過**，不產檔） |
| **證據包** | `REVIEW-EVIDENCE_*.zip`；過大時改 **EVIDENCE-P01 / P02** 兩卷 |
| **原始碼包** | `REVIEW-SOURCE-P01_*.zip`、`P02`…（每個 zip **≤ 499 MiB**；解壓後合併 `source/`） |

- 專案根＋桌面會有上述檔案（完整包可能沒有）。
- **499 MiB**：單一 `.zip` 檔案上限（腳本內建）。

## 體積

完整樹往往超過 500MB，此時**只會留下**證據包 + 多卷 `SOURCE-Pxx`；審查時兩類一併傳即可。
