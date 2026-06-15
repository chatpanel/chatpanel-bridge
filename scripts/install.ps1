# ChatPanel Bridge installer (Windows) - no Node.js required.
#
#   irm https://dl.chatpanel.net/bridge/install.ps1 | iex
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # IWR fallback: skip the slow progress bar

$url = 'https://dl.chatpanel.net/bridge/windows-x64.exe'
$dir = Join-Path $env:LOCALAPPDATA 'ChatPanel'
$bin = Join-Path $dir 'chatpanel-bridge.exe'
$tmp = "$bin.new"

Write-Host ""
Write-Host "Installing ChatPanel Bridge" -ForegroundColor Cyan

# Stop any running bridge + its scheduled task so the .exe isn't locked (clean
# in-place upgrade, no duplicate installs).
schtasks /End /TN ChatPanelBridge *> $null
Get-Process -Name 'chatpanel-bridge' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 600

New-Item -ItemType Directory -Force -Path $dir | Out-Null

Write-Host "  Downloading the bridge (~60 MB)..." -ForegroundColor Gray
$curl = Get-Command curl.exe -ErrorAction SilentlyContinue
if ($curl) {
  & curl.exe -fL --progress-bar -o $tmp $url      # fast, with a real progress bar
} else {
  Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
}
Unblock-File -Path $tmp -ErrorAction SilentlyContinue   # no SmartScreen mark-of-the-web
Move-Item -Force $tmp $bin

Write-Host "  Setting it to start at login..." -ForegroundColor Gray
& $bin --install

Write-Host ""
Write-Host "Done. ChatPanel Bridge is running and starts at login." -ForegroundColor Green
Write-Host "Open the ChatPanel side panel - your agents appear automatically."
Write-Host "Manage it:  `"$bin`" --status  |  --uninstall"
