# restart.ps1 - wait for a bot's old claude session to exit, then relaunch it.
#
#   pwsh -NoProfile -File daemon/restart.ps1 -Bot <name> -OldPid <claude pid> [-OldShellPid <pid>] [-TimeoutSec 60] [-DryRun]
#
# The running session cannot relaunch itself in place: the relaunch resumes
# the SAME conversation (`--continue` for a pty bot, `--resume <session id>`
# for a bg bot), so a new session started while the old process is still
# alive would attach the same conversation (state races, double Telegram
# replies). Contract: the caller (tick.ps1, update_restart.py, the CLI) spawns
# THIS script detached with the live claude pid, then terminates that pid
# (`claude stop <id>` for a bg bot). This script polls until the pid is gone,
# THEN relaunches.
#
# Relaunch path by bot.yaml harness.session:
#   bg (default): `daemon/launch.ps1 -Bot <name> -Bg` (bounded) -> `claude --bg
#                 --resume <session id>` under the supervisor; -Fresh when the
#                 fresh marker is honoured (a new session id).
#   pty:          from session 0 with a logged-in desktop user -> the
#                 'BotCorp-Launch' task (visible, in that session); otherwise
#                 `node daemon/pty-host.mjs --bot <name> --botcorp <root>
#                 --continue`, detached (the cockpit attaches to it).
#
# Fresh-restart marker (<BotHome>/.claude/.botcorp_fresh_restart): a marker
# younger than 300 s can only have been dropped by a roll the bot declared
# seconds ago (the daemon's own restart path never creates one), so it is
# honoured AND re-touched so launch.ps1's 300 s window counts from the launch,
# not from the touch. A stale marker is deleted (a normal restart keeps the
# long-running context: forcing FRESH here once threw away a live session's
# work). An earlier port deleted EVERY marker before relaunching, so a
# declared roll silently came back as --continue and a model pin never took.
#
# -DryRun waits for the pid as usual, then prints `START FRESH` or
# `--continue` (pty) / `--resume <id>` (bg) instead of launching. Fail-open:
# logs everything, exit 0/1. The old shell is closed only when the ownership
# guard (_common.ps1) says it is ours.

param(
    [Parameter(Mandatory)][string]$Bot,
    [Parameter(Mandatory)][int]$OldPid,
    # The launcher shell (pwsh/powershell) of the OLD session; force-closed
    # AFTER the old claude pid exits so an old window never lingers. NEVER a
    # terminal-host pid - the caller only passes a pwsh/powershell pid.
    [int]$OldShellPid = 0,
    [int]$TimeoutSec = 60,
    [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot '_common.ps1')

if ($Bot -notmatch '^[a-z0-9][a-z0-9-]{0,31}$') { Write-DaemonLog "restart: bad bot name '$Bot'"; exit 1 }
$P = Get-BotPaths -Bot $Bot
function Log { param([string]$M) Write-DaemonLog "restart[pid=$OldPid]: $M" -Bot $Bot }

$cfg = Get-BotConfig -Bot $Bot
$service = Get-BotSessionKind $cfg
Log "invoked (timeout=${TimeoutSec}s, shell=$OldShellPid, service=$service, dryrun=$DryRun)"

# --- 1. poll until the old claude pid is gone -------------------------------------
if ($OldPid -le 0) { Log 'OldPid must be > 0 (pid 0 is the System Idle Process and reads alive forever). NOT relaunching.'; exit 1 }
$deadline = (Get-Date).AddSeconds($TimeoutSec)
$exited = $false
while ((Get-Date) -lt $deadline) {
    if (-not (Get-Process -Id $OldPid -ErrorAction SilentlyContinue)) { $exited = $true; break }
    Start-Sleep -Milliseconds 500
}
if (-not $exited) {
    Log "TIMEOUT: pid $OldPid still alive after ${TimeoutSec}s. NOT relaunching (would race the same conversation). Start the bot by hand once it exits."
    exit 1
}
Log 'old session exited; preparing relaunch'

# --- 1b. close the OLD launcher shell -----------------------------------------------
if ($OldShellPid -gt 0) {
    try {
        if ($DryRun) { Log "DRYRUN would close old shell pid $OldShellPid (if ours)" }
        elseif (Test-ProcAlive $OldShellPid @('pwsh', 'powershell')) {
            $own = Get-ProcessOwnerRecord -ProcId $OldShellPid
            if ($own.Ours -and -not $own.Protected) { Stop-Process -Id $OldShellPid -Force -ErrorAction Stop; Log "closed old shell pid $OldShellPid ($($own.Reason))" }
            else { Log "SKIP not ours: $OldShellPid $($own.Name) ($($own.Reason)) [old shell] $($own.CmdHead)" }
        }
        else { Log "old shell pid $OldShellPid already gone / not a shell; nothing to close" }
    } catch { Log "could not close old shell pid ${OldShellPid}: $($_.Exception.Message)" }
}

# --- 2. fresh marker: honour a young one (re-touch), delete a stale one --------------
$resumeText = '--continue'
if ($service -eq 'bg') {
    $sid = ''; try { $st = Read-BotState -Bot $Bot; if ($st -and ($st.PSObject.Properties.Name -contains 'session_id')) { $sid = "$($st.session_id)" } } catch {}
    $resumeText = $(if ($sid) { "--resume $sid" } else { '--bg fresh (no session id recorded)' })
}
$mode = $resumeText
$fresh = $false
try {
    if (Test-Path $P.FreshMarker) {
        $age = [int]((Get-Date) - (Get-Item $P.FreshMarker).LastWriteTime).TotalSeconds
        if ($age -lt 300) {
            if (-not $DryRun) { (Get-Item $P.FreshMarker).LastWriteTime = Get-Date }
            $mode = 'START FRESH'; $fresh = $true
            Log "fresh marker present (${age}s old, declared roll) -> launcher will start FRESH (no $resumeText)"
        } else {
            if (-not $DryRun) { Remove-Item $P.FreshMarker -Force -ErrorAction SilentlyContinue }
            Log "stale fresh marker (${age}s) deleted -> relaunch will $resumeText"
        }
    } else {
        Log "relaunch will $resumeText (no fresh marker; long-running context preserved)"
    }
} catch { Log "marker note: $($_.Exception.Message)" }

# --- 2b. bg bot: relaunch through launch.ps1 -Bg and stop here --------------------------
if ($service -eq 'bg') {
    if ($DryRun) {
        Log "DRYRUN would relaunch via -> launch.ps1 -Bot $Bot -Bg$(if ($fresh) { ' -Fresh' }) [$mode]"
        Write-Host "DRYRUN: $mode"
        Write-Host "DRYRUN: would relaunch $Bot via launch.ps1 -Bg$(if ($fresh) { ' -Fresh' }) (claude --bg under the supervisor)"
        exit 0
    }
    Write-BotState -Bot $Bot -Updates @{ status = 'restarting'; launcher_started_at = (Get-Date).ToString('o') }
    $how = Start-BotBg -Bot $Bot -Fresh:$fresh -StartedBy 'daemon-restart'
    Write-BotState -Bot $Bot -Updates @{ launcher_started_at = $null }
    $st2 = Read-BotState -Bot $Bot
    $ok = $false; try { $ok = ("$($st2.status)" -eq 'running') } catch {}
    if ($ok) { Log "relaunched OK via -> $how [$mode]"; exit 0 }
    Log "RELAUNCH FAILED: $how. Start the bot by hand (botcorp start $Bot)."; exit 1
}

# --- 3. wait for the old pty-host to release its record ------------------------------
# pty-host removes state/<bot>.pty.json ~2 s after its pty exits and refuses
# to start while a live host holds the record. Give it that chance, then use
# the one tree-kill stop path so the relaunch never 409s on a half-dead tree.
try {
    $until = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $until) {
        $rec = Read-JsonFile -Path $P.PtyFile
        if (-not $rec) { break }
        if (-not (Test-ProcAlive ([int]$rec.pid) @('node'))) { break }
        Start-Sleep -Milliseconds 500
    }
    $rec = Read-JsonFile -Path $P.PtyFile
    if ($rec -and -not $DryRun) { Log "pty-host record still present (pid $($rec.pid)) -> pty-host --stop"; [void](Stop-PtyHost -Bot $Bot) }
} catch {}

# --- 4. relaunch -----------------------------------------------------------------------
$viaTask = $false
$sid = -1; try { $sid = [System.Diagnostics.Process]::GetCurrentProcess().SessionId } catch {}
$isid = if ($sid -eq 0) { Get-InteractiveSessionId } else { 0 }
$desc = if ($sid -eq 0 -and $isid -gt 0) { "BotCorp-Launch task (interactive session $isid), else pty-host --continue" } else { 'node daemon/pty-host.mjs --bot ' + $Bot + ' --continue (detached, hidden)' }

if ($DryRun) {
    Log "DRYRUN would relaunch via -> $desc [$mode]"
    Write-Host "DRYRUN: $mode"
    Write-Host "DRYRUN: would relaunch $Bot via $desc"
    exit 0
}

try {
    if ($sid -eq 0 -and $isid -gt 0) {
        $how = Start-VisibleLaunchTask -Bot $Bot -SessionId $isid
        if ($how) { $viaTask = $true; Write-BotState -Bot $Bot -Updates @{ launcher_pid = $null; launcher_started_at = (Get-Date).ToString('o'); status = 'restarting' }; Log "relaunched OK via -> $how [$mode]" }
    }
    if (-not $viaTask) {
        $lp = Start-PtyHost -Bot $Bot
        if ($lp -le 0) { Log 'RELAUNCH FAILED: pty-host did not start. Start the bot by hand.'; exit 1 }
        Write-BotState -Bot $Bot -Updates @{ launcher_pid = $lp; launcher_started_at = (Get-Date).ToString('o'); status = 'restarting' }
        Log "relaunched OK via -> pty-host --continue (pid $lp) [$mode]"
    }
    exit 0
} catch {
    Log "RELAUNCH FAILED: $($_.Exception.Message). Start the bot by hand."
    exit 1
}
