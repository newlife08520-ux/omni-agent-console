$p = Join-Path $PSScriptRoot 'pack-review-bundle.ps1'
$err = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($p, [ref]$null, [ref]$err)
if ($err.Count -gt 0) { $err | ForEach-Object { "$($_.Extent.StartLineNumber): $($_.Message)" } ; exit 1 }
Write-Host 'OK'
