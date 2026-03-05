# E2E acceptance for Meta comment center. Run with: .\script\e2e-meta-comments.ps1
# Requires: server running on http://127.0.0.1:5001
$ErrorActionPreference = "Stop"
$base = "http://127.0.0.1:5001"
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession

function Api {
  param([string]$Method, [string]$Path, [object]$Body = $null)
  $uri = "$base$Path"
  $params = @{ Uri = $uri; Method = $Method; WebSession = $session; UseBasicParsing = $true }
  if ($Body) { $params.Body = ($Body | ConvertTo-Json -Depth 10); $params.ContentType = "application/json" }
  $r = Invoke-WebRequest @params
  $text = $r.Content
  if ($text -match '^\s*<') { throw "Response was HTML, not JSON: $($text.Substring(0, [Math]::Min(200, $text.Length)))" }
  try { return $text | ConvertFrom-Json } catch { return $null }
}

Write-Host "=== 1. Login ==="
$login = Api -Method POST -Path "/api/auth/login" -Body @{ username = "admin"; password = "admin123" }
if (-not $login.success) { throw "Login failed" }
Write-Host "Login OK"

Write-Host ""; Write-Host "=== 2. GET meta-comments (list) ==="
$list = Api -Method GET -Path "/api/meta-comments"
if ($null -eq $list) { throw "GET /api/meta-comments returned null" }
$listArr = @($list)
Write-Host "Comments count: $($listArr.Count)"
$first = $listArr[0]
if ($first) {
  Write-Host "First comment: id=$($first.id) commenter=$($first.commenter_name) assigned_agent_name=$($first.assigned_agent_name) is_simulated=$($first.is_simulated)"
}

Write-Host ""; Write-Host "=== 3. Assign / Reassign / Unassign ==="
$cid = $first.id
# Assign
$assignBody = @{ agent_id = 1; agent_name = "系統管理員" }
$assignUri = $base + "/api/meta-comments/" + $cid + "/assign"
$r1 = Invoke-WebRequest -Uri $assignUri -Method POST -Body ($assignBody | ConvertTo-Json) -ContentType "application/json" -WebSession $session -UseBasicParsing
$afterAssign = ($r1.Content | ConvertFrom-Json)
if ($afterAssign.assigned_agent_id -ne 1) { throw "Assign: assigned_agent_id expected 1, got $($afterAssign.assigned_agent_id)" }
Write-Host "Assign OK: assigned_agent_name=$($afterAssign.assigned_agent_name)"
# Unassign
$unassignUri = $base + "/api/meta-comments/" + $cid + "/unassign"
$r2 = Invoke-WebRequest -Uri $unassignUri -Method POST -WebSession $session -UseBasicParsing
$afterUnassign = ($r2.Content | ConvertFrom-Json)
if ($null -ne $afterUnassign.assigned_agent_id) { throw "Unassign: assigned_agent_id should be null, got $($afterUnassign.assigned_agent_id)" }
Write-Host "Unassign OK"

Write-Host ""; Write-Host "=== 4. Simulate webhook ==="
$whBody = @{ message = "E2E webhook test"; commenter_name = "E2EUser"; post_id = "post_001"; page_id = "page_demo" }
$wh = Api -Method POST -Path "/api/meta-comments/simulate-webhook" -Body $whBody
if (-not $wh.id) { throw "Simulate webhook: no id in response" }
Write-Host "Simulate webhook OK: id=$($wh.id) is_simulated=$($wh.is_simulated)"

Write-Host ""; Write-Host "=== 5. Seed test cases ==="
$seedBody = @{ page_id = "page_demo"; post_id = "post_001" }
$seedResp = Invoke-WebRequest -Uri "$base/api/meta-comments/seed-test-cases" -Method POST -Body ($seedBody | ConvertTo-Json) -ContentType "application/json" -WebSession $session -UseBasicParsing
$seedText = $seedResp.Content
if ($seedText -match '^\s*<') { throw "Seed returned HTML" }
$seed = $seedText | ConvertFrom-Json
Write-Host "Seed OK: created=$($seed.created) ids=$($seed.ids -join ',')"

Write-Host ""; Write-Host "=== 6. Source filter ==="
$all = (Api -Method GET -Path "/api/meta-comments").Count
$sim = (Api -Method GET -Path "/api/meta-comments?source=simulated").Count
$real = (Api -Method GET -Path "/api/meta-comments?source=real").Count
Write-Host "all=$all simulated=$sim real=$real"

Write-Host ""; Write-Host "=== 7. Mapping duplicate check ==="
$brandId = 1
$m1 = Api -Method POST -Path "/api/meta-post-mappings" -Body @{ brand_id = $brandId; page_id = "page_e2e"; post_id = "post_e2e_dup"; post_name = "E2E Dup"; auto_comment_enabled = 1 }
Write-Host "First mapping id=$($m1.id)"
try {
  $m2 = Invoke-WebRequest -Uri "$base/api/meta-post-mappings" -Method POST -Body '{"brand_id":1,"page_id":"page_e2e","post_id":"post_e2e_dup","post_name":"E2E Dup2","auto_comment_enabled":1}' -ContentType "application/json" -WebSession $session -UseBasicParsing
  Write-Host "FAIL: Second mapping should be rejected (400)"
} catch {
  if ($_.Exception.Response.StatusCode -eq 400) { Write-Host "PASS: Duplicate rejected with 400" } else { throw $_ }
}
# Cleanup
Invoke-WebRequest -Uri "$base/api/meta-post-mappings/$($m1.id)" -Method DELETE -WebSession $session -UseBasicParsing | Out-Null

Write-Host ""; Write-Host "=== 8. Test mapping ==="
$mappings = Api -Method GET -Path "/api/meta-post-mappings"
$mapFirst = @($mappings)[0]
if ($mapFirst) {
  $testBody = @{ mapping_id = $mapFirst.id }
  $testComment = Api -Method POST -Path "/api/meta-comments/test-mapping" -Body $testBody
  if (-not $testComment.id) { throw "Test mapping: no id" }
  Write-Host "Test mapping OK: comment id=$($testComment.id) is_simulated=$($testComment.is_simulated)"
}

Write-Host ""; Write-Host "=== 9. Suggest-reply (general inquiry) - need comment with product question ==="
$list2 = Api -Method GET -Path "/api/meta-comments?source=simulated"
$simComment = @($list2) | Where-Object { $_.message -match "還有貨|多少錢|哪裡" } | Select-Object -First 1
if (-not $simComment) { $simComment = @($list2)[0] }
$sid = $simComment.id
$suggestResp = Invoke-WebRequest -Uri "$base/api/meta-comments/$sid/suggest-reply" -Method POST -WebSession $session -UseBasicParsing
$afterSuggest = ($suggestResp.Content | ConvertFrom-Json)
Write-Host "Suggest-reply: intent=$($afterSuggest.ai_intent) reply_first len=$($afterSuggest.reply_first.Length) reply_second len=$($afterSuggest.reply_second.Length) link_source=$($afterSuggest.reply_link_source)"

Write-Host ""; Write-Host "=== 10. Suggest-reply (complaint) - no second reply ==="
$complaintBody = @{ page_id = "page_demo"; post_id = "post_001"; commenter_name = "E2E Complaint"; message = "我要退款，還沒收到"; is_simulated = 1 }
$createResp = Invoke-WebRequest -Uri "$base/api/meta-comments" -Method POST -Body ($complaintBody | ConvertTo-Json) -ContentType "application/json" -WebSession $session -UseBasicParsing
$complaintComment = ($createResp.Content | ConvertFrom-Json)
$suggestComplaint = Invoke-WebRequest -Uri "$base/api/meta-comments/$($complaintComment.id)/suggest-reply" -Method POST -WebSession $session -UseBasicParsing
$afterComplaint = ($suggestComplaint.Content | ConvertFrom-Json)
if ($afterComplaint.reply_second -and $afterComplaint.reply_second.Trim() -ne "") { Write-Host "FAIL: Complaint should have no reply_second" } else { Write-Host "PASS: Complaint has no reply_second (only comfort)" }

Write-Host ""
Write-Host "=== E2E script finished ==="
