<#
  Starts the call bridge server installed by install.ps1 (the "CallBridge Server", "CallBridge HTTPS"
  and "CallBridge TURN" startup tasks) and checks that it answers. Normally not needed: the tasks
  start at boot and restart themselves. Asks for administrator rights if it doesn't have them.
#>
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\common.ps1"
if (-not (Test-Admin)) {
  Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -NoExit -File `"$PSCommandPath`""
  return
}

foreach ($name in $TaskNames) {
  $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if (-not $task) { throw "Task '$name' is not installed. Run server\setup.cmd first." }
  if ($task.State -ne 'Running') { Start-ScheduledTask -TaskName $name; Write-Host "Started '$name'." }
  else { Write-Host "'$name' is already running." }
}

$domain = Get-Addresses | Select-Object -First 1
Write-Host "Checking https://$domain/healthz ..."
for ($i = 0; $i -lt 10; $i++) {
  try {
    $health = Invoke-RestMethod "https://$domain/healthz" -TimeoutSec 5 -UseBasicParsing
    if ($health.ok) {
      Write-Host "Server is running: https://$domain/  (live calls: $($health.calls))" -ForegroundColor Green
      return
    }
  } catch { Start-Sleep -Seconds 2 }
}
Write-Host "Not answering yet. See server\logs\server.log and server\logs\caddy.log." -ForegroundColor Yellow
