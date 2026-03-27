# One-shot: verify pack-review-bundle.ps1 parses under PS 5.1 (file must be UTF-8 with BOM)
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$p = Join-Path $here 'pack-review-bundle.ps1'
$err = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($p, [ref]$null, [ref]$err)
if ($err.Count -gt 0) {
  $err | ForEach-Object { Write-Host $_.Message }
  exit 1
}
Write-Host 'ParseFile_OK'
