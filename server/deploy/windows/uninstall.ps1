<#
  Undoes install.ps1: stops and removes the three startup tasks and the firewall rules.
  Leaves server\.env (your tokens), logs and the certificate cache in place; delete them by hand if you want.
  Run in an elevated PowerShell.
#>
$ErrorActionPreference = 'Stop'
foreach ($name in 'CallBridge Server', 'CallBridge HTTPS', 'CallBridge TURN') {
  if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
    Write-Host "Removed task '$name'."
  }
}
# cmd.exe ends with the task, but node/caddy children can outlive it.
Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -eq 'node.exe' -and ($_.CommandLine -like '*--env-file=.env server.js*' -or $_.CommandLine -like '*--env-file=.env turn-server.js*')) -or
  ($_.Name -eq 'caddy.exe' -and $_.CommandLine -like '*reverse-proxy*')
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host "Stopped $($_.Name) ($($_.ProcessId))." }
foreach ($name in 'CallBridge HTTPS', 'CallBridge TURN') {
  if (Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue) {
    Remove-NetFirewallRule -DisplayName $name
    Write-Host "Removed firewall rule '$name'."
  }
}
