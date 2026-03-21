# 整體原始碼 ZIP（排除 node_modules、.git、dist、DB、uploads 等）
# 輸出：專案根目錄 Omni-Agent-Console-SOURCE_YYYYMMDD_HHmmss.zip
$ErrorActionPreference = "Stop"
$proj = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $proj "package.json"))) { $proj = $PSScriptRoot }
$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$staging = Join-Path $env:TEMP "OmniSourceZip_$stamp"
$zipName = "Omni-Agent-Console-SOURCE_$stamp.zip"
$zipPath = Join-Path $proj $zipName

New-Item -ItemType Directory -Path (Join-Path $staging "SOURCE") -Force | Out-Null

Write-Host "Copying -> $staging\SOURCE (excludes: node_modules, .git, dist, .cursor, mcps, uploads, DB, logs) ..."
robocopy $proj (Join-Path $staging "SOURCE") /E /NFL /NDL /NJH /NJS /NP `
  /XD node_modules .git dist .cursor mcps uploads __pycache__ .vite coverage .idea `
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
# Omni-Agent-Console — 整體原始碼打包

- **SOURCE/**：專案原始碼（已排除 node_modules、dist、.git、uploads、DB、log 等）
- **AI-BUNDLE-CONTEXT.json**：AI 相關設定摘要（Phase 31 起預設 secret/PII 已清理）
- 打包時間：$stamp
"@
$readme | Out-File -FilePath (Join-Path $staging "README_ZIP.md") -Encoding utf8

Write-Host "Zipping -> $zipPath"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $zipPath -Force
Remove-Item $staging -Recurse -Force
Write-Host "Done: $zipPath"
$size = (Get-Item $zipPath).Length / 1MB
Write-Host ("Size: {0:N1} MB" -f $size)
