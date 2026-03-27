# 精簡 ZIP：查單／人格／Phase 驗收「重點包」（不含 client 前端、node_modules、DB）
# 對齊過去 AI 分析 bundle 說明：docs + 訂單主線 server/*.ts + shared schema + 匯出 context
# 輸出：專案根目錄 Omni-Agent-Console-ESSENTIAL_YYYYMMDD_HHmmss.zip
$ErrorActionPreference = "Stop"
$proj = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $proj "package.json"))) { $proj = $PSScriptRoot }
$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$staging = Join-Path $env:TEMP "OmniEssentialZip_$stamp"
$zipName = "Omni-Agent-Console-ESSENTIAL_$stamp.zip"
$zipPath = Join-Path $proj $zipName
$ess = Join-Path $staging "ESSENTIAL"

New-Item -ItemType Directory -Path $ess -Force | Out-Null

Write-Host "Copying docs -> ESSENTIAL\docs ..."
if (Test-Path (Join-Path $proj "docs")) {
  robocopy (Join-Path $proj "docs") (Join-Path $ess "docs") /E /NFL /NDL /NJH /NJS /NP `
    /XD runtime-audit-tmp __pycache__ | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy docs failed: $LASTEXITCODE" }
}

Write-Host "Copying shared -> ESSENTIAL\shared ..."
if (Test-Path (Join-Path $proj "shared")) {
  robocopy (Join-Path $proj "shared") (Join-Path $ess "shared") /E /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy shared failed: $LASTEXITCODE" }
}

Write-Host "Copying server/**/*.ts only -> ESSENTIAL\server ..."
$serverSrc = Join-Path $proj "server"
$serverDst = Join-Path $ess "server"
if (Test-Path $serverSrc) {
  robocopy $serverSrc $serverDst *.ts /S /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy server ts failed: $LASTEXITCODE" }
}

Write-Host "Copying root configs -> ESSENTIAL\ ..."
foreach ($f in @("package.json", "package-lock.json", "tsconfig.json", "tsconfig.server.json", "drizzle.config.ts")) {
  $p = Join-Path $proj $f
  if (Test-Path $p) { Copy-Item $p (Join-Path $ess $f) -Force }
}

Write-Host "Copying scripts (export + verify) -> ESSENTIAL\scripts ..."
$scr = Join-Path $ess "scripts"
New-Item -ItemType Directory -Path $scr -Force | Out-Null
foreach ($f in @("export-ai-bundle-context.mjs", "verify-bundle-safety.mjs", "pack-full-source-zip.ps1", "pack-ai-analysis-bundle.ps1", "pack-essential-zip.ps1")) {
  $p = Join-Path (Join-Path $proj "scripts") $f
  if (Test-Path $p) { Copy-Item $p (Join-Path $scr $f) -Force }
}

$ctxPath = Join-Path $staging "AI-BUNDLE-CONTEXT.json"
Push-Location $proj
try {
  node scripts/export-ai-bundle-context.mjs $ctxPath
} finally {
  Pop-Location
}

$readme = @"
# Omni-Agent-Console — 精簡重點包（ESSENTIAL）

本 ZIP **刻意不含**：
- **client/**（前端原始碼，體積大；查單／驗收多數只需後端）
- **node_modules**、**dist**、**.git**、DB、uploads

本 ZIP **含**：
- **ESSENTIAL/docs/** — Phase 報告、人格、runtime-audit fixture、查單說明等
- **ESSENTIAL/shared/** — 含 schema（OrderInfo 等）
- **ESSENTIAL/server/**/*.ts** — 後端 TypeScript（含 routes、order-*、verify、superlanding 等）
- **ESSENTIAL/package.json**、tsconfig*
- **ESSENTIAL/scripts/** — export-ai-bundle-context、verify-bundle-safety、各 pack 腳本
- **AI-BUNDLE-CONTEXT.json** — 與完整包相同邏輯匯出（敏感值已 redact）

若需含前端，請改用 ``scripts/pack-full-source-zip.ps1``。

打包時間：$stamp
"@
$readme | Out-File -FilePath (Join-Path $staging "README_ESSENTIAL.md") -Encoding utf8

Write-Host "Zipping -> $zipPath"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $zipPath -Force
Remove-Item $staging -Recurse -Force
Write-Host "Done: $zipPath"
$size = (Get-Item $zipPath).Length / 1MB
Write-Host ("Size: {0:N1} MB" -f $size)
