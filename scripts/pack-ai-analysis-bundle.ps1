# 打包給 AI 解析：原始碼 + 人格/設定匯出（不含 node_modules、DB 本體）
$ErrorActionPreference = "Stop"
$proj = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $proj "package.json"))) { $proj = $PSScriptRoot }
$parent = Split-Path -Parent $proj
$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$staging = Join-Path $env:TEMP "OmniAIBundle_$stamp"
$zipName = "Omni-Agent-Console-AI-ANALYSIS-BUNDLE_$stamp.zip"
$zipPath = Join-Path $parent $zipName

New-Item -ItemType Directory -Path (Join-Path $staging "SOURCE") -Force | Out-Null

Write-Host "Copying source -> $staging\SOURCE ..."
$robolog = Join-Path $env:TEMP "robocopy-ai-$stamp.log"
robocopy $proj (Join-Path $staging "SOURCE") /E /NFL /NDL /NJH /NJS /NP `
  /XD node_modules .git dist .cursor mcps uploads __pycache__ .vite `
  /XF *.db *.db-shm *.db-wal *.log | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed: $LASTEXITCODE" }

$ctxPath = Join-Path $staging "AI-BUNDLE-CONTEXT.json"
Push-Location $proj
try {
  node scripts/export-ai-bundle-context.mjs $ctxPath
} finally {
  Pop-Location
}

$readme = @"
# Omni-Agent-Console — 給 AI 解析用打包說明

## 資安說明（Phase 31）
本 bundle 匯出時**預設已做 secret / PII 清理**：
- settings 中敏感鍵（api_key、token、secret、password、access_key 等）一律 redact，不輸出實際值。
- 電話、email、地址等 PII 在匯出內容中會遮罩。
- 若需除錯用 raw 匯出，請設定環境變數 EXPORT_RAW_SECRETS=1 後再執行 export（僅限本機除錯）。

## 請優先閱讀
1. **AI-BUNDLE-CONTEXT.json** — 從本機 SQLite 匯出（若當時 DB 不在預設路徑會是空的/錯誤訊息）：
   - global_system_prompt：全域人格（設定「系統指令」）
   - brands_persona：各品牌 system_prompt（品牌人格）
   - settings_ai_related：與 AI/模型相關的 settings 鍵值（敏感值已 redact）
   - recent_ai_logs：最近約 80 筆 AI 回覆軌跡（reply_source、prompt_profile、轉人工等），方便查「回覆異常」

2. **SOURCE/** — 完整原始碼（已排除 node_modules、dist、.git、uploads、DB 檔）

## 與「人格、回覆」最相關的檔案
| 路徑 | 說明 |
|------|------|
| SOURCE/server/services/prompt-builder.ts | Prompt 組裝、brand_persona 區塊 |
| SOURCE/server/prompts/order-ultra-lite.ts | 查單等精簡 profile 文案 |
| SOURCE/server/routes.ts | Webhook、LLM 呼叫、handoff（檔案大，搜 prompt_profile / handoff） |
| SOURCE/server/workers/ai-reply.worker.ts | 背景 AI 回覆 worker |
| SOURCE/docs/Prompt單一真相與Runtime追蹤報告.md | 人格資料存在哪裡 |
| SOURCE/docs/為什麼不會自動回覆.md、轉人工*.md | 常見回覆問題 |

## 若 JSON 內沒有品牌人格
代表匯出時找不到 omnichannel.db。請在**與平常啟動服務相同環境**下執行：
````
cd （專案目錄）
set DATA_DIR=（你的資料目錄，若有用）
node scripts/export-ai-bundle-context.mjs AI-BUNDLE-CONTEXT.json
````
再把產生的 JSON 一併提供給 AI。

打包時間：$stamp
"@
$readme | Out-File -FilePath (Join-Path $staging "README_FOR_AI_ANALYSIS.md") -Encoding utf8

Write-Host "Zipping -> $zipPath"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $zipPath -Force
Write-Host "Done: $zipPath"
$size = (Get-Item $zipPath).Length / 1MB
Write-Host ("Size: {0:N1} MB" -f $size)
