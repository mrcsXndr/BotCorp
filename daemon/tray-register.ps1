# tray-register.ps1 - auto-start a bot's tray icon (daemon/tray.ps1) at login.
#
#   tray-register.ps1 -Bot <name> [-AttachAtLogin]   # HKCU Run\BotCorp-Tray-<bot> -> wscript <rt>/tray-<bot>.vbs (hidden pwsh)
#   tray-register.ps1 -Bot <name> -Remove            # both Run values + the shims
#   tray-register.ps1 -Bot <name> -Status            # prints registered|absent, exit 0/2
#   -DryRun on any: print, change nothing
#
# HKCU Run (not a scheduled task): the tray is a per-user desktop thing that
# should appear with the desktop, and HKCU needs no elevation. The VBS shim
# is the same trick as the daemon's (no console flash): wscript starts pwsh
# hidden before any window exists. `botcorp tray <bot> on|off|status` calls
# this; `botcorp doctor` reads the same Run value.
# -AttachAtLogin adds a second value, BotCorp-Attach-<bot>, that opens the
# attach tab at login once the session is up (attach.ps1 -WaitSec 180): the
# reference host does the same with its own two Run entries.

param(
    [Parameter(Mandatory)][string]$Bot,
    [switch]$Remove,
    [switch]$Status,
    [switch]$AttachAtLogin,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')

if ($Bot -notmatch '^[a-z0-9][a-z0-9-]{0,31}$') { Write-Error "tray-register: bad bot name '$Bot'"; exit 1 }
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$valueName = "BotCorp-Tray-$Bot"
$attachValueName = "BotCorp-Attach-$Bot"
$vbsPath = Join-Path $RtHome "tray-$Bot.vbs"
$attachVbsPath = Join-Path $RtHome "attach-$Bot.vbs"
$trayScript = Join-Path $PSScriptRoot 'tray.ps1'
$attachScript = Join-Path $PSScriptRoot 'attach.ps1'

function Get-RunValue { param([string]$Name) try { return (Get-ItemProperty -Path $runKey -Name $Name -ErrorAction Stop).$Name } catch { return $null } }

if ($Status) {
    $v = Get-RunValue $valueName
    $av = Get-RunValue $attachValueName
    if ($v) { Write-Output "tray $Bot`: registered ($v)$(if ($av) { "; attach at login: registered" })"; exit 0 } else { Write-Output "tray $Bot`: absent"; exit 2 }
}
if ($Remove) {
    if ($DryRun) { Write-Output "tray dry-run: would remove $runKey\$valueName, $runKey\$attachValueName, $vbsPath and $attachVbsPath"; exit 0 }
    foreach ($n in @($valueName, $attachValueName)) {
        try { Remove-ItemProperty -Path $runKey -Name $n -ErrorAction Stop; Write-Output "tray: removed $n from HKCU Run" } catch {}
    }
    foreach ($f in @($vbsPath, $attachVbsPath)) { try { if (Test-Path $f) { Remove-Item -Force $f } } catch {} }
    exit 0
}

$tpl = Join-Path $PSScriptRoot 'hidden-launcher.vbs.template'
if (-not (Test-Path $tpl)) { Write-Error "tray-register: template missing: $tpl"; exit 1 }
if (-not (Test-Path $trayScript)) { Write-Error "tray-register: daemon/tray.ps1 missing"; exit 1 }
function New-Shim { param([string]$Script, [string]$ScriptArgs)
    return (Get-Content $tpl -Raw).Replace('{{TICK_SCRIPT}}', $Script).Replace('{{SCRIPT_ARGS}}', $ScriptArgs).Replace('{{BOTCORP_HOME}}', $RtHome).Replace('{{LOCALAPPDATA_PWSH}}', (Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\pwsh.exe'))
}
$cmd = "wscript.exe `"$vbsPath`" //B //Nologo"
$attachCmd = "wscript.exe `"$attachVbsPath`" //B //Nologo"
if ($DryRun) {
    Write-Output "tray dry-run: would write $vbsPath and set $runKey\$valueName = $cmd"
    if ($AttachAtLogin) { Write-Output "tray dry-run: would write $attachVbsPath and set $runKey\$attachValueName = $attachCmd (attach.ps1 -WaitSec 180)" }
    exit 0
}
if (-not (Test-Path $RtHome)) { New-Item -ItemType Directory -Force -Path $RtHome | Out-Null }
Set-Content -Path $vbsPath -Value (New-Shim -Script $trayScript -ScriptArgs " -Bot $Bot") -Encoding ASCII
if (-not (Test-Path $runKey)) { New-Item -Path $runKey -Force | Out-Null }
Set-ItemProperty -Path $runKey -Name $valueName -Value $cmd
Write-Output "tray: $valueName registered in HKCU Run -> $cmd (starts at the next login; start it now with: pwsh -File daemon/tray.ps1 -Bot $Bot)"
if ($AttachAtLogin) {
    Set-Content -Path $attachVbsPath -Value (New-Shim -Script $attachScript -ScriptArgs " -Bot $Bot -WaitSec 180") -Encoding ASCII
    Set-ItemProperty -Path $runKey -Name $attachValueName -Value $attachCmd
    Write-Output "tray: $attachValueName registered in HKCU Run -> $attachCmd (opens the attach tab at login once the session is up)"
}
exit 0
