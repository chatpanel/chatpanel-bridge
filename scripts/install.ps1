# ChatPanel Bridge installer (Windows) - no Node.js required.
#
#   irm https://raw.githubusercontent.com/chatpanel/chatpanel-bridge/main/scripts/install.ps1 | iex
#
# Downloading via Invoke-WebRequest + Unblock-File removes the "mark of the web",
# so Windows SmartScreen won't warn the way a browser download would.
$ErrorActionPreference = 'Stop'

$url   = 'https://dl.chatpanel.net/bridge/windows-x64.exe'
$dir   = Join-Path $env:LOCALAPPDATA 'ChatPanel'
$bin   = Join-Path $dir 'chatpanel-bridge.exe'

# Stop any running bridge so the upgrade is clean (no duplicate installs).
Get-Process -Name 'chatpanel-bridge' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 300

New-Item -ItemType Directory -Force -Path $dir | Out-Null

Write-Host "Downloading ChatPanel Bridge ..."
Invoke-WebRequest -Uri $url -OutFile $bin -UseBasicParsing
Unblock-File -Path $bin -ErrorAction SilentlyContinue

Write-Host "Installed to $bin"
& $bin --install
Write-Host ""
Write-Host "ChatPanel Bridge is running and will start at login."
Write-Host "Manage it:  `"$bin`" --status   |   --uninstall"
