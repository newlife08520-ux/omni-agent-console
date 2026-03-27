# 打包 R1 交付文件至專案根目錄 R1_DELIVERABLES.zip（與 package.json 同層）
$ErrorActionPreference = "Stop"
$proj = Split-Path $PSScriptRoot -Parent
$rel = @(
  "docs\R1_LIVE_TRUTH.md",
  "docs\RUNTIME_PARITY_REPORT.md",
  "docs\SHOPLINE_TRUTH_REPORT.md",
  "docs\PERSONA_SINGLE_SOURCE_OF_TRUTH.md",
  "docs\PAYMENT_TRUTH_MATRIX.md",
  "docs\R1_MASKED_CASES.md",
  "verify_output\verify_r1.txt"
)
$paths = @()
foreach ($r in $rel) {
  $p = Join-Path $proj $r
  if (Test-Path -LiteralPath $p) { $paths += $p } else { Write-Warning "Skip missing: $p" }
}
if ($paths.Count -eq 0) { throw "No files to zip" }
$out = Join-Path $proj "R1_DELIVERABLES.zip"
if (Test-Path -LiteralPath $out) { Remove-Item -LiteralPath $out -Force }
Compress-Archive -LiteralPath $paths -DestinationPath $out -Force
Get-Item -LiteralPath $out | Select-Object FullName, Length
