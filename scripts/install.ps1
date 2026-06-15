# ChatPanel Bridge installer (Windows) - no Node.js required.
#
#   irm https://dl.chatpanel.net/bridge/install.ps1 | iex
#
# Note: no `$ErrorActionPreference = 'Stop'` here, because native tools (schtasks,
# curl) write progress/notices to stderr and that would be treated as fatal. We
# check exit codes explicitly instead.
$ProgressPreference = 'SilentlyContinue'

$url = 'https://dl.chatpanel.net/bridge/windows-x64.exe'
$dir = Join-Path $env:LOCALAPPDATA 'ChatPanel'
$bin = Join-Path $dir 'chatpanel-bridge.exe'
$tmp = "$bin.new"

Write-Host ""
Write-Host "Installing ChatPanel Bridge" -ForegroundColor Cyan

# Stop any running bridge + its scheduled task for a clean in-place upgrade.
# Run schtasks inside cmd so its "not found" stderr never reaches PowerShell.
cmd /c "schtasks /End /TN ChatPanelBridge >nul 2>&1"
Get-Process -Name 'chatpanel-bridge' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 600

New-Item -ItemType Directory -Force -Path $dir | Out-Null

Write-Host "  Downloading the bridge (~60 MB)..." -ForegroundColor Gray
$ok = $false
if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
  & curl.exe -fL --progress-bar -o "$tmp" "$url"      # fast, real progress bar
  $ok = ($LASTEXITCODE -eq 0)
} else {
  try { Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing; $ok = $true } catch { $ok = $false }
}
if (-not $ok -or -not (Test-Path "$tmp")) {
  Write-Host "Download failed - check your connection and re-run." -ForegroundColor Red
  return
}

Unblock-File -Path "$tmp" -ErrorAction SilentlyContinue   # no SmartScreen mark-of-the-web
Move-Item -Force "$tmp" "$bin"

Write-Host "  Setting it to start at login..." -ForegroundColor Gray
& "$bin" --install

Write-Host ""
Write-Host "Done. ChatPanel Bridge is running and starts at login." -ForegroundColor Green
Write-Host "Open the ChatPanel side panel - your agents appear automatically."
Write-Host "Manage it:  `"$bin`" --status  |  --uninstall"
