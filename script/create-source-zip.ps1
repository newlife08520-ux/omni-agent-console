# 依 PACKAGING_AND_DB_SOURCE_OF_TRUTH 產出乾淨 source ZIP
# 排除：.git, node_modules, dist, .env, *.db, data/, data_coldstart/, log, cache
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$outDir = Join-Path $root ".."
$zipName = "Omni-Agent-Console-source-clean.zip"
$zipPath = Join-Path $outDir $zipName

$excludeDirs = @(".git", "node_modules", "dist", "data", "data_coldstart", ".local", ".replit")
$excludeFiles = @(".env")

function ShouldExclude($relPath) {
  $parts = $relPath -split [IO.Path]::DirectorySeparatorChar
  foreach ($d in $excludeDirs) {
    if ($parts -contains $d) { return $true }
  }
  if ($relPath -like "*.db" -or $relPath -like "*.db-wal" -or $relPath -like "*.db-shm" -or $relPath -like "*.log") { return $true }
  $fileName = [IO.Path]::GetFileName($relPath)
  if ($excludeFiles -contains $fileName) { return $true }
  return $false
}

$tempDir = Join-Path $env:TEMP "Omni-Agent-Console-source-$([Guid]::NewGuid().ToString('N').Substring(0,8))"
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
Push-Location $root
try {
  Get-ChildItem -Path . -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($root.Length + 1).Replace([IO.Path]::DirectorySeparatorChar, "/")
    if (ShouldExclude($rel)) { return }
    $dest = Join-Path $tempDir $rel
    $destDir = Split-Path -Parent $dest
    if (!(Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
    Copy-Item -Path $_.FullName -Destination $dest -Force
  }
  if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
  Compress-Archive -Path (Join-Path $tempDir "*") -DestinationPath $zipPath -Force
  Write-Host "Created: $zipPath"
  Write-Host "Root entries in ZIP:"
  Get-ChildItem -Path $tempDir -Name | Sort-Object
} finally {
  Pop-Location
  if (Test-Path $tempDir) { Remove-Item -Recurse -Force $tempDir }
}
