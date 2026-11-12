<#
  Starts the call bridge server installed by install.ps1 (the "CallBridge Server" and
  "CallBridge HTTPS" startup tasks) and checks that it answers. Normally not needed: the tasks
  start at boot and restart themselves. Asks for administrator rights if it doesn't have them.
#>
$ErrorActionPreference = 'Stop'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -NoExit -File `"$PSCommandPath`""
  return
}

$tasks = 'CallBridge Server', 'CallBridge HTTPS'
foreach ($name in $tasks) {
  $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if (-not $task) { throw "Task '$name' is not installed. Run server\deploy\windows\install.ps1 first." }
  if ($task.State -ne 'Running') { Start-ScheduledTask -TaskName $name; Write-Host "Started '$name'." }
  else { Write-Host "'$name' is already running." }
}

$domain = (Get-ScheduledTask -TaskName 'CallBridge HTTPS').Actions[0].Arguments -replace '.*--from\s+(\S+).*', '$1'
Write-Host "Checking https://$domain/healthz ..."
for ($i = 0; $i -lt 10; $i++) {
  try {
    $health = Invoke-RestMethod "https://$domain/healthz" -TimeoutSec 5
    if ($health.ok) {
      Write-Host "Server is running: https://$domain/  (live calls: $($health.calls))" -ForegroundColor Green
      return
    }
  } catch { Start-Sleep -Seconds 2 }
}
Write-Host "Not answering yet. See server\logs\server.log and server\logs\caddy.log." -ForegroundColor Yellow
