# Creates CHATGPT_REVIEW_RUNTIME_ADDON.zip with forward-slash entry names
# and top-level folder CHATGPT_REVIEW_RUNTIME_ADDON/ (ZIP spec friendly).
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

$staging = Join-Path $root "review_runtime_addon_staging"
$zipPath = Join-Path $root "CHATGPT_REVIEW_RUNTIME_ADDON.zip"
$top = "CHATGPT_REVIEW_RUNTIME_ADDON"

if (-not (Test-Path -LiteralPath $staging)) {
  Write-Error "Missing folder: $staging"
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }

$zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  function Add-Dir([System.IO.Compression.ZipArchive]$Za, [string]$Dir, [string]$ZipRel) {
    foreach ($f in Get-ChildItem -LiteralPath $Dir -File -Force) {
      $entryName = ($ZipRel + "/" + $f.Name) -replace "\\", "/"
      [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $Za,
        $f.FullName,
        $entryName,
        [System.IO.Compression.CompressionLevel]::Optimal
      )
    }
    foreach ($d in Get-ChildItem -LiteralPath $Dir -Directory -Force) {
      Add-Dir $Za $d.FullName ($ZipRel + "/" + $d.Name)
    }
  }
  Add-Dir $zip $staging $top
} finally {
  $zip.Dispose()
}

$item = Get-Item -LiteralPath $zipPath
Write-Host "Wrote $($item.FullName) size=$($item.Length) bytes"
