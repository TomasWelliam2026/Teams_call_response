<#
  Undoes install.ps1: stops and removes the three startup tasks and the firewall rules.
  Leaves server\.env (your tokens), logs, the certificate cache and bin\ in place; delete the folder
  by hand if you want it all gone. Asks for administrator rights if it doesn't have them.
#>
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\common.ps1"
if (-not (Test-Admin)) {
  Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -NoExit -File `"$PSCommandPath`""
  return
}
foreach ($name in $TaskNames) {
  if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
    Write-Host "Removed task '$name'."
  }
}
Stop-BridgeProcesses
foreach ($name in 'CallBridge HTTPS', 'CallBridge TURN') {
  if (Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue) {
    Remove-NetFirewallRule -DisplayName $name
    Write-Host "Removed firewall rule '$name'."
  }
}
Write-Host "Uninstalled. Your tokens are still in $EnvFile."
