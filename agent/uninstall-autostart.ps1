# ─────────────────────────────────────────────────────────────
# uninstall-autostart.ps1 — stop the background agent and remove its
# auto-start. Right-click > "Run with PowerShell". No admin needed.
# ─────────────────────────────────────────────────────────────
$ErrorActionPreference = 'SilentlyContinue'

# Remove the Startup launcher so it no longer starts at logon.
$startup = [Environment]::GetFolderPath('Startup')
Remove-Item (Join-Path $startup 'TallyCloudSyncAgent.vbs') -Force

# Remove the old scheduled task too, if a previous version created one.
schtasks /delete /tn "TallyCloudSyncAgent" /f 2>$null | Out-Null

# Stop any running instance.
Get-Process TallyCloudSyncAgent -ErrorAction SilentlyContinue | Stop-Process -Force

Write-Host ""
Write-Host "  [OK] Stopped the agent and removed its auto-start." -ForegroundColor Green
Write-Host "       It will no longer start when you log in."
Write-Host ""
Read-Host "Press Enter to close"
