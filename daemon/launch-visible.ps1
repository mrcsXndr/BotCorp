# launch-visible.ps1 - open a bot in a VISIBLE window from the user's session.
#
#   pwsh -NoProfile -File daemon/launch-visible.ps1 [-Bot <name>] [-Elevate]
#
# Action of the per-machine 'BotCorp-Launch' scheduled task (install.ps1:
# Interactive principal, NO triggers, no time limit). The daemon tick runs in
# session 0 and cannot place a window on the desktop; when a user is logged in
# it writes <rt>/state/launch-request.json {bot, requested_at} and
# Start-ScheduledTask's this, which then runs in the interactive session.
# Without -Bot the request file names the bot; a request older than 10 min is
# ignored (a task started by hand long after must not launch a stale bot).
#
# What the window runs depends on bot.yaml harness.session:
#   bg (default)  `claude attach <bg id>` (id from <rt>/state/<bot>.json). The
#                 session keeps running when the window closes. The supervisor
#                 pipe answers only callers with the daemon's elevation: when
#                 install.json says run_level Highest (or -Elevate is passed)
#                 the window is opened elevated (Start-Process -Verb RunAs;
#                 UAC may prompt). No bg id recorded -> a message, no launch
#                 (the daemon tick starts bg bots, not this task).
#   pty           a Windows Terminal profile named 'BotCorp-<bot>' when one
#                 exists, else a visible pwsh -NoExit running
#                 daemon/launch.ps1 -Bot <name> -Continue -StartedBy visible.
#                 launch.ps1's duplicate guard refuses a second copy.
# Fail-open: exit 0 always.

param([string]$Bot, [switch]$Elevate)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot '_common.ps1')

try {
    if (-not $Bot) {
        $req = Read-JsonFile -Path (Join-Path $StateDir 'launch-request.json')
        if (-not $req -or -not $req.bot) { Write-DaemonLog 'launch-visible: no -Bot and no launch-request.json - nothing to do'; exit 0 }
        $t = [datetime]::MinValue
        if ($req.requested_at -and [datetime]::TryParse("$($req.requested_at)", [ref]$t) -and (((Get-Date) - $t).TotalMinutes -gt 10)) {
            Write-DaemonLog "launch-visible: request for '$($req.bot)' is stale ($([int]((Get-Date) - $t).TotalMinutes)m) - ignored"; exit 0
        }
        $Bot = "$($req.bot)"
        try { Remove-Item (Join-Path $StateDir 'launch-request.json') -Force -ErrorAction SilentlyContinue } catch {}
    }
    if ($Bot -notmatch '^[a-z0-9][a-z0-9-]{0,31}$') { Write-DaemonLog "launch-visible: bad bot name '$Bot'"; exit 0 }
    $launcher = Join-Path $PSScriptRoot 'launch.ps1'
    $sid = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
    $cfg = Get-BotConfig -Bot $Bot
    $service = Get-BotSessionKind $cfg

    $wtCmd = Get-Command wt.exe -ErrorAction SilentlyContinue
    $wtAlias = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\wt.exe'
    $wtPath = if ($wtCmd) { $wtCmd.Source } elseif (Test-Path $wtAlias) { $wtAlias } else { $null }

    if ($service -eq 'bg') {
        # One attach path for the task, the tray and `botcorp attach`: a WT tab
        # running `claude attach <bg id>` under the bot's config home, elevated
        # when install.json says Highest (daemon/attach.ps1).
        $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'attach.ps1'), '-Bot', $Bot)
        if ($Elevate) { $a += '-Elevate' }
        & (Resolve-PwshExe) @a
        Write-DaemonLog "launch-visible: session $sid -> attach.ps1 -Bot $Bot" -Bot $Bot
        exit 0
    }

    $wtProfile = "BotCorp-$Bot"
    $haveProfile = $false
    try {
        $wtSettings = Join-Path $env:LOCALAPPDATA 'Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json'
        if (Test-Path $wtSettings) { $haveProfile = ((Get-Content $wtSettings -Raw) -match ('"name"\s*:\s*"' + [regex]::Escape($wtProfile) + '"')) }
    } catch {}

    if ($haveProfile -and $wtPath) {
        # -w 0 = new tab in the most-recently-used WT window (no extra window).
        Start-Process -FilePath $wtPath -ArgumentList @('-w', '0', '-p', $wtProfile)
        Write-DaemonLog "launch-visible: session $sid -> wt -w 0 -p $wtProfile" -Bot $Bot
    } else {
        $a = @('-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $launcher, '-Bot', $Bot, '-Continue', '-StartedBy', 'visible')
        Start-Process -FilePath (Resolve-PwshExe) -ArgumentList $a -WorkingDirectory (Join-Path $BotsDir $Bot)
        Write-DaemonLog "launch-visible: session $sid -> pwsh -NoExit launch.ps1 -Bot $Bot -Continue (no WT profile '$wtProfile')" -Bot $Bot
    }
} catch {
    Write-DaemonLog "launch-visible: FAILED: $($_.Exception.Message)"
}
exit 0
