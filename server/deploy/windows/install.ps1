<#
  Sets up the call bridge server on this Windows VPS, always on, behind HTTPS. Also updates an existing
  setup: run it again after copying in a newer version, or after the VPS's IP changed.
  Easiest: double-click server\setup.cmd (it asks for administrator rights).

  What it does:
    1. Gets what it needs, if missing: Node.js (a private copy in server\bin\node unless Node 20.6+ is
       installed), Caddy (server\bin\caddy.exe) and the server's npm packages. Downloads are checksum-verified.
    2. Creates server\.env with two new random tokens, unless it exists. To move a server to this VPS and
       keep its tokens (so the extension and the app keep working), copy the old server\.env here first.
    3. Writes server\Caddyfile: HTTPS with free Let's Encrypt certificates for this VPS's IP, as
       <ip>.sslip.io, <ip>.nip.io and the bare IP, plus your own domain if you pass -Domain.
    4. Opens TCP 80 and 443 and UDP 3478 plus 49152-49452 (camera-control TURN relay) in Windows Firewall.
    5. Registers three startup tasks that run as SYSTEM and restart if they stop:
         "CallBridge Server"  node server.js on 127.0.0.1:<port> (not reachable from outside)
         "CallBridge HTTPS"   Caddy, the HTTPS front for all the names above
         "CallBridge TURN"    node turn-server.js, the camera-control relay
    6. Starts them and checks the server answers over HTTPS.

  Options:
    -Domain bridge.example.com  Also answer on your own domain (point its DNS A record at this VPS first).
                                Remembered in .env; pass -Domain none to drop it.
    -PublicIp 1.2.3.4           Use this IP instead of the one detected.
    -Port 8080                  Local port of server.js.
    -Force                      Don't ask before restarting a server that has live calls.

  Undo everything with uninstall.ps1.
#>
param(
  [string]$Domain = '',
  [string]$PublicIp = '',
  [int]$Port = 0,
  [switch]$Force
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\common.ps1"

if (-not (Test-Admin)) {
  $passOn = ($PSBoundParameters.GetEnumerator() | ForEach-Object {
    if ($_.Value -is [switch]) { "-$($_.Key)" } else { "-$($_.Key) `"$($_.Value)`"" }
  }) -join ' '
  Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -NoExit -File `"$PSCommandPath`" $passOn"
  return
}

Write-Host ''
Write-Host ' Call Bridge server setup' -ForegroundColor Cyan
Write-Host " Folder: $ServerDir"
Write-Host ''

# Files copied from a downloaded zip carry "from the internet" marks that can block scripts.
Get-ChildItem $ServerDir -Recurse -File -Include *.ps1, *.cmd, *.bat, *.js, *.exe -ErrorAction SilentlyContinue |
  Where-Object FullName -notlike '*\node_modules\*' | Unblock-File -ErrorAction SilentlyContinue
$Logs = Join-Path $ServerDir 'logs'
New-Item -ItemType Directory -Force $Logs | Out-Null

# 1. Software
$Node = Get-Node
$Caddy = Get-Caddy
if (-not (Test-Path (Join-Path $ServerDir 'node_modules\ws')) -or -not (Test-Path (Join-Path $ServerDir 'node_modules\node-turn'))) {
  Write-Host 'Installing npm packages...'
  $npm = Join-Path (Split-Path $Node) 'npm.cmd'
  Push-Location $ServerDir
  try { & $npm ci --omit=dev --no-audit --no-fund; if ($LASTEXITCODE) { throw 'npm ci failed.' } } finally { Pop-Location }
}
Write-Host "Node $(& $Node --version), Caddy $((& $Caddy version) -replace ' .*', '')."

# 2. Settings and tokens
$env0 = Read-EnvFile
if (-not (Test-Path $EnvFile)) {
  @(
    '# Call bridge server settings. Keep this file private: it holds the two tokens.',
    '# To move the server to another VPS and keep the tokens, copy this file there before running setup.',
    "BRIDGE_TOKEN=$(New-Token)",
    "OPERATOR_TOKEN=$(New-Token)",
    'FALLBACK=silence'
  ) | Set-Content -Encoding ascii $EnvFile
  Write-Host 'Created .env with new tokens.'
} else {
  if (-not $env0.BRIDGE_TOKEN -or $env0.BRIDGE_TOKEN.Length -lt 16) { throw "$EnvFile has no BRIDGE_TOKEN (16+ characters). Fix it or delete the file to get new tokens." }
  Write-Host 'Keeping the tokens in the existing .env.'
}
if (-not $Port) { $Port = if ($env0.PORT) { [int]$env0.PORT } else { 8080 } }
if (-not $PublicIp) { $PublicIp = Get-PublicIp }
if (-not (Test-PublicIPv4 $PublicIp)) { throw "Couldn't find this VPS's public IPv4 address. Pass -PublicIp <address>." }
if ($Domain -eq 'none') { $Domain = '' } elseif (-not $Domain) { $Domain = "$($env0.DOMAIN)" }
$Domain = $Domain.Trim().ToLower() -replace '^https?://', '' -replace '/.*$', ''
if ($env0.PUBLIC_IP -and $env0.PUBLIC_IP -ne $PublicIp) { Write-Host "The public IP changed: $($env0.PUBLIC_IP) -> $PublicIp." -ForegroundColor Yellow }
Set-EnvValue 'HOST' '127.0.0.1'
Set-EnvValue 'PORT' $Port
Set-EnvValue 'PUBLIC_IP' $PublicIp
Set-EnvValue 'DOMAIN' $Domain
# Only Administrators and SYSTEM may read it (by SID: the group names differ by Windows language).
icacls $EnvFile /inheritance:r /grant:r '*S-1-5-32-544:F' '*S-1-5-18:F' | Out-Null

# 3. HTTPS
Write-Caddyfile $PublicIp $Domain $Port
# Caddy logs to stderr, which Windows PowerShell would turn into errors under 'Stop'.
$ErrorActionPreference = 'Continue'
$check = & $Caddy validate --config $CaddyFile --adapter caddyfile 2>&1
$ErrorActionPreference = 'Stop'
if ($LASTEXITCODE) { $check | Select-Object -Last 3 | ForEach-Object { Write-Host "$_" }; throw "Caddy rejected $CaddyFile. Check -Domain." }

# 4. Firewall
if (-not (Get-NetFirewallRule -DisplayName 'CallBridge HTTPS' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName 'CallBridge HTTPS' -Direction Inbound -Protocol TCP -LocalPort 80, 443 -Action Allow | Out-Null
  Write-Host 'Opened TCP 80 and 443 in Windows Firewall.'
}
if (-not (Get-NetFirewallRule -DisplayName 'CallBridge TURN' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName 'CallBridge TURN' -Direction Inbound -Protocol UDP -LocalPort 3478, 49152-49452 -Action Allow | Out-Null
  Write-Host 'Opened UDP 3478 and 49152-49452 in Windows Firewall (camera-control TURN relay).'
}
$busy = Get-NetTCPConnection -State Listen -LocalPort 80, 443 -ErrorAction SilentlyContinue |
  Where-Object { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).Path -ne $Caddy }
if ($busy) {
  $names = ($busy | ForEach-Object { (Get-Process -Id $_.OwningProcess).ProcessName } | Sort-Object -Unique) -join ', '
  Write-Host "Warning: port 80 or 443 is already used by $names (e.g. IIS). Caddy needs both; stop that first." -ForegroundColor Yellow
}

# 5. Startup tasks (SYSTEM, restart on failure, no time limit)
$live = Get-LiveCalls $Port
if ($live -gt 0 -and -not $Force) {
  $answer = Read-Host "$live call(s) are live. Restarting the server now cuts them. Restart anyway? (y/N)"
  if ($answer -notmatch '^[yY]') { Write-Host 'Stopped without restarting. Settings are saved; run setup again after the calls.'; return }
}
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
$trigger = New-ScheduledTaskTrigger -AtStartup
$system = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

# run-server.cmd starts node again if it ever exits (the task's own restart only covers failed starts).
$tasks = [ordered]@{
  'CallBridge Server' = "set `"NODE=$Node`"&& deploy\windows\run-server.cmd"
  'CallBridge HTTPS'  = "set `"XDG_DATA_HOME=$ServerDir\bin\caddy-data`"&& bin\caddy.exe run --config Caddyfile --adapter caddyfile >> logs\caddy.log 2>&1"
  'CallBridge TURN'   = "`"$Node`" --env-file=.env turn-server.js >> logs\turn.log 2>&1"
}
foreach ($name in $tasks.Keys) { Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue }
Stop-BridgeProcesses
foreach ($name in $tasks.Keys) {
  $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c $($tasks[$name])" -WorkingDirectory $ServerDir
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $system -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName $name
  Write-Host "Started task '$name'."
}

# 6. Check
$addresses = Get-SiteNames $PublicIp $Domain
Write-Host 'Waiting for the HTTPS certificates (up to 2 minutes)...'
$ok = @{}
for ($i = 0; $i -lt 40 -and $ok.Count -lt $addresses.Count; $i++) {
  Start-Sleep -Seconds 3
  foreach ($a in $addresses | Where-Object { -not $ok[$_] }) {
    try { if ((Invoke-RestMethod "https://$a/healthz" -TimeoutSec 5 -UseBasicParsing).ok) { $ok[$a] = $true } } catch { }
  }
}
Write-Host ''
if ($ok.Count) {
  Write-Host 'Ready.' -ForegroundColor Green
} else {
  Write-Host "Not reachable over HTTPS yet. See $Logs\caddy.log." -ForegroundColor Yellow
  Write-Host 'If your VPS provider has its own firewall (e.g. Hetzner Cloud Firewall, AWS security group),'
  Write-Host 'allow inbound TCP 80 and 443, and UDP 3478 and 49152-49452, there too.'
}
Write-Host ''
Write-Host ' Use any one of these addresses (all reach this server; pick one your networks allow):'
foreach ($a in $addresses) {
  $mark = if ($ok[$a]) { 'ok     ' } else { 'not yet' }
  Write-Host "   [$mark]  Extension Server URL: wss://$a/call     App: https://$a/"
}
Write-Host ''
Write-Host " Tokens are in ${EnvFile}:"
Write-Host '   Extension side panel -> Access token  = BRIDGE_TOKEN'
Write-Host '   Call Bridge app      -> Operator token = OPERATOR_TOKEN'
Write-Host ''
Write-Host ' server\monitor.bat shows the server and its log; server\start.bat starts it if it was stopped.'
