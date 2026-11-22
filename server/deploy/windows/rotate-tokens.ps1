<#
  Replaces BRIDGE_TOKEN and OPERATOR_TOKEN in server\.env with new random ones, for when the old ones
  may have been seen (e.g. .env was committed to a public repository). Then:
    - updates teams-auto-answer\bridge-config.json (if there is one) and rebuilds
      dist\private\teams-call-answerer-extension-with-token.zip with the new BRIDGE_TOKEN,
    - restarts the server and the TURN relay so they use the new tokens (this cuts live calls, so it
      stops if there are any, unless -Force),
    - copies the new OPERATOR_TOKEN to the clipboard. No token is ever printed.
  Afterwards the old tokens stop working: the local app has to sign in with the new operator token,
  and every Teams computer needs the new BRIDGE_TOKEN (the private zip, or its side panel).
  Run:  powershell -ExecutionPolicy Bypass -File server\deploy\windows\rotate-tokens.ps1 [-Force]
  To copy the new BRIDGE_TOKEN later:  ... rotate-tokens.ps1 -CopyBridgeToken   (changes nothing)
#>
param([switch]$Force, [switch]$CopyBridgeToken)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\common.ps1"

if ($CopyBridgeToken) {
  (Read-EnvFile).BRIDGE_TOKEN | Set-Clipboard
  Write-Host 'BRIDGE_TOKEN copied to the clipboard.' -ForegroundColor Green
  return
}

if (-not (Test-Admin)) {
  $forceArg = if ($Force) { ' -Force' } else { '' }
  Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -NoExit -File `"$PSCommandPath`"$forceArg"
  return
}
if (-not (Test-Path $EnvFile)) { throw "$EnvFile not found. Run server\setup.cmd first." }

$port = [int]((Read-EnvFile).PORT)
if (-not $port) { $port = 8080 }
$calls = Get-LiveCalls $port
if ($calls -and -not $Force) {
  Write-Host "$calls call(s) in progress; restarting would cut them. Run again when they've ended, or add -Force." -ForegroundColor Yellow
  return
}

# 1. New tokens in .env
$bridgeToken = New-Token
Set-EnvValue 'BRIDGE_TOKEN' $bridgeToken
Set-EnvValue 'OPERATOR_TOKEN' (New-Token)
Write-Host "New BRIDGE_TOKEN and OPERATOR_TOKEN written to $EnvFile."

# 2. The private extension package
$root = (Resolve-Path (Join-Path $ServerDir '..')).Path
$config = Join-Path $root 'teams-auto-answer\bridge-config.json'
if (Test-Path $config) {
  $cfg = Get-Content $config -Raw | ConvertFrom-Json
  $cfg.token = $bridgeToken
  $cfg | ConvertTo-Json | Set-Content -Encoding ascii $config
  & (Join-Path $root 'tools\package-extension.ps1')
} else {
  Write-Host 'No teams-auto-answer\bridge-config.json, so no private extension package to update.'
}

# 3. Restart the server and the TURN relay. run-server.cmd starts server.js again by itself 3 s after it
#    exits; the TURN task runs node directly, so it's ended and started again.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*--env-file=.env server.js*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host "Restarting the server (node $($_.ProcessId))." }
if (Get-ScheduledTask -TaskName 'CallBridge TURN' -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName 'CallBridge TURN'
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*--env-file=.env turn-server.js*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Start-ScheduledTask -TaskName 'CallBridge TURN'
  Write-Host 'Restarted the TURN relay.'
}

$ok = $false
for ($i = 0; $i -lt 15 -and -not $ok; $i++) {
  Start-Sleep -Seconds 2
  try { $ok = [bool](Invoke-RestMethod "http://127.0.0.1:$port/healthz" -TimeoutSec 3 -UseBasicParsing).ok } catch {}
}
if ($ok) { Write-Host 'Server is running with the new tokens.' -ForegroundColor Green }
else { Write-Host 'Server is not answering yet. See server\logs\server.log.' -ForegroundColor Yellow }

# 4. What's left to do by hand
(Read-EnvFile).OPERATOR_TOKEN | Set-Clipboard
Write-Host ''
Write-Host 'The new OPERATOR_TOKEN is on the clipboard.' -ForegroundColor Green
Write-Host ' - Local app: sign in again and paste it as the Operator token.'
Write-Host ' - Each Teams computer: load dist\private\teams-call-answerer-extension-with-token.zip and click'
Write-Host '   Reload in chrome://extensions, or paste the new BRIDGE_TOKEN in the side panel''s Access token.'
Write-Host '   To copy it:  powershell -ExecutionPolicy Bypass -File server\deploy\windows\rotate-tokens.ps1 -CopyBridgeToken'
