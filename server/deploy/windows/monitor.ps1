<#
  Shows the call bridge server, which otherwise runs invisibly as the "CallBridge Server" and
  "CallBridge HTTPS" background tasks: whether they run, what is connected, and the server's log
  live. Closing this window does not stop the server.
#>
$ServerDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Log = Join-Path $ServerDir 'logs\server.log'
$Host.UI.RawUI.WindowTitle = 'Call Bridge server monitor'

$https = Get-ScheduledTask -TaskName 'CallBridge HTTPS' -ErrorAction SilentlyContinue
$domain = if ($https) { $https.Actions[0].Arguments -replace '.*--from\s+(\S+).*', '$1' } else { $null }

Write-Host ''
Write-Host ' Call Bridge server' -ForegroundColor Cyan
Write-Host ' It runs in the background (as SYSTEM), so it keeps running when you close this window,'
Write-Host ' disconnect Remote Desktop, or log off. This window only shows what it is doing.'
Write-Host ''
foreach ($name in 'CallBridge Server', 'CallBridge HTTPS', 'CallBridge TURN') {
  $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  $state = if ($task) { "$($task.State)" } else { 'NOT INSTALLED (run deploy\windows\install.ps1)' }
  $color = if ($state -eq 'Running') { 'Green' } else { 'Red' }
  Write-Host (" {0,-18} {1}" -f $name, $state) -ForegroundColor $color
}
if ($domain) {
  try {
    $h = Invoke-RestMethod "https://$domain/healthz" -TimeoutSec 8
    Write-Host (" {0,-18} https://{1}/  is answering" -f 'Address', $domain) -ForegroundColor Green
    Write-Host (" {0,-18} {1} min" -f 'Up for', [Math]::Round($h.uptimeSec / 60))
    Write-Host (" {0,-18} {1}" -f 'Teams computers', $h.teamsComputers)
    Write-Host (" {0,-18} {1}" -f 'Call Bridge apps', $h.apps)
    Write-Host (" {0,-18} {1} ringing, {2} live" -f 'Calls', $h.ringing, $h.calls)
  } catch {
    Write-Host (" {0,-18} https://{1}/  is NOT answering: {2}" -f 'Address', $domain, $_.Exception.Message) -ForegroundColor Red
    Write-Host ' Start it with start.bat.' -ForegroundColor Yellow
  }
}
Write-Host ''
Write-Host ' Live server log (Ctrl+C or close the window to stop watching):' -ForegroundColor Cyan
Write-Host ''
if (Test-Path $Log) { Get-Content $Log -Tail 15 -Wait } else { Write-Host " No log yet at $Log" }
