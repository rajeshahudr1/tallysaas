# ─────────────────────────────────────────────────────────────
# install-autostart.ps1 — make the Tally Cloud Sync agent start
# AUTOMATICALLY (hidden, in the background) at every Windows logon.
# No admin rights needed.
#
# Run this ONCE, AFTER you have started the agent once and entered your
# license key (so it is activated). Right-click this file >
# "Run with PowerShell".
#
# It drops a tiny launcher in your Startup folder that runs the agent exe
# with NO console window. Closing any window will NOT stop it; it keeps
# running until you log off / shut down, and auto-starts again next logon.
# To stop + remove it: run uninstall-autostart.ps1
# ─────────────────────────────────────────────────────────────
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe  = Join-Path $here 'TallyCloudSyncAgent.exe'

if (-not (Test-Path $exe)) {
    Write-Host "ERROR: TallyCloudSyncAgent.exe not found next to this script ($here)." -ForegroundColor Red
    Read-Host "Press Enter to exit"; exit 1
}

$startup = [Environment]::GetFolderPath('Startup')
$vbsPath = Join-Path $startup 'TallyCloudSyncAgent.vbs'

# Launcher with the ABSOLUTE exe path (so it works from the Startup folder).
$vbs = @(
    'Set sh = CreateObject("WScript.Shell")'
    'sh.CurrentDirectory = "' + $here + '"'
    'sh.Run """' + $exe + '""", 0, False'   # 0 = hidden, False = don''t wait
) -join "`r`n"
Set-Content -Path $vbsPath -Value $vbs -Encoding ASCII

# Start it now too, so you don't have to log off/on.
Get-Process TallyCloudSyncAgent -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Process wscript.exe -ArgumentList ('"{0}"' -f $vbsPath)

Write-Host ""
Write-Host "  [OK] Auto-start installed + agent launched (hidden)." -ForegroundColor Green
Write-Host "       It runs in the BACKGROUND with no window and starts again at every logon."
Write-Host "       Launcher: $vbsPath"
Write-Host ""
Write-Host "  To STOP / remove:  run  uninstall-autostart.ps1"
Write-Host ""
Read-Host "Press Enter to close"
