<#
  Shows the call bridge server, which otherwise runs invisibly as the "CallBridge Server",
  "CallBridge HTTPS" and "CallBridge TURN" background tasks: whether they run, what is connected,
  and the server's log live. Closing this window does not stop the server.
#>
. "$PSScriptRoot\common.ps1"
$Log = Join-Path $ServerDir 'logs\server.log'
$Host.UI.RawUI.WindowTitle = 'Call Bridge server monitor'

Write-Host ''
Write-Host ' Call Bridge server' -ForegroundColor Cyan
Write-Host ' It runs in the background (as SYSTEM), so it keeps running when you close this window,'
Write-Host ' disconnect Remote Desktop, or log off. This window only shows what it is doing.'
Write-Host ''
foreach ($name in $TaskNames) {
  $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  $state = if ($task) { "$($task.State)" } else { 'NOT INSTALLED (run setup.cmd)' }
  $color = if ($state -eq 'Running') { 'Green' } else { 'Red' }
  Write-Host (" {0,-18} {1}" -f $name, $state) -ForegroundColor $color
}
$health = $null
foreach ($a in Get-Addresses) {
  try {
    $health = Invoke-RestMethod "https://$a/healthz" -TimeoutSec 5 -UseBasicParsing
    Write-Host (" {0,-18} wss://{1}/call  is answering" -f 'Address', $a) -ForegroundColor Green
  } catch {
    Write-Host (" {0,-18} wss://{1}/call  is NOT answering: {2}" -f 'Address', $a, $_.Exception.Message) -ForegroundColor Red
  }
}
if ($health) {
  Write-Host (" {0,-18} {1} min" -f 'Up for', [Math]::Round($health.uptimeSec / 60))
  Write-Host (" {0,-18} {1}" -f 'Teams computers', $health.teamsComputers)
  Write-Host (" {0,-18} {1}" -f 'Call Bridge apps', $health.apps)
  Write-Host (" {0,-18} {1} ringing, {2} live" -f 'Calls', $health.ringing, $health.calls)
} else {
  Write-Host ' Start it with start.bat.' -ForegroundColor Yellow
}
Write-Host ''
Write-Host ' Live server log (Ctrl+C or close the window to stop watching):' -ForegroundColor Cyan
Write-Host ''
if (Test-Path $Log) { Get-Content $Log -Tail 15 -Wait } else { Write-Host " No log yet at $Log" }
