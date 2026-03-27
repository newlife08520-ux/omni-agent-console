param([Parameter(Mandatory)][string]$Path)
$raw = [System.IO.File]::ReadAllBytes($Path)
if ($raw.Length -ge 3 -and $raw[0] -eq 0xEF -and $raw[1] -eq 0xBB -and $raw[2] -eq 0xBF) {
  Write-Host "Already has BOM"
  exit 0
}
$utf8 = [System.Text.Encoding]::UTF8
$text = $utf8.GetString($raw)
$bomUtf8 = New-Object System.Text.UTF8Encoding $true
[System.IO.File]::WriteAllText($Path, $text, $bomUtf8)
Write-Host "UTF-8 BOM added: $Path"
