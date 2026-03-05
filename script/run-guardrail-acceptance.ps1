# Guardrail acceptance: 10 test cases. Server must be on http://127.0.0.1:5001
# Usage: .\script\run-guardrail-acceptance.ps1
$ErrorActionPreference = "Stop"
$base = "http://127.0.0.1:5001"
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession

$cases = @(
  @{ msg = "我要退款"; expectNoSecond = $true },
  @{ msg = "我要客訴"; expectNoSecond = $true },
  @{ msg = "你們都不回訊息"; expectNoSecond = $true },
  @{ msg = "上週訂的還沒收到"; expectNoSecond = $true },
  @{ msg = "這品質也太差"; expectNoSecond = $true },
  @{ msg = "商品有瑕疵"; expectNoSecond = $true },
  @{ msg = "我不要了可以取消嗎"; expectNoSecond = $true },
  @{ msg = "請問多少錢"; expectNoSecond = $false },
  @{ msg = "請問哪裡買"; expectNoSecond = $false },
  @{ msg = "這款敏感肌可以用嗎"; expectNoSecond = $false }
)

$null = Invoke-WebRequest -Uri ($base + "/api/auth/login") -Method POST -Body '{"username":"admin","password":"admin123"}' -ContentType "application/json" -WebSession $session -UseBasicParsing

$results = @()
$idx = 0
foreach ($c in $cases) {
  $idx++
  $body = '{"page_id":"page_demo","post_id":"post_001","commenter_name":"Acceptance","message":"' + $c.msg + '","is_simulated":1}'
  $create = Invoke-WebRequest -Uri ($base + "/api/meta-comments") -Method POST -Body $body -ContentType "application/json; charset=utf-8" -WebSession $session -UseBasicParsing
  $comment = $create.Content | ConvertFrom-Json
  $id = $comment.id

  $suggest = Invoke-WebRequest -Uri ($base + "/api/meta-comments/" + $id + "/suggest-reply") -Method POST -WebSession $session -UseBasicParsing
  $after = $suggest.Content | ConvertFrom-Json

  $hasSecond = $after.reply_second -and ($after.reply_second.ToString().Trim() -ne "")
  $pass = ($c.expectNoSecond -and -not $hasSecond) -or (-not $c.expectNoSecond -and $hasSecond)
  $results += [PSCustomObject]@{
    n = $idx
    msg = $c.msg
    classifier_source = $after.classifier_source
    final_intent = $after.ai_intent
    is_high_risk = ($after.priority -eq "urgent" -or $after.ai_suggest_human -eq 1)
    reply_second = if ($hasSecond) { "有" } else { "無" }
    pass = $pass
  }
}

Write-Host "=== Guardrail acceptance ==="
$results | Format-Table -AutoSize n, msg, classifier_source, final_intent, is_high_risk, reply_second, pass
$passed = ($results | Where-Object { $_.pass }).Count
Write-Host "Passed: $passed / 10"
