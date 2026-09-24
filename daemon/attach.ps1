# attach.ps1 - pull a running background bot up on the desktop: a Windows
# Terminal tab running `claude attach <bg id>` under the bot's config home.
# The session keeps running when the tab closes. `botcorp attach`, the tray's
# double-click and launch-visible.ps1 (bg branch) all end here.
#
#   attach.ps1 -Bot <name> [-Elevate] [-WaitSec <n>] [-DryRun]
#   attach.ps1 -Bot <name> -InTab            # INSIDE the tab: env, then claude attach
#
# -WaitSec: poll state/<bot>.json for a bg id for up to n seconds before giving
# up (the reference host's at-login attach waits 3 min for the daemon to bring
# the session up; the tray and the CLI pass nothing and return at once).
#
# Elevation: the bg supervisor pipe answers only callers with the daemon's
# token, so when install.json says run_level Highest (or -Elevate is passed)
# wt.exe is started with -Verb RunAs (UAC may prompt; silent on a box with
# the prompt disabled). An elevated wt.exe cannot join a non-elevated window,
# so it opens its own. Fail-open: exit 0 with a message when there is nothing
# to attach (the daemon tick starts bg bots, this script never does).

param(
    [Parameter(Mandatory)][string]$Bot,
    [switch]$Elevate,
    [switch]$InTab,
    [int]$WaitSec = 0,
    [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot '_common.ps1')

if ($Bot -notmatch '^[a-z0-9][a-z0-9-]{0,31}$') { Write-Output "attach: bad bot name '$Bot'"; exit 0 }
$P = Get-BotPaths -Bot $Bot
function Get-BgId {
    $st = Read-BotState -Bot $Bot
    try { if ($st -and ($st.PSObject.Properties.Name -contains 'bg_id')) { return "$($st.bg_id)" } } catch {}
    return ''
}
$bgId = Get-BgId
$deadline = (Get-Date).AddSeconds($WaitSec)
while (-not $bgId -and -not $InTab -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 5; $bgId = Get-BgId }
if (-not $bgId) { Write-Output "attach: $Bot has no bg id recorded (not running as a background session$(if ($WaitSec) { " after ${WaitSec}s" })); the daemon tick starts it"; Write-DaemonLog "attach: no bg id" -Bot $Bot -Quiet; exit 0 }
$exe = Resolve-ClaudeExe

if ($InTab) {
    foreach ($k in 'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT') { [Environment]::SetEnvironmentVariable($k, $null, 'Process') }
    $env:CLAUDE_CONFIG_DIR = $P.ConfigDir
    $host.UI.RawUI.WindowTitle = "$Bot (attached)"
    Set-Location $P.BotHome
    & $exe attach $bgId
    exit $LASTEXITCODE
}

$elevated = [bool]$Elevate
try { $inst = Read-JsonFile -Path (Join-Path $StateDir 'install.json'); if ($inst -and ("$($inst.run_level)" -eq 'Highest')) { $elevated = $true } } catch {}
$pwsh = Resolve-PwshExe
$tabArgs = @('-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-Bot', $Bot, '-InTab')
$wtCmd = Get-Command wt.exe -ErrorAction SilentlyContinue
$wtAlias = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\wt.exe'
$wt = if ($wtCmd) { $wtCmd.Source } elseif (Test-Path $wtAlias) { $wtAlias } else { $null }
$q = { param($s) if ($s -match '[\s"]') { '"' + ($s -replace '"', '\"') + '"' } else { $s } }
if ($wt) {
    $args2 = @('-w', '0', 'new-tab', '--title', (& $q $Bot), '-d', (& $q $P.BotHome), (& $q $pwsh)) + @($tabArgs | ForEach-Object { & $q $_ })
    $file = $wt
} else {
    $args2 = $tabArgs
    $file = $pwsh
}
if ($DryRun) { Write-Output "attach dry-run: $file $($args2 -join ' ')$(if ($elevated) { '  (elevated)' })  -> claude attach $bgId"; exit 0 }
try {
    $sp = @{ FilePath = $file; ArgumentList = $args2; WorkingDirectory = $P.BotHome }
    if ($elevated) { $sp['Verb'] = 'RunAs' }
    Start-Process @sp | Out-Null
    Write-DaemonLog "attach: $(if ($wt) { 'wt tab' } else { 'pwsh window' }) -> claude attach $bgId$(if ($elevated) { ' (elevated)' })" -Bot $Bot
    Write-Output "attach: opened a tab for $Bot (claude attach $bgId$(if ($elevated) { ', elevated' }))"
} catch {
    Write-DaemonLog "attach: FAILED: $($_.Exception.Message)" -Bot $Bot
    Write-Output "attach: failed: $($_.Exception.Message)"
}
exit 0
