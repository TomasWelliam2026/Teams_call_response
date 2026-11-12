<#
  Runs the call bridge server on this Windows VPS, always on, behind HTTPS.

  What it does (run it in an elevated PowerShell, from any folder):
    1. Creates server\.env with two new random secrets (only if .env doesn't exist yet).
    2. Opens TCP 80 and 443 (Caddy's HTTPS and certificate) and UDP 3478 plus 49152-49452
       (the camera-control TURN relay) in Windows Firewall.
    3. Registers three startup tasks that run as SYSTEM and restart if they stop:
         "CallBridge Server"  node server.js on 127.0.0.1:8080 (not reachable from outside)
         "CallBridge HTTPS"   Caddy: https://<domain> -> 127.0.0.1:8080, free Let's Encrypt certificate
         "CallBridge TURN"    node turn-server.js, the camera-control relay (see README.md)
    4. Starts all three and checks https://<domain>/healthz.

  The domain defaults to <your-public-ip>.sslip.io (e.g. 95-216-122-142.sslip.io), which resolves to
  this server without buying a domain. Pass -Domain bridge.example.com to use your own; point its DNS
  A record at this server first.

  Undo everything with uninstall.ps1.
#>
param(
  [string]$Domain = '',
  [int]$Port = 8080
)
$ErrorActionPreference = 'Stop'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this in PowerShell opened with "Run as administrator".'
}

$ServerDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Node = (Get-Command node -ErrorAction Stop).Source
$Caddy = Join-Path $ServerDir 'bin\caddy.exe'
$Logs = Join-Path $ServerDir 'logs'
$EnvFile = Join-Path $ServerDir '.env'
if (-not (Test-Path $Caddy)) { throw "Caddy not found at $Caddy. Download caddy.exe (Windows amd64) from https://github.com/caddyserver/caddy/releases into server\bin." }
if (-not (Test-Path (Join-Path $ServerDir 'node_modules\ws')) -or -not (Test-Path (Join-Path $ServerDir 'node_modules\node-turn'))) {
  Push-Location $ServerDir; npm ci --omit=dev; Pop-Location
}
New-Item -ItemType Directory -Force $Logs | Out-Null

if (-not $Domain) {
  $ip = Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notmatch '^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)' } |
    Select-Object -First 1 -ExpandProperty IPAddress
  if (-not $ip) { throw 'No public IPv4 address found on this machine. Pass -Domain <your domain>.' }
  $Domain = ($ip -replace '\.', '-') + '.sslip.io'
}

# 1. Secrets. Two different tokens: one for the extension, one for the operator console.
if (-not (Test-Path $EnvFile)) {
  $newToken = {
    $bytes = New-Object byte[] 24
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
  }
  @(
    '# Call bridge server settings. Keep this file private.',
    "# Extension side panel -> Server URL: wss://$Domain/call   Access token: BRIDGE_TOKEN",
    "# Operator console: https://$Domain/   Operator token: OPERATOR_TOKEN",
    "BRIDGE_TOKEN=$(& $newToken)",
    "OPERATOR_TOKEN=$(& $newToken)",
    'HOST=127.0.0.1',
    "PORT=$Port",
    'FALLBACK=silence'
  ) | Set-Content -Encoding ascii $EnvFile
  # Only Administrators and SYSTEM may read it.
  icacls $EnvFile /inheritance:r /grant:r 'Administrators:F' 'SYSTEM:F' | Out-Null
  Write-Host "Created $EnvFile with new tokens."
} else {
  Write-Host "Keeping existing $EnvFile."
}

# 2. Firewall
if (-not (Get-NetFirewallRule -DisplayName 'CallBridge HTTPS' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName 'CallBridge HTTPS' -Direction Inbound -Protocol TCP -LocalPort 80, 443 -Action Allow | Out-Null
  Write-Host 'Opened TCP 80 and 443 in Windows Firewall.'
}
if (-not (Get-NetFirewallRule -DisplayName 'CallBridge TURN' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName 'CallBridge TURN' -Direction Inbound -Protocol UDP -LocalPort 3478, 49152-49452 -Action Allow | Out-Null
  Write-Host 'Opened UDP 3478 and 49152-49452 in Windows Firewall (camera-control TURN relay).'
}

# 3. Startup tasks (SYSTEM, restart on failure, no time limit)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
$trigger = New-ScheduledTaskTrigger -AtStartup
$system = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

# run-server.cmd starts node again if it ever exits (the task's own restart only covers failed starts).
$serverCmd = "set `"NODE=$Node`"&& deploy\windows\run-server.cmd"
$caddyCmd = "set XDG_DATA_HOME=$ServerDir\bin\caddy-data&& bin\caddy.exe reverse-proxy --from $Domain --to 127.0.0.1:$Port >> logs\caddy.log 2>&1"
$turnCmd = "`"$Node`" --env-file=.env turn-server.js >> logs\turn.log 2>&1"
$tasks = @{
  'CallBridge Server' = $serverCmd
  'CallBridge HTTPS'  = $caddyCmd
  'CallBridge TURN'   = $turnCmd
}
foreach ($name in $tasks.Keys) {
  $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c $($tasks[$name])" -WorkingDirectory $ServerDir
  Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $system -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName $name
  Write-Host "Started task '$name'."
}

# 4. Check
Write-Host "Waiting for the HTTPS certificate for $Domain (up to 90 s)..."
$ok = $false
for ($i = 0; $i -lt 30 -and -not $ok; $i++) {
  Start-Sleep -Seconds 3
  try { $ok = (Invoke-RestMethod "https://$Domain/healthz" -TimeoutSec 5).ok } catch { }
}
if ($ok) {
  Write-Host ''
  Write-Host "Ready: https://$Domain/" -ForegroundColor Green
  Write-Host "  Extension side panel  -> Server URL: wss://$Domain/call   Access token: BRIDGE_TOKEN from $EnvFile"
  Write-Host "  Operator console      -> https://$Domain/   Operator token: OPERATOR_TOKEN from $EnvFile"
  Write-Host "  Camera control's TURN relay is on UDP 3478 (same domain); the server hands out its address automatically."
} else {
  Write-Host "Not reachable yet over HTTPS. Check $Logs\caddy.log." -ForegroundColor Yellow
  Write-Host 'If your VPS provider has its own firewall (e.g. Hetzner Cloud Firewall), allow inbound TCP 80 and 443 there too.'
}
