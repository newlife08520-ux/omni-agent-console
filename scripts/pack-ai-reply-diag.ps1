#Requires -Version 5.1
<#
.SYNOPSIS
  打包 AI 回覆診斷用原始碼與 CONTEXT.md 至 ZIP，並複製到桌面。
#>
$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $ProjectRoot

$Staging = Join-Path $ProjectRoot "diag-export"
if (Test-Path -LiteralPath $Staging) {
  Remove-Item -LiteralPath $Staging -Recurse -Force
}
New-Item -ItemType Directory -Path $Staging -Force | Out-Null

function Copy-ProjectRel {
  param(
    [Parameter(Mandatory = $true)][string]$RelativePath,
    [switch]$Optional
  )
  $src = Join-Path $ProjectRoot $RelativePath
  if (-not (Test-Path -LiteralPath $src)) {
    if (-not $Optional) {
      Write-Warning "Missing path (skipped): $RelativePath"
    }
    return $false
  }
  $dest = Join-Path $Staging $RelativePath
  $destParent = Split-Path -Parent $dest
  if (-not (Test-Path -LiteralPath $destParent)) {
    New-Item -ItemType Directory -Path $destParent -Force | Out-Null
  }
  Copy-Item -LiteralPath $src -Destination $dest -Force
  return $true
}

$required = @(
  "server/index.ts",
  "server/routes.ts",
  "server/storage.ts",
  "server/db.ts",
  "server/queue/ai-reply.queue.ts",
  "server/workers/ai-reply-worker-shared.ts",
  "server/services/ai-reply.service.ts",
  "package.json",
  "tsconfig.json"
)
foreach ($p in $required) {
  [void](Copy-ProjectRel $p)
}

[void](Copy-ProjectRel "server/workers/ai-reply.worker.ts" -Optional)
[void](Copy-ProjectRel "server/services/messaging.service.ts" -Optional)

$hasLineSvc = Copy-ProjectRel "server/services/line.service.ts" -Optional
if (-not $hasLineSvc) {
  [void](Copy-ProjectRel "server/controllers/line-webhook.controller.ts" -Optional)
}

$hasGeminiSvc = Copy-ProjectRel "server/services/gemini.service.ts" -Optional
if (-not $hasGeminiSvc) {
  [void](Copy-ProjectRel "server/services/ai-client.service.ts" -Optional)
}

[void](Copy-ProjectRel "server/redis-client.ts" -Optional)

$webhookDir = Join-Path $ProjectRoot "server/webhook"
if (Test-Path -LiteralPath $webhookDir) {
  Get-ChildItem -LiteralPath $webhookDir -Filter "*.ts" -Recurse -File -ErrorAction SilentlyContinue |
    ForEach-Object {
      $full = $_.FullName
      $rel = $full.Substring($ProjectRoot.Length).TrimStart([char]0x005C, [char]0x002F)
      [void](Copy-ProjectRel $rel)
    }
}

[void](Copy-ProjectRel "railway.json" -Optional)
[void](Copy-ProjectRel "railway.toml" -Optional)
[void](Copy-ProjectRel ".env.example" -Optional)

# --- Git：最近 5 個 commit hash ---
Push-Location -LiteralPath $ProjectRoot
$commitLines = @()
try {
  $null = git rev-parse --is-inside-work-tree 2>$null
  if ($LASTEXITCODE -eq 0) {
    $hashes = @(git log -5 --format=%H 2>$null)
    if ($hashes.Count -gt 0) {
      $commitLines = $hashes | ForEach-Object { "- $_" }
    }
  }
}
catch {
  # ignore
}
finally {
  Pop-Location
}
if ($commitLines.Count -eq 0) {
  $commitBlock = "（無法取得：此目錄非 git 儲存庫、或 git 不可用、或尚無 commit。）"
}
else {
  $commitBlock = ($commitLines -join "`n")
}

$contextPath = Join-Path $Staging "CONTEXT.md"
$contextTemplate = Join-Path $PSScriptRoot "ai-reply-diag-CONTEXT.template.md"
if (-not (Test-Path -LiteralPath $contextTemplate)) {
  Write-Error "Missing CONTEXT template: $contextTemplate"
}
$contextBody = (Get-Content -LiteralPath $contextTemplate -Raw -Encoding utf8).Replace(
  "__COMMIT_BLOCK__",
  $commitBlock
)
Set-Content -LiteralPath $contextPath -Value $contextBody -Encoding utf8

$stamp = Get-Date -Format "yyyyMMdd-HHmm"
$zipName = "diag-export-$stamp.zip"
$zipPath = Join-Path $ProjectRoot $zipName
if (Test-Path -LiteralPath $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}
Compress-Archive -LiteralPath $Staging -DestinationPath $zipPath -CompressionLevel Optimal -Force

$desktop = [Environment]::GetFolderPath("Desktop")
$desktopZip = Join-Path $desktop $zipName
Copy-Item -LiteralPath $zipPath -Destination $desktopZip -Force
$classicDesktop = Join-Path $env:USERPROFILE "Desktop"
if (
  (Test-Path -LiteralPath $classicDesktop) -and
  ($classicDesktop.TrimEnd([char]0x005C) -ne $desktop.TrimEnd([char]0x005C))
) {
  Copy-Item -LiteralPath $zipPath -Destination (Join-Path $classicDesktop $zipName) -Force
}

Remove-Item -LiteralPath $Staging -Recurse -Force

$item = Get-Item -LiteralPath $zipPath
Write-Host "ZIP (project): $($item.FullName)"
Write-Host "ZIP (desktop): $desktopZip"
Write-Host "Size bytes: $($item.Length)"
