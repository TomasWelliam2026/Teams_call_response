<#
  Builds the extension packages in dist\:
    dist\teams-call-answerer-extension.zip
        Safe to share or commit: no bridge-config.json, so no token. After loading it, enter the
        Server URL and Access token in the extension's side panel.
    dist\private\teams-call-answerer-extension-with-token.zip
        Includes teams-auto-answer\bridge-config.json (server URL + BRIDGE_TOKEN), so it connects
        without typing. Git-ignored. Keep it private: anyone with it can link to your server.
  Run from anywhere:  powershell -ExecutionPolicy Bypass -File tools\package-extension.ps1
#>
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$src = Join-Path $root 'teams-auto-answer'
$dist = Join-Path $root 'dist'
$private = Join-Path $dist 'private'
New-Item -ItemType Directory -Force $dist, $private | Out-Null

function Build-Zip([string]$zipPath, [bool]$withConfig) {
  $stage = Join-Path $env:TEMP "tca-pack-$([guid]::NewGuid().ToString('N'))"
  $dest = Join-Path $stage 'teams-auto-answer'
  Copy-Item $src $dest -Recurse
  Remove-Item (Join-Path $dest 'test') -Recurse -Force
  Remove-Item (Join-Path $dest '.gitignore') -Force -ErrorAction SilentlyContinue
  if (-not $withConfig) { Remove-Item (Join-Path $dest 'bridge-config.json') -Force -ErrorAction SilentlyContinue }
  if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
  Compress-Archive -Path $dest -DestinationPath $zipPath
  Remove-Item $stage -Recurse -Force
}

$version = (Get-Content (Join-Path $src 'manifest.json') -Raw | ConvertFrom-Json).version
$public = Join-Path $dist 'teams-call-answerer-extension.zip'
Build-Zip $public $false
Write-Host "Built $public (version $version, no token)"

if (Test-Path (Join-Path $src 'bridge-config.json')) {
  $withToken = Join-Path $private 'teams-call-answerer-extension-with-token.zip'
  Build-Zip $withToken $true
  Write-Host "Built $withToken (version $version, includes bridge-config.json - keep private)"
} else {
  Write-Host 'No teams-auto-answer\bridge-config.json, so no private package was built.'
}
