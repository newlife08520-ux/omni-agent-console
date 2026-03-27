# ChatGPT 審查用固定規格 ZIP：Omni-Agent-Console-REVIEW-BUNDLE_YYYYMMDD_HHMMSS.zip
# 若完整包 > 499 MiB：略過單檔全包，改產出
#   Omni-Agent-Console-REVIEW-BUNDLE_PART01_*（source + verify_output + MANIFEST.md + REVIEW_SUMMARY.md）
#   Omni-Agent-Console-REVIEW-BUNDLE_PART02_*（docs + runtime_evidence + sanitized_cases + db_export_masked）
#   若 PART01 仍超上限：PART01 僅 verify + 兩份 md；source 改為 PART03、PART04…（同前綴）
# 編碼：請維持 UTF-8 **含 BOM**。Windows PowerShell 5.1 對無 BOM 的 .ps1 會用系統 ANSI（如 Big5）解讀，易造成 here-string 錯亂、BUILD_INFO 空白、ZIP 未產生。
# 結構：REVIEW_BUNDLE/{source,docs,db_export_masked,runtime_evidence,verify_output,sanitized_cases,MANIFEST.md,REVIEW_SUMMARY.md}
# source 含 server/、client/、shared/、package.json、package-lock.json 等（排除 node_modules、*.db、.env）
# 執行前（依序）：check:server -> verify:phase34 -> verify:hardening -> stats:order-index -> diagnose:review-db -> emit-runtime-parity-artifacts -> verify:bundle-safety -> phase34b -> phase24-33 tsx；robocopy 排除 .local、data、data_coldstart 與審查 zip
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$VerbosePreference = "SilentlyContinue"
# 專案根：優先找「package.json + server/」；否則找含 server/ 的目錄（略過誤設為 scripts 當根）
$proj = $null
$pWalk = $PSScriptRoot
while ($pWalk) {
  if ((Test-Path (Join-Path $pWalk "package.json")) -and (Test-Path (Join-Path $pWalk "server"))) {
    $proj = $pWalk
    break
  }
  $next = Split-Path -Parent $pWalk
  if ($next -eq $pWalk) { break }
  $pWalk = $next
}
if (-not $proj) {
  $pWalk = $PSScriptRoot
  while ($pWalk) {
    if (Test-Path (Join-Path $pWalk "server")) {
      $proj = $pWalk
      break
    }
    $next = Split-Path -Parent $pWalk
    if ($next -eq $pWalk) { break }
    $pWalk = $next
  }
}
if (-not $proj -or -not (Test-Path (Join-Path $proj "server"))) {
  throw "找不到專案根（需含 server/）。腳本位置: $PSScriptRoot"
}
if (-not (Test-Path (Join-Path $proj "package.json"))) {
  throw "專案根 $proj 缺少 package.json。請在 **Omni-Agent-Console** 目錄內執行（與 server/ 同層），或在上層目錄執行轉發腳本：`npm run pack:review-bundle:quick`（需存在子目錄 Omni-Agent-Console）。"
}

$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$zipName = "Omni-Agent-Console-REVIEW-BUNDLE_$stamp.zip"
$zipNameEvidence = "Omni-Agent-Console-REVIEW-EVIDENCE_$stamp.zip"
$zipPath = Join-Path $proj $zipName
$zipPathEvidence = Join-Path $proj $zipNameEvidence
# 單一 zip 上限（位元組；499 MiB，低於常見「500MB」限制）
$script:MaxZipBytes = [int64](499 * 1024 * 1024)
# 組 batch 時未壓縮預算（壓縮後通常遠小於此）
$script:SourceBatchUncompressedBudget = [int64](380 * 1024 * 1024)
$base = Join-Path $env:TEMP "OmniReviewBundle_$stamp"
$root = Join-Path $base "REVIEW_BUNDLE"
$verifyOut = Join-Path $root "verify_output"
$src = Join-Path $root "source"
$docsDst = Join-Path $root "docs"
$rt = Join-Path $root "runtime_evidence"
$san = Join-Path $root "sanitized_cases"
$dbMasked = Join-Path $root "db_export_masked"

function Ensure-Dir($p) { New-Item -ItemType Directory -Path $p -Force | Out-Null }
Ensure-Dir $verifyOut
Ensure-Dir $src
Ensure-Dir $docsDst
Ensure-Dir $rt
Ensure-Dir $san
Ensure-Dir $dbMasked

Write-Host ""
Write-Host "[pack:review-bundle] 已開始。各 npm / npx 的完整輸出寫入 staging 內 verify_output/*.txt（畫面上只顯示步驟名）。" -ForegroundColor DarkCyan
Write-Host ""

# 透過 cmd.exe 執行 npm.cmd / npx.cmd（stdout+stderr 重導到檔案），避免：
# - Start-Process 指向 npm.ps1 或錯誤路徑 →「不是有效的 Win32 應用程式」
# - PowerShell 2>&1 整包載入記憶體 → 長時間無回應
function Escape-CmdInnerPath([string]$p) {
  return ($p -replace '"', '""')
}

function Run-Capture($label, $npmTokens, $outFile) {
  Write-Host ">>> $label -> $outFile"
  $log = Join-Path $verifyOut $outFile
  $projQ = Escape-CmdInnerPath $proj
  $logQ = Escape-CmdInnerPath $log
  $parts = New-Object System.Collections.Generic.List[string]
  foreach ($t in $npmTokens) {
    $s = [string]$t
    if ($s -match '[\s^&|<>()]') {
      [void]$parts.Add(('"' + ($s -replace '"', '""') + '"'))
    } else {
      [void]$parts.Add($s)
    }
  }
  $npmArgs = $parts -join ' '
  $inner = 'cd /d "' + $projQ + '" && call npm.cmd ' + $npmArgs + ' > "' + $logQ + '" 2>&1'
  $p = Start-Process -FilePath $env:ComSpec -ArgumentList @('/c', $inner) -Wait -PassThru -NoNewWindow
  $code = $p.ExitCode
  [System.IO.File]::AppendAllText($log, (([Environment]::NewLine) + '--- exit_code: ' + $code + ' ---'))
  if ($code -ne 0) { Write-Warning ($label + ': exit ' + $code + ' [log saved]') }
}

function Run-CaptureTsx($relPath, $outName) {
  Write-Host ">>> tsx $relPath -> $outName"
  $log = Join-Path $verifyOut $outName
  $fp = Join-Path $proj $relPath
  if (-not (Test-Path -LiteralPath $fp)) { return }
  $projQ = Escape-CmdInnerPath $proj
  $logQ = Escape-CmdInnerPath $log
  $fpQ = Escape-CmdInnerPath $fp
  $inner = 'cd /d "' + $projQ + '" && call npx.cmd tsx "' + $fpQ + '" > "' + $logQ + '" 2>&1'
  $p = Start-Process -FilePath $env:ComSpec -ArgumentList @('/c', $inner) -Wait -PassThru -NoNewWindow
  $code = $p.ExitCode
  [System.IO.File]::AppendAllText($log, (([Environment]::NewLine) + '--- exit_code: ' + $code + ' ---'))
  $note = ([Environment]::NewLine) + '--- note: standalone tsx only; full chain see verify_phase34.txt ---'
  [System.IO.File]::AppendAllText($log, $note)
  if ($code -ne 0) { Write-Warning ("tsx $relPath exit $code [log saved]") }
}

# tsx 腳本 + 一個參數（例如輸出目錄）；stdout 寫入 log，腳本本身可另寫檔
function Run-CaptureTsxOneArg($relPath, $arg1, $outName) {
  Write-Host ">>> tsx $relPath (1 arg) -> $outName"
  $log = Join-Path $verifyOut $outName
  $fp = Join-Path $proj $relPath
  if (-not (Test-Path -LiteralPath $fp)) { return }
  $projQ = Escape-CmdInnerPath $proj
  $logQ = Escape-CmdInnerPath $log
  $fpQ = Escape-CmdInnerPath $fp
  $a1Q = Escape-CmdInnerPath $arg1
  $inner = 'cd /d "' + $projQ + '" && call npx.cmd tsx "' + $fpQ + '" "' + $a1Q + '" > "' + $logQ + '" 2>&1'
  $p = Start-Process -FilePath $env:ComSpec -ArgumentList @('/c', $inner) -Wait -PassThru -NoNewWindow
  $code = $p.ExitCode
  [System.IO.File]::AppendAllText($log, (([Environment]::NewLine) + '--- exit_code: ' + $code + ' ---'))
  if ($code -ne 0) { Write-Warning ("tsx $relPath (arg) exit $code [log saved]") }
}

Run-Capture "check:server" @("run", "check:server") "check_server.txt"

if ($env:REVIEW_BUNDLE_SKIP_LONG_VERIFY -eq "1") {
  Write-Warning "REVIEW_BUNDLE_SKIP_LONG_VERIFY=1：略過 verify:phase34 與 phase24～33 單獨 tsx（加快打包）。完整審查請勿設此變數。"
  $skipPhase34Msg = "skipped: REVIEW_BUNDLE_SKIP_LONG_VERIFY=1" + [Environment]::NewLine + "full chain: npm run verify:phase34"
  $skipPhase34Msg | Out-File -FilePath (Join-Path $verifyOut "verify_phase34.txt") -Encoding utf8
  Copy-Item -LiteralPath (Join-Path $verifyOut "verify_phase34.txt") -Destination (Join-Path $verifyOut "verify_phase34_full.txt") -Force
} else {
  Write-Host ""
  Write-Host "================================================================" -ForegroundColor Cyan
  Write-Host "  接下來：npm run verify:phase34（內含 phase24～34 整鏈）" -ForegroundColor Cyan
  Write-Host "  通常需 5～20 分鐘，這段時間可能沒有新輸出——請勿關閉視窗。" -ForegroundColor Cyan
  Write-Host "  進度可查：%TEMP% 下 OmniReviewBundle_* 或工作管理員中的 node.exe" -ForegroundColor DarkGray
  Write-Host "  要快排：請改跑 npm run pack:review-bundle:quick（略過此步與 phase24～33 單跑）" -ForegroundColor Yellow
  Write-Host "================================================================" -ForegroundColor Cyan
  Write-Host ""
  Run-Capture "verify:phase34" @("run", "verify:phase34") "verify_phase34.txt"
  Copy-Item -LiteralPath (Join-Path $verifyOut "verify_phase34.txt") -Destination (Join-Path $verifyOut "verify_phase34_full.txt") -Force
  Write-Host "[完成] verify:phase34 -> verify_output/verify_phase34.txt" -ForegroundColor Green
}

Run-Capture "verify:hardening" @("run", "verify:hardening") "verify_hardening.txt"
Run-Capture "stats:order-index" @("run", "stats:order-index") "stats_order_index.txt"
Run-Capture "diagnose:review-db" @("run", "diagnose:review-db") "diagnose_review_bundle_db.txt"
# runtime parity 產物寫入 verify_output（另見 emit_runtime_parity_console.txt）
$emitScript = "server/scripts/emit-runtime-parity-artifacts.ts"
if (Test-Path (Join-Path $proj $emitScript)) {
  Run-CaptureTsxOneArg $emitScript $verifyOut "emit_runtime_parity_console.txt"
}
Run-Capture "verify:bundle-safety" @("run", "verify:bundle-safety") "verify_bundle_safety_script.txt"
Run-Capture "verify:phase34b" @("run", "verify:phase34b") "verify_phase34b.txt"
if (Test-Path (Join-Path $verifyOut "verify_phase34b.txt")) {
  Copy-Item -LiteralPath (Join-Path $verifyOut "verify_phase34b.txt") -Destination (Join-Path $verifyOut "verify_phase34b_full.txt") -Force
}

# 僅執行單一腳本之本體輸出（不含整鏈），供對照 phase24～33 是否存在；失敗仍寫檔
$phaseScripts = @(
  @{ n = "verify_phase24.txt"; f = "server/phase24-verify.ts" },
  @{ n = "verify_phase25.txt"; f = "server/phase25-verify.ts" },
  @{ n = "verify_phase26.txt"; f = "server/phase26-verify.ts" },
  @{ n = "verify_phase27.txt"; f = "server/phase27-verify.ts" },
  @{ n = "verify_phase29.txt"; f = "server/phase29-verify.ts" },
  @{ n = "verify_phase30.txt"; f = "server/phase30-verify.ts" },
  @{ n = "verify_phase31.txt"; f = "server/phase31-verify.ts" },
  @{ n = "verify_phase32.txt"; f = "server/phase32-verify.ts" },
  @{ n = "verify_phase33.txt"; f = "server/phase33-verify.ts" }
)
if ($env:REVIEW_BUNDLE_SKIP_LONG_VERIFY -eq "1") {
  foreach ($ps in $phaseScripts) {
    $stub = Join-Path $verifyOut $ps.n
    "skipped: REVIEW_BUNDLE_SKIP_LONG_VERIFY=1" | Out-File -FilePath $stub -Encoding utf8
  }
} else {
  Write-Host ">>> 單獨執行 phase24～33 驗收腳本（共 9 支，約 2～8 分鐘）…" -ForegroundColor DarkCyan
  foreach ($ps in $phaseScripts) {
    $fp = Join-Path $proj $ps.f
    if (Test-Path $fp) { Run-CaptureTsx $ps.f $ps.n }
  }
  Write-Host "[完成] phase24～33 單跑輸出已寫入 verify_output/" -ForegroundColor Green
}

# phase24～33 合併檔（skipped 時為 stub，勿當整鏈綠燈）
$chainFull = Join-Path $verifyOut "verify_phase_chain_full.txt"
$chainParts = @(
  "verify_phase24.txt", "verify_phase25.txt", "verify_phase26.txt", "verify_phase27.txt",
  "verify_phase29.txt", "verify_phase30.txt", "verify_phase31.txt", "verify_phase32.txt", "verify_phase33.txt"
)
if ($env:REVIEW_BUNDLE_SKIP_LONG_VERIFY -eq "1") {
  "skipped: REVIEW_BUNDLE_SKIP_LONG_VERIFY=1 — phase24～33 單跑未執行；勿當整鏈綠燈。" | Out-File -FilePath $chainFull -Encoding utf8
} else {
  $sb = New-Object System.Text.StringBuilder
  foreach ($n in $chainParts) {
    $pth = Join-Path $verifyOut $n
    [void]$sb.AppendLine("========== $n ==========")
    if (Test-Path -LiteralPath $pth) {
      $raw = Get-Content -LiteralPath $pth -Raw -ErrorAction SilentlyContinue
      if ($null -ne $raw) { [void]$sb.AppendLine($raw) }
    } else {
      [void]$sb.AppendLine("(missing)")
    }
    [void]$sb.AppendLine("")
  }
  $sb.ToString() | Out-File -FilePath $chainFull -Encoding utf8
}

# --- source（排除敏感與巨型目錄）---
Write-Host ">>> robocopy -> source/（專案大時可能數分鐘，請稍候）"
robocopy $proj $src /E /NFL /NDL /NJH /NJS /NP `
  /XD node_modules .git dist build uploads .cursor mcps coverage .vite .next .cache tmp logs __pycache__ .idea .local data data_coldstart `
  /XF *.db *.db-shm *.db-wal *.log .env .env.local .env.production .env.development *REVIEW-BUNDLE*.zip *REVIEW-EVIDENCE*.zip *REVIEW-SOURCE*.zip `
  | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy source failed: $LASTEXITCODE" }

# 再移除誤入的審查 zip（robocopy /XF 可能漏網之魚）
Get-ChildItem -Path $src -Recurse -Force -Include "*REVIEW-BUNDLE*.zip", "*REVIEW-EVIDENCE*.zip", "*REVIEW-SOURCE*.zip" -ErrorAction SilentlyContinue |
  Remove-Item -Force -ErrorAction SilentlyContinue

# 再刪除誤拷的 .env*
Get-ChildItem -Path $src -Recurse -Force -Include ".env*","*.pem","*service-account*.json" -ErrorAction SilentlyContinue |
  Remove-Item -Force -ErrorAction SilentlyContinue

# --- /docs（與 source/docs 同內容，方便審查者直達）---
if (Test-Path (Join-Path $proj "docs")) {
  robocopy (Join-Path $proj "docs") $docsDst /E /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy docs failed: $LASTEXITCODE" }
}

# --- AI 匯出（已 redact 設計）---
$ctxOut = Join-Path $verifyOut "ai_bundle_context_export.json"
Push-Location $proj
try { node scripts/export-ai-bundle-context.mjs $ctxOut } finally { Pop-Location }

# --- DB 遮罩匯出（JSON；不含 .db / .wal）---
Write-Host ">>> export-review-db-masked -> db_export_masked/"
Push-Location $proj
try { node scripts/export-review-db-masked.mjs $dbMasked } finally { Pop-Location }

# --- 實際生效 system prompt（遮罩；寫入 verify_output + npm 日誌另存）---
$promptEffective = Join-Path $verifyOut "system_prompt_effective.md"
Write-Host ">>> export:review-prompt-masked -> verify_output/system_prompt_effective.md"
Run-Capture "export:review-prompt-masked" @("run", "export:review-prompt-masked", "--", $promptEffective) "export_review_prompt_masked.txt"

# --- bundle_safety_check.txt ---
# 長內文用單引號 here-string（@'...'@）；行內勿寫會破壞剖析的跳脫組合（例如雙引號 here-string 內的 \"）
$safetyTxt = @'
# Bundle 安全檢查（打包前）

## 1) verify:bundle-safety（export 腳本靜態檢查）
已執行：npm run verify:bundle-safety
結果摘要：見 verify_bundle_safety_script.txt

## 1b) diagnose:review-db（DB 路徑／表列數快照，無 secret）
已執行：npm run diagnose:review-db（與 stats:order-index 同輪、打包當下 cwd）
輸出：verify_output/diagnose_review_bundle_db.txt（JSON：`db_path`、`table_counts`、`orders_normalized_by_source`、Shopline 已設定品牌數）。請與 **db_export_masked** 對照是否同一資料庫世界。

## 1c) export:review-prompt-masked（實際生效 LLM 組裝前素材，已遮罩）
已執行：npm run export:review-prompt-masked -- verify_output/system_prompt_effective.md
輸出：`verify_output/system_prompt_effective.md`（`settings.system_prompt`、各品牌 `brands.system_prompt`、`assembleEnrichedSystemPrompt` 範例）；執行日誌見 export_review_prompt_masked.txt

## 1d) emit-runtime-parity-artifacts（與打包當下 DB 對齊之 runtime 產物）
已執行：npx tsx server/scripts/emit-runtime-parity-artifacts.ts verify_output（stdout 見 verify_output/emit_runtime_parity_console.txt）
輸出：`verify_output/runtime_db_identity.txt`、`stats_order_index_live.txt`、`diagnose_review_bundle_db_live.txt`、`live_db_table_counts.txt`（與 docs/runtime_export_parity.md 對照）

## 2) Secrets / Token 掃描（本包 staging）
- 已排除：.env、.env.*、*.pem、典型 service-account json 檔名
- source 樹已排除：node_modules、.git、dist、DB、uploads
- 文字檔掃描：對 REVIEW_BUNDLE 內 .md/.txt/.json（除 ai_bundle_context 已由匯出腳本處理）做關鍵字抽樣；若發現 sk_live、AKIA、疑似 api_key、非 REDACTED 的 access_key 等型態，打包流程應阻斷（本腳本採人工二次檢查 README）

## 3) PII
- runtime_evidence / sanitized_cases 內文為**模板＋遮罩範例**，非真實對話匯出
- **db_export_masked/**：orders_normalized、order_lookup_cache、messages、ai_logs、contact_active_order（另存 active_order_context.masked.json）之**遮罩 JSON 快照**，非完整 DB；本包仍**不含** omnichannel.db / .db-wal

## 4) 結論
- 本包設計目標：不含未遮罩 secret 與個資原文
- 收件者仍應在公開模型前快速掃描是否有誤拷 .env

打包時間：
'@
$safetyTxt = $safetyTxt + $stamp
$safetyTxt | Out-File -FilePath (Join-Path $verifyOut "bundle_safety_check.txt") -Encoding utf8

# --- runtime_evidence（遮罩模板，對齊本輪主題）---
$issue1 = @'
# issue_001_local_only_premature_finality

## 1. 問題標題
local_only 單筆查單回覆過像「已定案」（完整明細 + 定案語）

## 2. 重現步驟
1. 僅本地索引命中 1 筆手機查單（data_coverage=local_only）
2. 觀察工具 deterministic 回覆與 active context one_page_summary

## 3. 預期結果
候選摘要、提示「還有其他訂單嗎」、不輸出完整 order card

## 4. 實際結果（修補前）
曾出現「我查到這筆了」+ 完整 formatOrderOnePage

## 5. 涉及來源
LINE 私訊；查單來源：一頁 / 官網皆可能

## 6. 相關 order id（遮罩）
ESC20***

## 7. 截圖
（本輪未附圖；可補 issue_001.png <2MB）

## 8. log 節錄（遮罩）
[order_lookup] renderer=deterministic lookup=phone_single data_coverage=local_only

## 9. 疑似 root cause
routes / fast path 對 local_only 仍拼接完整 one-page

## 10. 已修補檔案
server/routes.ts、server/order-fast-path.ts、server/order-reply-utils.ts（formatLocalOnlyCandidateSummary）

## 11. 尚未確認項目
LLM 路徑若忽略 tool 規則是否仍可能口頭定案
'@
$issue1 | Out-File -FilePath (Join-Path $rt "issue_001_local_only_premature_finality.md") -Encoding utf8

$issue2 = @'
# issue_002_linepay_failed_shown_as_pending

## 1. 問題標題
一頁商店 LINE Pay 失敗（紅叉）卻顯示待付款／pending 語意

## 2. 重現步驟
1. API payload 含 gateway_status=failed、system_note 含未成立／紅叉
2. mapOrder → derivePaymentStatus

## 3. 預期結果
kind=failed，對客「付款失敗／訂單未成立」

## 4. 實際結果（修補前）
payment_status_raw 誤用 payment_method，導致判斷弱

## 5. 涉及來源
一頁商店；金流：LINE Pay

## 6. order id（遮罩）
ESC20981 → ESC20***

## 7. 截圖
（可補 issue_002_linepay.png）

## 8. log 節錄
見 docs/runtime-audit/*fixture*.sanitized.json

## 9. 疑似 root cause
superlanding mapOrder 將 payment_method 當 payment_status_raw

## 10. 已修補檔案
server/superlanding.ts、server/order-payment-utils.ts、docs/runtime-audit/*.fixture.sanitized.json

## 11. 尚未確認項目
真實 webhook 若欄位名與 fixture 不同，需再補 raw 映射
'@
$issue2 | Out-File -FilePath (Join-Path $rt "issue_002_linepay_failed_pending.md") -Encoding utf8

$issue3 = @'
# issue_003_customer_facing_raw_pending_to_store

## 1. 問題標題
對客回覆露出 pending、to_store、credit_card 等 API raw

## 2. 重現步驟
1. formatOrderOnePage 未映射前
2. 客戶截圖顯示「付款方式：pending」

## 3. 預期結果
displayPaymentMethod / displayShippingMethod 人話

## 4. 實際結果（修補前）
raw 英文外洩

## 5. 涉及來源
LINE

## 6. order id
（略）

## 7. 截圖
issue_003_raw_leak.png（占位）

## 8. log 節錄
見 phase34b-verify findCustomerFacingRawLeak

## 9. 疑似 root cause
formatOrderOnePage 直出 payment_method

## 10. 已修補檔案
server/order-reply-utils.ts

## 11. 尚未確認項目
非 formatOrderOnePage 路徑（純 LLM 自由生成）仍可能漏英文代碼
'@
$issue3 | Out-File -FilePath (Join-Path $rt "issue_003_raw_api_tokens_customer.md") -Encoding utf8

# --- sanitized_cases（JSON，已遮罩）---
$cases = @(
  @{
    case_id = "CASE-001"
    channel = "LINE"
    source_intent = "shopline"
    user_input_sequence = @("官網買的", "查訂單", "0912***678")
    expected_behavior = "最後一則才繼承官網意圖；純手機不繼承兩則前的官網"
    actual_behavior = "slice(-1) 後符合預期"
    matched_order_count = 0
    selected_order_id = "N/A"
    payment_truth_expected = "N/A"
    payment_truth_actual = "N/A"
    active_order_context_summary = "無"
    reply_source = "policy"
    renderer = "n/a"
    prompt_profile = "n/a"
    whether_local_only = $false
    whether_api_fallback = $false
    whether_cross_source_mix = $false
    screenshots = @()
    logs = @("phase34-verify 34-1")
  },
  @{
    case_id = "CASE-002"
    channel = "LINE"
    source_intent = "shopline"
    user_input_sequence = @("1234567890123456789")
    expected_behavior = "長數字走官網優先；shopline-only 不回落一頁混單"
    actual_behavior = "unifiedLookupById longNumericShoplineOnly"
    matched_order_count = 1
    selected_order_id = "1234567890123456789"
    payment_truth_expected = "依訂單"
    payment_truth_actual = "依訂單"
    active_order_context_summary = "查單後寫入"
    reply_source = "order_fast_path|tool"
    renderer = "deterministic|formatOrderOnePage"
    prompt_profile = "order_lookup_ultra_lite"
    whether_local_only = $false
    whether_api_fallback = $true
    whether_cross_source_mix = $false
    screenshots = @()
    logs = @("order-service.ts longNumericShoplineOnly")
  },
  @{
    case_id = "CASE-003"
    channel = "LINE"
    source_intent = "superlanding"
    user_input_sequence = @("0912***678")
    expected_behavior = "local_only 單筆僅候選摘要，不定案"
    actual_behavior = "候選摘要＋下一步引導"
    matched_order_count = 1
    selected_order_id = "SBC***"
    payment_truth_expected = "cod|pending|success 依 derivePaymentStatus"
    payment_truth_actual = "同上"
    active_order_context_summary = "one_page_summary 為候選摘要"
    reply_source = "deterministic_tool"
    renderer = "deterministic"
    prompt_profile = "order_lookup_ultra_lite"
    whether_local_only = $true
    whether_api_fallback = $false
    whether_cross_source_mix = $false
    screenshots = @()
    logs = @("routes.ts data_coverage=local_only")
  },
  @{
    case_id = "CASE-004"
    channel = "LINE"
    source_intent = "superlanding"
    user_input_sequence = @("什麼時候出貨")
    expected_behavior = "品牌 delay 5–20 工作天模板"
    actual_behavior = "buildDeterministicFollowUpReply"
    matched_order_count = 1
    selected_order_id = "T1***"
    payment_truth_expected = "success"
    payment_truth_actual = "success"
    active_order_context_summary = "待出貨、無 tracking"
    reply_source = "active_order_short_circuit"
    renderer = "deterministic_followup"
    prompt_profile = "na"
    whether_local_only = $false
    whether_api_fallback = $false
    whether_cross_source_mix = $false
    screenshots = @()
    logs = @("phase34b-verify 必修3")
  },
  @{
    case_id = "CASE-005"
    channel = "LINE"
    source_intent = "superlanding"
    user_input_sequence = @("怎麼還沒寄")
    expected_behavior = "COD 不誤判付款失敗"
    actual_behavior = "明確「不是付款失敗」"
    matched_order_count = 1
    selected_order_id = "T1***"
    payment_truth_expected = "cod"
    payment_truth_actual = "cod"
    active_order_context_summary = "待出貨"
    reply_source = "order_fast_path"
    renderer = "order_followup"
    prompt_profile = "order_followup_ultra_lite"
    whether_local_only = $false
    whether_api_fallback = $false
    whether_cross_source_mix = $false
    screenshots = @()
    logs = @()
  },
  @{
    case_id = "CASE-006"
    channel = "LINE"
    source_intent = "superlanding"
    user_input_sequence = @("ESC20*** 類失敗單")
    expected_behavior = "failed + 付款失敗／訂單未成立"
    actual_behavior = "mapSuperlandingOrderFromApiPayload + derivePaymentStatus → failed"
    matched_order_count = 1
    selected_order_id = "ESC20***"
    payment_truth_expected = "failed"
    payment_truth_actual = "failed"
    active_order_context_summary = "新訂單狀態列"
    reply_source = "tool|llm"
    renderer = "formatOrderOnePage"
    prompt_profile = "order_lookup_ultra_lite"
    whether_local_only = $false
    whether_api_fallback = $true
    whether_cross_source_mix = $false
    screenshots = @()
    logs = @("superlanding-esc20981*.fixture.sanitized.json")
  },
  @{
    case_id = "CASE-007"
    channel = "FB_inbox"
    source_intent = "unknown"
    user_input_sequence = @("還有其他訂單嗎")
    expected_behavior = "多筆或觸發重查，不單筆重複同一摘要當結論"
    actual_behavior = "需依 active context 與工具回傳交叉驗證（部分情境仍依賴 LLM）"
    matched_order_count = 2
    selected_order_id = "multi"
    payment_truth_expected = "mixed"
    payment_truth_actual = "mixed"
    active_order_context_summary = "candidate_count>1"
    reply_source = "llm|deterministic"
    renderer = "multi_order_router"
    prompt_profile = "order_lookup_ultra_lite"
    whether_local_only = $false
    whether_api_fallback = $true
    whether_cross_source_mix = $false
    screenshots = @()
    logs = @()
  },
  @{
    case_id = "CASE-008"
    channel = "LINE"
    source_intent = "shopline"
    user_input_sequence = @("什麼時候收到", "物流單號已提供")
    expected_behavior = "道歉＋引導查物流，不用 7–20 預購主模板"
    actual_behavior = "buildDeterministicFollowUpReply receiptAsk + tracking"
    matched_order_count = 1
    selected_order_id = "SH***"
    payment_truth_expected = "success"
    payment_truth_actual = "success"
    active_order_context_summary = "已出貨+tracking"
    reply_source = "active_order_short_circuit"
    renderer = "deterministic_followup"
    prompt_profile = "na"
    whether_local_only = $false
    whether_api_fallback = $false
    whether_cross_source_mix = $false
    screenshots = @()
    logs = @("phase34b-verify")
  },
  @{
    case_id = "CASE-009"
    channel = "LINE"
    source_intent = "unknown"
    user_input_sequence = @("商品A 0912***678")
    expected_behavior = "商品+手機查單；Shopline 須過濾商品別整包回傳"
    actual_behavior = "依 product filter 與 policy"
    matched_order_count = 1
    selected_order_id = "P***"
    payment_truth_expected = "依訂單"
    payment_truth_actual = "依訂單"
    active_order_context_summary = "product_phone"
    reply_source = "tool|llm"
    renderer = "deterministic"
    prompt_profile = "order_lookup_ultra_lite"
    whether_local_only = $false
    whether_api_fallback = $true
    whether_cross_source_mix = $false
    screenshots = @()
    logs = @()
  },
  @{
    case_id = "CASE-010"
    channel = "LINE"
    source_intent = "superlanding"
    user_input_sequence = @("（含 raw JSON 截圖）")
    expected_behavior = "商品明細為人話，不播報 JSON"
    actual_behavior = "formatProductLinesForCustomer"
    matched_order_count = 1
    selected_order_id = "X***"
    payment_truth_expected = "N/A"
    payment_truth_actual = "N/A"
    active_order_context_summary = "one_page"
    reply_source = "llm"
    renderer = "formatOrderOnePage"
    prompt_profile = "order_lookup_ultra_lite"
    whether_local_only = $false
    whether_api_fallback = $false
    whether_cross_source_mix = $false
    screenshots = @()
    logs = @("phase32-verify T6")
  },
  @{
    case_id = "CASE-011"
    channel = "LINE"
    source_intent = "shopline"
    user_input_sequence = @("我要真人", "法律問題")
    expected_behavior = "handoff，不洩漏 internal label"
    actual_behavior = "依 handoff 規則（須對照 routes / guard）"
    matched_order_count = 0
    selected_order_id = "N/A"
    payment_truth_expected = "N/A"
    payment_truth_actual = "N/A"
    active_order_context_summary = "無"
    reply_source = "handoff"
    renderer = "n/a"
    prompt_profile = "n/a"
    whether_local_only = $false
    whether_api_fallback = $false
    whether_cross_source_mix = $false
    screenshots = @()
    logs = @()
  }
)
$i = 0
foreach ($c in $cases) {
  $i++
  $c | ConvertTo-Json -Depth 8 | Out-File -FilePath (Join-Path $san ("case_{0:D3}.json" -f $i)) -Encoding utf8
}

# --- Git 資訊 ---
$gitHash = "unknown"
$gitBranch = "unknown"
try {
  Push-Location $proj
  $gh = git rev-parse HEAD 2>$null
  if ($gh) { $gitHash = ($gh | Out-String).Trim() }
  $gb = git rev-parse --abbrev-ref HEAD 2>$null
  if ($gb) { $gitBranch = ($gb | Out-String).Trim() }
} catch { }
finally { Pop-Location }

# --- 資料夾大小 ---
function Dir-MB($p) {
  if (-not (Test-Path $p)) { return 0 }
  $b = (Get-ChildItem $p -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
  [math]::Round($b / 1MB, 2)
}
$szSource = Dir-MB $src
$szDocs = Dir-MB $docsDst
$szRt = Dir-MB $rt
$szVo = Dir-MB $verifyOut
$szSan = Dir-MB $san
$szDb = Dir-MB $dbMasked
$szRoot = Dir-MB $root

$manifest = @'
# MANIFEST — Omni-Agent-Console REVIEW BUNDLE

- **建立時間（檔名戳）**：__STAMP__
- **git commit**：__GITHASH__
- **branch**：__GITBRANCH__
- **本輪 phase 名稱**：Phase 34 / 34B — 人格／查單政策 runtime rescue + 候選摘要 + fixture 驗證
- **改動摘要**：local_only 候選摘要；一頁失敗單 raw 映射；對客 raw 遮罩；shopline-only 長數字；品牌 delay 覆蓋；phase34b 行為級 verify
- **打包前 verify（指定順序）**：
  1. npm run check:server
  2. npm run verify:phase34
  3. npm run verify:hardening
  4. npm run stats:order-index
  5. npm run diagnose:review-db（`verify_output/diagnose_review_bundle_db.txt`：解析後 DB 路徑、表列數、shopline 品牌設定數）
  6. npm run verify:bundle-safety
  7. 另：npm run verify:phase34b
  8. phase24～33 單獨 tsx 輸出（見 verify_output/verify_phaseXX.txt）
  9. 匯出後：`export:review-db-masked`、`export:review-prompt-masked`（見 `verify_output/system_prompt_effective.md`）
- **目錄必備內容**：
  - **source/**：完整可審程式樹（含 **server/**、**client/**、**shared/**、**package.json**、**package-lock.json** 等；已排除 node_modules、.git、dist、***.db**、uploads、.env）
  - **docs/**：含 **docs/persona/**（與專案 docs 同步）
  - **verify_output/**、**runtime_evidence/**、**sanitized_cases/**
  - **db_export_masked/**：遮罩後 orders_normalized / order_lookup_cache / messages / ai_logs / active_order_context（見該目錄 README）
- **runtime issue 列表**：issue_001～003（runtime_evidence/）
- **已知未修**：見 REVIEW_SUMMARY.md 第 5 節
- **ZIP 總大小**：請看打包完成後主控台輸出，或專案根目錄 `REVIEW_BUNDLE_BUILD_INFO_*.md`
- **壓縮前 REVIEW_BUNDLE 目錄約略大小（MB）**：__SZROOT__
- **資料夾大小（MB，staging）**：
  - source：__SZSOURCE__
  - docs：__SZDOCS__
  - db_export_masked：__SZDB__
  - runtime_evidence：__SZRT__
  - verify_output：__SZVO__
  - sanitized_cases：__SZSAN__
- **敏感資料掃描**：已執行 verify:bundle-safety；staging 排除 .env / 原始 DB 檔 / node_modules
- **secrets scrub**：export-ai-bundle-context 預設 redact；本包不含 .env
- **PII mask**：案例、issue、db_export_masked 均為遮罩處理；非還原用備份
'@
$manifest = $manifest.Replace('__STAMP__', [string]$stamp).Replace('__GITHASH__', [string]$gitHash).Replace('__GITBRANCH__', [string]$gitBranch).Replace('__SZROOT__', [string]$szRoot).Replace('__SZSOURCE__', [string]$szSource).Replace('__SZDOCS__', [string]$szDocs).Replace('__SZDB__', [string]$szDb).Replace('__SZRT__', [string]$szRt).Replace('__SZVO__', [string]$szVo).Replace('__SZSAN__', [string]$szSan)
$manifest | Out-File -FilePath (Join-Path $root "MANIFEST.md") -Encoding utf8

$review = @'
# REVIEW_SUMMARY（審查者友善）

## 1. 本輪要解的問題
- local_only 單筆過早「定案」與完整明細外送
- 一頁商店 LINE Pay／紅叉失敗誤判 pending
- 對客露出 pending/to_store/credit_card
- 官網長數字單號與一頁混查
- 品牌久候話術覆蓋不足與與人格對齊

## 2. 實際修改了哪些模組
- `server/order-reply-utils.ts`、`server/order-fast-path.ts`、`server/routes.ts`
- `server/superlanding.ts`、`server/order-payment-utils.ts`、`server/order-service.ts`
- `server/order-lookup-policy.ts`、`server/phase34-verify.ts`、`server/phase34b-verify.ts`
- `docs/persona/*`、`docs/runtime-audit/*fixture*`、`docs/PHASE34*.md`、`docs/PHASE34B_FIX_REPORT.md`

## 3. 真的已修好的
- local_only 候選摘要路徑（fast path + routes deterministic）
- payment_status_raw 來自 system_note/gateway 等，失敗單 fixture 走通 failed
- formatOrderOnePage 對客映射；phase34b denylist 驗證
- 長數字 shopline-only 回落策略
- 品牌 delay / COD / 有 tracking 之「何時收到」分支

## 4. 部分修好、仍有風險的
- LLM 未遵守 ORDER_LOOKUP_RULES 時仍可能口頭定案
- 真實 API 欄位若與 fixture 不一致，失敗訊號可能仍漏接
- 非 deterministic 路徑仍可能生成內部用語

## 5. 尚未修好的（3～8 點）
- 完整 webhook E2E 自動化驗證（本包以 fixture + verify 為主）
- Shopline 失敗單同級 fixture（可再加）
- 雙回覆競態全面消除
- 修改地址寫回後端成功與否之端到端驗證
- production 與 staging 設定／旗標差異盤點
- 巨量 log 目錄結構化採樣（未附原始 log）
- FB 留言與私訊細分流規則之逐 case 覆蓋

## 6. 最需要 ChatGPT 幫忙看的地方
- `routes.ts` 查單工具分支與 `local_only` 全路徑是否還有漏網完整 card
- `derivePaymentStatus` 與 `deriveSuperlandingPaymentStatusRaw` 邊界條件
- `buildReplyPlan` 與 `planAllowsActiveOrderDeterministic` 是否還有 mode 漏接
- 多筆訂單選擇與「還有其他訂單」語意一致性
- `customer-reply-normalizer` 是否會誤刪品牌 delay 關鍵句

## 7. 最值得先看的 runtime case
- `sanitized_cases/case_003.json`（local_only）
- `sanitized_cases/case_006.json`（ESC20981 類）
- `runtime_evidence/issue_001_*.md`
- `verify_output/verify_phase34b.txt`
- `verify_output/diagnose_review_bundle_db.txt`（與 `db_export_masked` 對照：`DATA_DIR`／cwd 是否一致）
- `verify_output/system_prompt_effective.md`（遮罩後實際 prompt 素材與組裝範例）

## 8. 與上一包最大差異
- 新增 **候選摘要**、**phase34b 行為級 verify**、**去識別化 fixture JSON**、**REVIEW_BUNDLE 固定目錄與 verify 原始輸出**
- **db_export_masked/**：訂單索引／快取／訊息／ai_logs／active order context 之**遮罩 JSON**（非僅 .db-wal）

## 9. 建議不要上線的功能／旗標
- 任何關閉 `orderFeatureFlags` 中保守查單／normalizer 的設定需審慎
- 未在 staging 跑通 `verify:phase34` + `verify:phase34b` 勿上 production

## 10. 下一輪優先檢查的檔案
- `server/routes.ts`（查單工具與 deterministic）
- `server/order-service.ts`（unifiedLookupById）
- `server/superlanding.ts`（payload 映射）
- `server/order-payment-utils.ts`
- `server/order-reply-utils.ts`
'@
$review | Out-File -FilePath (Join-Path $root "REVIEW_SUMMARY.md") -Encoding utf8

# --- 500MB 政策：輔助函式 ---
function Get-ItemUncompressedBytes([System.IO.FileSystemInfo]$item) {
  if (-not $item.PSIsContainer) { return [int64]$item.Length }
  [int64]$t = 0
  Get-ChildItem -LiteralPath $item.FullName -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object { $t += $_.Length }
  return $t
}

function Zip-FolderToFile([string]$folderToZip, [string]$destZipPath) {
  $z = Join-Path $env:TEMP ("OmniReviewAnyZIP_" + [Guid]::NewGuid().ToString("N") + ".zip")
  if (Test-Path -LiteralPath $z) { Remove-Item -LiteralPath $z -Force }
  try {
    [System.IO.Compression.ZipFile]::CreateFromDirectory(
      $folderToZip,
      $z,
      [System.IO.Compression.CompressionLevel]::Optimal,
      $false
    )
  } catch {
    Write-Warning "ZipFile failed: $($_.Exception.Message); fallback Compress-Archive"
    if (Test-Path -LiteralPath $z) { Remove-Item -LiteralPath $z -Force }
    Compress-Archive -LiteralPath $folderToZip -DestinationPath $z -Force
  }
  if (-not (Test-Path -LiteralPath $z)) { throw "ZIP not created: $destZipPath" }
  if (Test-Path -LiteralPath $destZipPath) { Remove-Item -LiteralPath $destZipPath -Force }
  Copy-Item -LiteralPath $z -Destination $destZipPath -Force
  Remove-Item -LiteralPath $z -Force -ErrorAction SilentlyContinue
  return (Get-Item -LiteralPath $destZipPath).Length
}

# 壓縮「名為 REVIEW_BUNDLE 的資料夾」本身，使 zip 根目錄為 REVIEW_BUNDLE/…（與單檔全包一致）
function Zip-ReviewBundleDirToFile([string]$reviewBundleDir, [string]$destZipPath) {
  $z = Join-Path $env:TEMP ("OmniReviewRBZIP_" + [Guid]::NewGuid().ToString("N") + ".zip")
  if (Test-Path -LiteralPath $z) { Remove-Item -LiteralPath $z -Force }
  try {
    [System.IO.Compression.ZipFile]::CreateFromDirectory(
      $reviewBundleDir,
      $z,
      [System.IO.Compression.CompressionLevel]::Optimal,
      $true
    )
  } catch {
    Write-Warning "ZipFile (REVIEW_BUNDLE root) failed: $($_.Exception.Message); fallback without base dir"
    if (Test-Path -LiteralPath $z) { Remove-Item -LiteralPath $z -Force }
    Zip-FolderToFile $reviewBundleDir $destZipPath
    return (Get-Item -LiteralPath $destZipPath).Length
  }
  if (-not (Test-Path -LiteralPath $z)) { throw "ZIP not created: $destZipPath" }
  if (Test-Path -LiteralPath $destZipPath) { Remove-Item -LiteralPath $destZipPath -Force }
  Copy-Item -LiteralPath $z -Destination $destZipPath -Force
  Remove-Item -LiteralPath $z -Force -ErrorAction SilentlyContinue
  return (Get-Item -LiteralPath $destZipPath).Length
}

function Remove-ZipIfOversize([string]$zipPath, [int64]$limitBytes) {
  if (-not (Test-Path -LiteralPath $zipPath)) { return $false }
  $len = (Get-Item -LiteralPath $zipPath).Length
  if ($len -le $limitBytes) { return $false }
  Remove-Item -LiteralPath $zipPath -Force
  return $true
}

# ZIP：先寫入 %TEMP% 純 ASCII 檔名，再複製到專案根（含括號/非 ASCII 路徑時 Compress-Archive 常失敗或產物異常）
$zipTemp = Join-Path $env:TEMP "OmniReviewZIP_$stamp.zip"
Write-Host ">>> Zip (temp) -> $zipTemp"
Write-Host ">>> Zip (final) -> $zipPath"
if (Test-Path -LiteralPath $zipTemp) { Remove-Item -LiteralPath $zipTemp -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
try {
  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    $root,
    $zipTemp,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $true
  )
} catch {
  Write-Warning ".NET ZipFile failed, fallback Compress-Archive: $($_.Exception.Message)"
  if (Test-Path -LiteralPath $zipTemp) { Remove-Item -LiteralPath $zipTemp -Force }
  Compress-Archive -LiteralPath $root -DestinationPath $zipTemp -Force
}
if (-not (Test-Path -LiteralPath $zipTemp)) { throw "ZIP not created at temp: $zipTemp" }

$desk = [Environment]::GetFolderPath('Desktop')
$fullZipLen = (Get-Item -LiteralPath $zipTemp).Length
$fullZipOmitted = $false
if ($fullZipLen -gt $script:MaxZipBytes) {
  Write-Warning ("完整包 {0:N1} MB 超過單檔上限（499 MiB），已略過。改產出 REVIEW-BUNDLE_PART01 / PART02（必要時 PART03+ 承載 source）。" -f ($fullZipLen / 1MB))
  Remove-Item -LiteralPath $zipTemp -Force -ErrorAction SilentlyContinue
  $fullZipOmitted = $true
  if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
  $zipMb = 0
} else {
  if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
  Copy-Item -LiteralPath $zipTemp -Destination $zipPath -Force
  if (-not (Test-Path -LiteralPath $zipPath)) {
    throw "ZIP copy to project failed. 暫存檔仍在（請手動複製）: $zipTemp"
  }
  if ($desk -and (Test-Path -LiteralPath $desk)) {
    $deskZip = Join-Path $desk $zipName
    try {
      Copy-Item -LiteralPath $zipTemp -Destination $deskZip -Force
      Write-Host ">>> ZIP 已複製到桌面: $deskZip"
    } catch {
      Write-Warning "Desktop copy skipped: $($_.Exception.Message)"
    }
  }
  Remove-Item -LiteralPath $zipTemp -Force -ErrorAction SilentlyContinue
  $zipMb = [math]::Round((Get-Item -LiteralPath $zipPath).Length / 1MB, 2)
}

# --- 證據包（無 source）／原始碼多卷（每個 zip ≤ 499 MiB）---
# 完整包超上限時改走 $partBundleZipPaths（PART01/PART02/PART03…），不產出 REVIEW-EVIDENCE + REVIEW-SOURCE-Pxx
$splitBase = Join-Path $env:TEMP "OmniReviewSplit_$stamp"
$evidenceRoot = Join-Path $splitBase "REVIEW_BUNDLE_EVIDENCE"
$sourceZipPaths = New-Object System.Collections.ArrayList
$evidenceZipPaths = New-Object System.Collections.ArrayList
$partBundleZipPaths = New-Object System.Collections.ArrayList

try {
  if ($fullZipOmitted) {
    $readmeMerge = @'
# REVIEW BUNDLE — 多卷 PART 合併說明

同時間戳之 **PART01**（source／verify／MANIFEST／SUMMARY）、**PART02**（docs／runtime_evidence／sanitized_cases／db_export_masked）、**PART03+**（僅在 PART01 超上限時之 source 分批）。

請將各 zip 解壓後，把內層 **`REVIEW_BUNDLE`** 下資料夾合併到同一目錄（已有則合併子目錄內容）。
'@

    # --- PART01：source + verify_output + MANIFEST + REVIEW_SUMMARY ---
    $p1wrap = Join-Path $splitBase "WRAP_PART01"
    $rb1 = Join-Path $p1wrap "REVIEW_BUNDLE"
    if (Test-Path $p1wrap) { Remove-Item $p1wrap -Recurse -Force }
    Ensure-Dir $rb1
    Copy-Item -Path $src -Destination (Join-Path $rb1 "source") -Recurse -Force
    Copy-Item -Path $verifyOut -Destination (Join-Path $rb1 "verify_output") -Recurse -Force
    Copy-Item -Path (Join-Path $root "MANIFEST.md") -Destination (Join-Path $rb1 "MANIFEST.md") -Force
    Copy-Item -Path (Join-Path $root "REVIEW_SUMMARY.md") -Destination (Join-Path $rb1 "REVIEW_SUMMARY.md") -Force
    $readmeMerge | Out-File -FilePath (Join-Path $rb1 "README_REVIEW_BUNDLE_PART_SPLIT.md") -Encoding utf8
    $zpPart01 = Join-Path $proj ("Omni-Agent-Console-REVIEW-BUNDLE_PART01_{0}.zip" -f $stamp)
    Write-Host ">>> Zip PART01 -> $zpPart01"
    [void](Zip-ReviewBundleDirToFile $rb1 $zpPart01)

    if ((Get-Item -LiteralPath $zpPart01).Length -gt $script:MaxZipBytes) {
      Remove-Item -LiteralPath $zpPart01 -Force
      if (Test-Path $p1wrap) { Remove-Item $p1wrap -Recurse -Force }
      Ensure-Dir $rb1
      Copy-Item -Path $verifyOut -Destination (Join-Path $rb1 "verify_output") -Recurse -Force
      Copy-Item -Path (Join-Path $root "MANIFEST.md") -Destination (Join-Path $rb1 "MANIFEST.md") -Force
      Copy-Item -Path (Join-Path $root "REVIEW_SUMMARY.md") -Destination (Join-Path $rb1 "REVIEW_SUMMARY.md") -Force
      @'
# PART01（精簡）

完整 source 因單檔上限改置於 **PART03、PART04…**。本包僅含 verify_output 與審查摘要 md。
'@ | Out-File -FilePath (Join-Path $rb1 "README_REVIEW_BUNDLE_PART_SPLIT.md") -Encoding utf8
      Write-Warning "PART01（含 source）超過 499 MiB，改為僅打包 verify + MANIFEST + REVIEW_SUMMARY；source 改 PART03+。"
      [void](Zip-ReviewBundleDirToFile $rb1 $zpPart01)
      [void]$partBundleZipPaths.Add($zpPart01)

      # --- PART03+：source 分批（每個 zip 根目錄為 REVIEW_BUNDLE/source/…）---
      $innerItems = @(Get-ChildItem -LiteralPath $src -Force -ErrorAction SilentlyContinue)
      $units = New-Object System.Collections.ArrayList
      foreach ($it in $innerItems) {
        $usz = Get-ItemUncompressedBytes $it
        if ($usz -gt $script:SourceBatchUncompressedBudget -and $it.PSIsContainer) {
          foreach ($sub in (Get-ChildItem -LiteralPath $it.FullName -Force)) {
            [void]$units.Add($sub)
          }
        } else {
          [void]$units.Add($it)
        }
      }
      $sorted = $units | Sort-Object @{ Expression = { Get-ItemUncompressedBytes $_ }; Descending = $true }
      $batches = New-Object System.Collections.ArrayList
      $cur = New-Object System.Collections.ArrayList
      [int64]$curSz = 0
      foreach ($u in $sorted) {
        $usz = Get-ItemUncompressedBytes $u
        if ($curSz + $usz -gt $script:SourceBatchUncompressedBudget -and $cur.Count -gt 0) {
          [void]$batches.Add(@($cur.ToArray()))
          $cur.Clear()
          $curSz = 0
        }
        [void]$cur.Add($u)
        $curSz += $usz
      }
      if ($cur.Count -gt 0) { [void]$batches.Add(@($cur.ToArray())) }

      function New-PartSourceZipFromBatch($batchArray, [int]$partNum) {
        $partRoot = Join-Path $env:TEMP ("OmniReviewPartSrc_{0}_{1}_{2}" -f $stamp, $partNum, ([Guid]::NewGuid().ToString("N").Substring(0, 8)))
        if (Test-Path $partRoot) { Remove-Item $partRoot -Recurse -Force }
        $wrap = Join-Path $partRoot "REVIEW_BUNDLE"
        $inner = Join-Path $wrap "source"
        Ensure-Dir $inner
        foreach ($x in $batchArray) {
          Copy-Item -LiteralPath $x.FullName -Destination (Join-Path $inner $x.Name) -Recurse -Force
        }
        @"
# REVIEW BUNDLE — source 分卷 PART$partNum

解壓後將 ``source`` 內容**合併**到併用 PART 之同一 ``REVIEW_BUNDLE/source`` 目錄。
"@ | Out-File -FilePath (Join-Path $wrap "README_REVIEW_BUNDLE_PART_SPLIT.md") -Encoding utf8
        $zn = "Omni-Agent-Console-REVIEW-BUNDLE_PART{0:D2}_{1}.zip" -f $partNum, $stamp
        $zp = Join-Path $proj $zn
        [void](Zip-ReviewBundleDirToFile $wrap $zp)
        Remove-Item $partRoot -Recurse -Force -ErrorAction SilentlyContinue
        return $zp
      }

      function Submit-PartSourceBatch($batchArray, [int]$startPart) {
        if ($null -eq $batchArray -or $batchArray.Count -eq 0) { return $startPart }
        $zp = New-PartSourceZipFromBatch $batchArray $startPart
        if ((Get-Item -LiteralPath $zp).Length -le $script:MaxZipBytes) {
          [void]$partBundleZipPaths.Add($zp)
          return $startPart + 1
        }
        Remove-Item -LiteralPath $zp -Force
        if ($batchArray.Count -eq 1) {
          Write-Warning ("PART{0:D2} 單一 source 項壓縮後仍超過 499 MiB: {1}" -f $startPart, $batchArray[0].Name)
          $zp2 = New-PartSourceZipFromBatch $batchArray $startPart
          [void]$partBundleZipPaths.Add($zp2)
          return $startPart + 1
        }
        Write-Warning ("PART{0:D2} source 超上限，自動對半拆批" -f $startPart)
        $mid = [int][math]::Ceiling($batchArray.Count / 2)
        $a = @($batchArray[0..($mid - 1)])
        $b = @($batchArray[$mid..($batchArray.Count - 1)])
        $next = Submit-PartSourceBatch $a $startPart
        return (Submit-PartSourceBatch $b $next)
      }

      $pnum = 3
      foreach ($bat in $batches) {
        $pnum = Submit-PartSourceBatch @($bat) $pnum
      }
    } else {
      [void]$partBundleZipPaths.Add($zpPart01)
    }

    # --- PART02：docs + runtime + cases + db（無 source、無 verify_output）---
    $p2wrap = Join-Path $splitBase "WRAP_PART02"
    $rb2 = Join-Path $p2wrap "REVIEW_BUNDLE"
    if (Test-Path $p2wrap) { Remove-Item $p2wrap -Recurse -Force }
    Ensure-Dir $rb2
    if (Test-Path $docsDst) {
      Copy-Item -Path $docsDst -Destination (Join-Path $rb2 "docs") -Recurse -Force
    }
    Copy-Item -Path $rt -Destination (Join-Path $rb2 "runtime_evidence") -Recurse -Force
    Copy-Item -Path $san -Destination (Join-Path $rb2 "sanitized_cases") -Recurse -Force
    Copy-Item -Path $dbMasked -Destination (Join-Path $rb2 "db_export_masked") -Recurse -Force
    $readmeMerge | Out-File -FilePath (Join-Path $rb2 "README_REVIEW_BUNDLE_PART_SPLIT.md") -Encoding utf8
    $zpPart02 = Join-Path $proj ("Omni-Agent-Console-REVIEW-BUNDLE_PART02_{0}.zip" -f $stamp)
    Write-Host ">>> Zip PART02 -> $zpPart02"
    [void](Zip-ReviewBundleDirToFile $rb2 $zpPart02)
    if ((Get-Item -LiteralPath $zpPart02).Length -gt $script:MaxZipBytes) {
      Write-Warning "PART02 壓縮後仍超過 499 MiB；請縮小 docs 或 db_export_masked 後重跑。"
    }
    [void]$partBundleZipPaths.Add($zpPart02)

    if ($desk -and (Test-Path -LiteralPath $desk)) {
      try {
        foreach ($pz in @($partBundleZipPaths)) {
          Copy-Item -LiteralPath $pz -Destination (Join-Path $desk (Split-Path -Leaf $pz)) -Force
        }
        Write-Host ">>> PART 分包已複製到桌面"
      } catch {
        Write-Warning "Desktop copy PART zips skipped: $($_.Exception.Message)"
      }
    }
  } else {
  Ensure-Dir $evidenceRoot
  if (Test-Path $docsDst) {
    Copy-Item -Path $docsDst -Destination (Join-Path $evidenceRoot "docs") -Recurse -Force
  }
  Copy-Item -Path $verifyOut -Destination (Join-Path $evidenceRoot "verify_output") -Recurse -Force
  Copy-Item -Path $dbMasked -Destination (Join-Path $evidenceRoot "db_export_masked") -Recurse -Force
  Copy-Item -Path $rt -Destination (Join-Path $evidenceRoot "runtime_evidence") -Recurse -Force
  Copy-Item -Path $san -Destination (Join-Path $evidenceRoot "sanitized_cases") -Recurse -Force
  Copy-Item -Path (Join-Path $root "MANIFEST.md") -Destination (Join-Path $evidenceRoot "MANIFEST.md") -Force
  Copy-Item -Path (Join-Path $root "REVIEW_SUMMARY.md") -Destination (Join-Path $evidenceRoot "REVIEW_SUMMARY.md") -Force
  $evReadme = @'
# REVIEW BUNDLE — 證據包（無完整 source）

請搭配 **REVIEW-SOURCE-Pxx_*.zip**（解壓後合併到同一 `source/` 目錄）。

若檔名含 **EVIDENCE-P02**：P01 多為 docs／verify；P02 多為 db_export_masked／runtime／cases。
'@
  $evReadme | Out-File -FilePath (Join-Path $evidenceRoot "README_SPLIT.md") -Encoding utf8

  Write-Host ">>> Zip EVIDENCE -> $zipPathEvidence"
  [void](Zip-FolderToFile $evidenceRoot $zipPathEvidence)
  if ((Get-Item -LiteralPath $zipPathEvidence).Length -gt $script:MaxZipBytes) {
    Write-Warning "證據包超過上限，改為兩卷 EVIDENCE-P01 / P02"
    Remove-Item -LiteralPath $zipPathEvidence -Force
    $ev1 = Join-Path $splitBase "REVIEW_BUNDLE_EVIDENCE_P01"
    $ev2 = Join-Path $splitBase "REVIEW_BUNDLE_EVIDENCE_P02"
    Ensure-Dir $ev1
    Ensure-Dir $ev2
    if (Test-Path (Join-Path $evidenceRoot "docs")) {
      Copy-Item (Join-Path $evidenceRoot "docs") (Join-Path $ev1 "docs") -Recurse -Force
    }
    Copy-Item (Join-Path $evidenceRoot "verify_output") (Join-Path $ev1 "verify_output") -Recurse -Force
    Copy-Item (Join-Path $evidenceRoot "MANIFEST.md") (Join-Path $ev1 "MANIFEST.md") -Force
    Copy-Item (Join-Path $evidenceRoot "REVIEW_SUMMARY.md") (Join-Path $ev1 "REVIEW_SUMMARY.md") -Force
    Copy-Item (Join-Path $evidenceRoot "README_SPLIT.md") (Join-Path $ev1 "README_SPLIT.md") -Force
    Copy-Item (Join-Path $evidenceRoot "db_export_masked") (Join-Path $ev2 "db_export_masked") -Recurse -Force
    Copy-Item (Join-Path $evidenceRoot "runtime_evidence") (Join-Path $ev2 "runtime_evidence") -Recurse -Force
    Copy-Item (Join-Path $evidenceRoot "sanitized_cases") (Join-Path $ev2 "sanitized_cases") -Recurse -Force
    $zn1 = "Omni-Agent-Console-REVIEW-EVIDENCE-P01_$stamp.zip"
    $zn2 = "Omni-Agent-Console-REVIEW-EVIDENCE-P02_$stamp.zip"
    $zp1 = Join-Path $proj $zn1
    $zp2 = Join-Path $proj $zn2
    [void](Zip-FolderToFile $ev1 $zp1)
    [void](Zip-FolderToFile $ev2 $zp2)
    [void]$evidenceZipPaths.Add($zp1)
    [void]$evidenceZipPaths.Add($zp2)
  } else {
    [void]$evidenceZipPaths.Add($zipPathEvidence)
  }

  # --- source/ 依未壓縮體積分批，每批一個 zip；單批仍超上限則再對半拆 ---
  $innerItems = @(Get-ChildItem -LiteralPath $src -Force -ErrorAction SilentlyContinue)
  $units = New-Object System.Collections.ArrayList
  foreach ($it in $innerItems) {
    $usz = Get-ItemUncompressedBytes $it
    if ($usz -gt $script:SourceBatchUncompressedBudget -and $it.PSIsContainer) {
      foreach ($sub in (Get-ChildItem -LiteralPath $it.FullName -Force)) {
        [void]$units.Add($sub)
      }
    } else {
      [void]$units.Add($it)
    }
  }
  $sorted = $units | Sort-Object @{ Expression = { Get-ItemUncompressedBytes $_ }; Descending = $true }
  $batches = New-Object System.Collections.ArrayList
  $cur = New-Object System.Collections.ArrayList
  [int64]$curSz = 0
  foreach ($u in $sorted) {
    $usz = Get-ItemUncompressedBytes $u
    if ($curSz + $usz -gt $script:SourceBatchUncompressedBudget -and $cur.Count -gt 0) {
      [void]$batches.Add(@($cur.ToArray()))
      $cur.Clear()
      $curSz = 0
    }
    [void]$cur.Add($u)
    $curSz += $usz
  }
  if ($cur.Count -gt 0) { [void]$batches.Add(@($cur.ToArray())) }

  function New-SourceZipFromBatch($batchArray, [int]$partNum) {
    $partRoot = Join-Path $env:TEMP ("OmniReviewSrcP_{0}_{1}_{2}" -f $stamp, $partNum, ([Guid]::NewGuid().ToString("N").Substring(0, 8)))
    if (Test-Path $partRoot) { Remove-Item $partRoot -Recurse -Force }
    $wrap = Join-Path $partRoot "REVIEW_BUNDLE_SOURCE"
    $inner = Join-Path $wrap "source"
    Ensure-Dir $inner
    foreach ($x in $batchArray) {
      Copy-Item -LiteralPath $x.FullName -Destination (Join-Path $inner $x.Name) -Recurse -Force
    }
    $readme = @"
# 原始碼分包第 $partNum 卷

解壓後將 `source` 內容**合併**到同一個上層 `source` 資料夾（與其他 REVIEW-SOURCE-Pxx 併用）。
"@
    $readme | Out-File -FilePath (Join-Path $wrap "README_SOURCE_PART.md") -Encoding utf8
    $zn = "Omni-Agent-Console-REVIEW-SOURCE-P{0:D2}_{1}.zip" -f $partNum, $stamp
    $zp = Join-Path $proj $zn
    [void](Zip-FolderToFile $wrap $zp)
    Remove-Item $partRoot -Recurse -Force -ErrorAction SilentlyContinue
    return $zp
  }

  function Submit-SourceBatch($batchArray, [int]$startPart) {
    if ($null -eq $batchArray -or $batchArray.Count -eq 0) { return $startPart }
    $zp = New-SourceZipFromBatch $batchArray $startPart
    if ((Get-Item -LiteralPath $zp).Length -le $script:MaxZipBytes) {
      [void]$sourceZipPaths.Add($zp)
      return $startPart + 1
    }
    Remove-Item -LiteralPath $zp -Force
    if ($batchArray.Count -eq 1) {
      Write-Warning ("SOURCE 單一項目壓縮後仍超過 499 MiB: {0}（請自 robocopy 排除大型檔）" -f $batchArray[0].Name)
      $zp2 = New-SourceZipFromBatch $batchArray $startPart
      [void]$sourceZipPaths.Add($zp2)
      return $startPart + 1
    }
    Write-Warning ("SOURCE-P{0:D2} 超上限，自動對半拆批" -f $startPart)
    $mid = [int][math]::Ceiling($batchArray.Count / 2)
    $a = @($batchArray[0..($mid - 1)])
    $b = @($batchArray[$mid..($batchArray.Count - 1)])
    $next = Submit-SourceBatch $a $startPart
    return (Submit-SourceBatch $b $next)
  }

  $part = 1
  foreach ($bat in $batches) {
    $part = Submit-SourceBatch @($bat) $part
  }

  if ($desk -and (Test-Path -LiteralPath $desk)) {
    try {
      foreach ($ez in @($evidenceZipPaths)) {
        Copy-Item -LiteralPath $ez -Destination (Join-Path $desk (Split-Path -Leaf $ez)) -Force
      }
      foreach ($sz in @($sourceZipPaths)) {
        Copy-Item -LiteralPath $sz -Destination (Join-Path $desk (Split-Path -Leaf $sz)) -Force
      }
      Write-Host ">>> 證據＋原始碼分包已複製到桌面"
    } catch {
      Write-Warning "Desktop copy split ZIPs skipped: $($_.Exception.Message)"
    }
  }
  }
} catch {
  Write-Warning "分包階段失敗: $($_.Exception.Message)"
} finally {
  if (Test-Path $splitBase) { Remove-Item $splitBase -Recurse -Force -ErrorAction SilentlyContinue }
}

$zipMbEvList = @()
foreach ($ez in @($evidenceZipPaths)) {
  if (Test-Path -LiteralPath $ez) {
    $zipMbEvList += "{0} ({1} MB)" -f (Split-Path -Leaf $ez), ([math]::Round((Get-Item -LiteralPath $ez).Length / 1MB, 2))
  }
}
$zipMbSrcList = @()
foreach ($sz in @($sourceZipPaths)) {
  if (Test-Path -LiteralPath $sz) {
    $zipMbSrcList += "{0} ({1} MB)" -f (Split-Path -Leaf $sz), ([math]::Round((Get-Item -LiteralPath $sz).Length / 1MB, 2))
  }
}

$zipMbPartList = @()
foreach ($pz in @($partBundleZipPaths)) {
  if (Test-Path -LiteralPath $pz) {
    $zipMbPartList += "{0} ({1} MB)" -f (Split-Path -Leaf $pz), ([math]::Round((Get-Item -LiteralPath $pz).Length / 1MB, 2))
  }
}

$buildInfoPath = Join-Path $proj "REVIEW_BUNDLE_BUILD_INFO_$stamp.md"
$zipPathDisplay = if ($fullZipOmitted) { "(略過：超過單檔 499 MiB)" } else { [string]$zipPath }
$buildInfo = @'
# REVIEW BUNDLE 建置資訊
- **時間**：__STAMP__
- **單檔上限**：499 MiB（每個 .zip 均應 ≤ 此值；完整包過大時自動略過）
- **完整包**：__ZIPPATH__（__ZIPMB__ MB）
- **超上限時 PART 分包（REVIEW-BUNDLE_PART01 / PART02 / PART03…）**：__ZIPPARTLIST__
- **證據包（完整包未超上限時另存，無 source）**：__ZIPEVLIST__
- **原始碼包（完整包未超上限時另存，REVIEW-SOURCE-Pxx）**：__ZIPSRC_LIST__
- **phase**：Phase 34 / 34B
- **還原**：單檔全包直接解壓即可。若為 PART 分包：各 zip 內根目錄皆為 `REVIEW_BUNDLE/`，合併同層資料夾；若僅有 `REVIEW-SOURCE-Pxx`：解壓後將各 `source` 合併到同一 `source`。
'@
$evListTxt = if ($zipMbEvList.Count -gt 0) { ($zipMbEvList -join "`n- ") } else { "（無）" }
$srcListTxt = if ($zipMbSrcList.Count -gt 0) { ($zipMbSrcList -join "`n- ") } else { "（無）" }
$partListTxt = if ($zipMbPartList.Count -gt 0) { ($zipMbPartList -join "`n- ") } else { "（無）" }
$buildInfo = $buildInfo.Replace('__STAMP__', [string]$stamp).Replace('__ZIPPATH__', $zipPathDisplay).Replace('__ZIPMB__', [string]$zipMb).Replace('__ZIPEVLIST__', $evListTxt).Replace('__ZIPSRC_LIST__', $srcListTxt).Replace('__ZIPPARTLIST__', $partListTxt)
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($buildInfoPath, $buildInfo, $utf8NoBom)

Remove-Item $base -Recurse -Force

Write-Host ""
Write-Host "========== DONE =========="
if (-not $fullZipOmitted) { Write-Host "FULL ZIP: $zipPath ($zipMb MB)" } else { Write-Host "FULL ZIP: (omitted > 499 MiB)" }
foreach ($line in $zipMbPartList) { Write-Host "PART:     $line" }
foreach ($line in $zipMbEvList) { Write-Host "EVIDENCE: $line" }
foreach ($line in $zipMbSrcList) { Write-Host "SOURCE:   $line" }
Write-Host "BUILD_INFO: $buildInfoPath"
Write-Host "==========================="
foreach ($ez in @($evidenceZipPaths)) {
  if ((Get-Item -LiteralPath $ez).Length -gt $script:MaxZipBytes) {
    Write-Warning ("證據 zip 仍超過上限: {0}" -f (Split-Path -Leaf $ez))
  }
}
foreach ($sz in @($sourceZipPaths)) {
  if ((Get-Item -LiteralPath $sz).Length -gt $script:MaxZipBytes) {
    Write-Warning ("原始碼 zip 仍超過上限: {0}" -f (Split-Path -Leaf $sz))
  }
}
foreach ($pz in @($partBundleZipPaths)) {
  if ((Get-Item -LiteralPath $pz).Length -gt $script:MaxZipBytes) {
    Write-Warning ("PART 分包 zip 仍超過上限: {0}" -f (Split-Path -Leaf $pz))
  }
}
