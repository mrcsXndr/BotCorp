# tick.ps1 - the BotCorp daemon tick: ONE process per machine keeps every bot
# under bots/<name>/ alive. Run by the 'BotCorp-Daemon' scheduled task (the
# user, LogonType Password, "run whether logged on or not": At Startup + every
# few minutes) through the hidden VBS shim; also by hand.
#
#   pwsh -NoProfile -File daemon/tick.ps1              # act
#   pwsh -NoProfile -File daemon/tick.ps1 -ProbeOnly   # report state, no action, no state writes
#   pwsh -NoProfile -File daemon/tick.ps1 -DryRun      # decide + log, launch nothing
#
# Each tick, under one global mutex (Global\BotCorpDaemon):
#   machine: keep the cockpit alive (/healthz; loopback-only unless <rt>/access.json
#            exists), keep the OTel sink alive if present, hourly harness update
#            CHECK (records releases only), APPLY of an admin-requested release
#            only when every bot is at a safe point (then the bots restart),
#            per-bot janitor once a day.
#   per bot: liveness. `harness.session: bg` (default): the bot is a Claude Code
#            background session - `claude agents --json` (under the bot's
#            CLAUDE_CONFIG_DIR) lists its id with a live pid, or the recorded
#            claude pid is alive. `session: pty`: the launcher shell + its
#            claude.exe child, or the claude pid, as before. (`harness.service:
#            manual` = never cold-started by the daemon.) Then the Telegram
#            poller, measured like `status` (bot.pid alive under this bot's
#            claude: Get-PollerVerdict, only with the telegram module); a bg
#            session is kept pinned (Set-BgPin: Claude Code retires an unpinned
#            idle one after 60 min) and a session waiting on a login / dialog is
#            logged BLOCKED (Get-BgBlock). Decide:
#              not alive                  -> COLD-START (bg: launch.ps1 -Bg with
#                                             --resume <session id>; pty: pty-host
#                                             or the visible task)
#              alive + poller DEAD        -> RESTART once the launch is older than
#                                             LauncherGraceMin (idle-gated: breakpoint
#                                             marker or transcript quiet)
#              alive + OWNED/UNKNOWN      -> nothing
#            then the isolated per-bot ticks (each in its own try/catch, module
#            gated): usage-limit resume, alert triage, breakpoint roll, board
#            poll, hub push, and the bot's automations (daemon/automations.ps1).
#   guards:  session-0 stray sweep, launcher grace + hung-launcher kill,
#            MaxStartsPerWindow cap (ACTION=START lines in the bot's log),
#            hidden-session-0 -> visible migration when a user is logged in
#            (pty bots only; a bg bot always lives under the supervisor and is
#            SEEN through `claude attach`, never moved).
#
# The process record is AUTHORITATIVE over the poller: a poller still running
# after the session died is an orphan and must never mask a dead bot. The tick never kills a busy session: unsure => busy => defer.
# Every kill goes through Stop-BotProcessTree (_common.ps1): a pid that is not
# recorded as ours, or is listed in <rt>/protect.json, is logged and skipped.
#
# STRICTLY FAIL-OPEN: every failure is logged; this script always exits 0.
# Nothing here holds the mutex across an unbounded call.

param(
    [switch]$ProbeOnly,
    [switch]$DryRun,
    [int]$MaxStartsPerWindow = 3,
    [int]$WindowMin = 30,
    # A cold-start launcher younger than this is "in progress" (no second
    # spawn); older and still without claude => hung -> tree killed.
    [int]$LauncherGraceMin = 4
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot '_common.ps1')

# --- profile pin (S4U fallback) --------------------------------------------------
# The default daemon task (LogonType Password) is a full logon: the user
# profile is loaded and this block is a no-op. Under the S4U fallback
# (install.ps1 -LogonType S4U, no stored password) the task runs WITHOUT the
# profile, so USERPROFILE/LOCALAPPDATA can point at the Default profile and
# every ~-anchored path (claude.exe, the per-user python, the WindowsApps
# aliases) silently misses. install.ps1 records the registering user's profile
# in <rt>/state/install.json; pin the env to match. Never a literal path here.
try {
    $inst = Read-JsonFile -Path (Join-Path $StateDir 'install.json')
    if ($inst -and $inst.user_profile -and (Test-Path $inst.user_profile) -and ($env:USERPROFILE -ne $inst.user_profile)) {
        $up = $inst.user_profile
        $env:USERPROFILE  = $up
        $env:HOME         = $up
        $env:LOCALAPPDATA = Join-Path $up 'AppData\Local'
        $env:APPDATA      = Join-Path $up 'AppData\Roaming'
        $env:Path         = "$env:Path;$up\.local\bin;$up\AppData\Local\Microsoft\WindowsApps;$env:ProgramFiles\nodejs;$env:ProgramFiles\Git\bin"
        Write-DaemonLog "profile pinned to $up (no profile loaded: S4U context)" -Quiet
    }
} catch {}

$pyExe = Resolve-Python
$nodeExe = Resolve-Node

function Get-RecentStartCount {
    # Count "ACTION=START bot=<name>" lines in the bot's log within the window.
    # Typed init is load-bearing: with `$ts = $null` pwsh 7.6 cannot bind the
    # [ref] overload of TryParse, the catch swallowed it and this returned 0
    # forever - the cap never fired during a 160-start loop.
    param([string]$Bot, [int]$WindowMinutes)
    $cutoff = (Get-Date).AddMinutes(-$WindowMinutes)
    $n = 0
    try {
        $log = Join-Path (Join-Path $LogsDir $Bot) 'daemon.log'
        if (-not (Test-Path $log)) { return 0 }
        foreach ($line in Get-Content $log -ErrorAction SilentlyContinue) {
            if ($line -notmatch "ACTION=START bot=$([regex]::Escape($Bot))\b") { continue }
            $stampStr = ($line -split '\s\s', 2)[0]
            $ts = [datetime]::MinValue
            if ([datetime]::TryParse($stampStr, [ref]$ts)) { if ($ts -ge $cutoff) { $n++ } }
        }
    } catch {}
    return $n
}

function Get-DaemonState { $s = Read-JsonFile -Path (Join-Path $StateDir 'daemon.json'); if ($s) { return (ConvertTo-Hashtable $s) }; return @{} }
function Set-DaemonState { param([hashtable]$Updates) try { $s = Get-DaemonState; foreach ($k in $Updates.Keys) { $s[$k] = $Updates[$k] }; [void](Write-JsonFile -Path (Join-Path $StateDir 'daemon.json') -Object $s) } catch {} }
function Test-DueMinutes { param([hashtable]$State, [string]$Key, [double]$EveryMin)
    try { if ($State.ContainsKey($Key) -and $State[$Key]) { $t = [datetime]::MinValue; if ([datetime]::TryParse("$($State[$Key])", [ref]$t)) { return (((Get-Date) - $t).TotalMinutes -ge $EveryMin) } } } catch {}
    return $true
}

# --- machine steps ---------------------------------------------------------------
function Invoke-CockpitKeepalive {
    # <rt>/cockpit.json {enabled, port, bind}; default enabled on 127.0.0.1:4477.
    # GET /healthz; down -> hidden `node cockpit/server.mjs --port N`. The tick
    # does not wait for it: the next tick verifies. Capped like bot starts so a
    # crashing cockpit cannot spawn a process every 3 minutes forever.
    # Exposure is an optional module: without <rt>/access.json (Cloudflare
    # Access {team, aud}) the cockpit is started LOOPBACK-ONLY whatever
    # cockpit.json says - the server itself refuses a non-loopback bind without
    # Access (exit 2), and spawning it just to watch it exit would burn the cap.
    param([switch]$AsDryRun)
    try {
        $srv = Join-Path (Join-Path $BotCorp 'cockpit') 'server.mjs'
        if (-not (Test-Path $srv)) { return }
        $c = Read-JsonFile -Path (Join-Path $RtHome 'cockpit.json')
        $enabled = $true; $port = 4477; $bind = '127.0.0.1'
        if ($c) {
            if (($c.PSObject.Properties.Name -contains 'enabled') -and ($c.enabled -eq $false)) { $enabled = $false }
            if ($c.port) { $port = [int]$c.port }
            if ($c.bind) { $bind = "$($c.bind)" }
        }
        if (-not $enabled) { return }
        if ($bind -notin @('127.0.0.1', 'localhost', '::1') -and -not (Test-Path (Join-Path $RtHome 'access.json'))) {
            Write-DaemonLog "cockpit: bind $bind requested but no $RtHome\access.json (integrations.access) -> loopback only" -Quiet
            $bind = '127.0.0.1'
        }
        $ok = $false
        try { $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/healthz" -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop; $ok = ($r.StatusCode -eq 200) } catch {}
        if ($ok) { return }
        $st = Get-DaemonState
        $cpid = 0; try { if ($st.ContainsKey('cockpit_pid')) { $cpid = [int]$st['cockpit_pid'] } } catch {}
        if ($cpid -gt 0 -and (Test-ProcAlive $cpid @('node'))) {
            $age = 1e9; try { $t = [datetime]::MinValue; if ([datetime]::TryParse("$($st['cockpit_started_at'])", [ref]$t)) { $age = ((Get-Date) - $t).TotalSeconds } } catch {}
            if ($age -lt 60) { Write-DaemonLog "cockpit: pid $cpid starting (${age}s) - waiting" -Quiet; return }
            Write-DaemonLog "cockpit: pid $cpid alive but /healthz down after $([int]$age)s -> killing tree"
            if (-not $AsDryRun) { [void](Stop-BotProcessTree -ProcId $cpid -Why 'cockpit healthz down') }
        }
        $n = 0
        try {
            $cutoff = (Get-Date).AddMinutes(-$WindowMin)
            foreach ($line in (Get-Content $DaemonLog -Tail 2000 -ErrorAction SilentlyContinue)) {
                if ($line -notmatch 'ACTION=COCKPIT-START') { continue }
                $ts = [datetime]::MinValue
                if ([datetime]::TryParse(($line -split '\s\s', 2)[0], [ref]$ts) -and $ts -ge $cutoff) { $n++ }
            }
        } catch {}
        if ($n -ge $MaxStartsPerWindow) { Write-DaemonLog "cockpit: start cap hit ($n/${WindowMin}m) - not restarting"; return }
        if ($AsDryRun) { Write-DaemonLog "DRYRUN would start cockpit on ${bind}:$port"; return }
        if (-not $nodeExe) { Write-DaemonLog 'cockpit: node.exe not found'; return }
        $newPid = Start-Hidden -Exe $nodeExe -Arguments @($srv, '--port', "$port", '--bind', $bind) -WorkingDirectory $BotCorp
        Write-DaemonLog "ACTION=COCKPIT-START pid=$newPid port=$port"
        Set-DaemonState @{ cockpit_pid = $newPid; cockpit_started_at = (Get-Date).ToString('o') }
    } catch { Write-DaemonLog "cockpit: swallowed exception (fail-open): $($_.Exception.Message)" }
}

function Invoke-OtelSinkKeepalive {
    # daemon/otel-sink.mjs (optional, written separately): loopback OTLP receiver
    # that records {port, pid} in <rt>/state/otel.json. Restart when its pid is gone.
    param([switch]$AsDryRun)
    try {
        $sink = Join-Path $PSScriptRoot 'otel-sink.mjs'
        if (-not (Test-Path $sink)) { return }
        $o = Read-JsonFile -Path (Join-Path $StateDir 'otel.json')
        $opid = 0; try { if ($o -and $o.pid) { $opid = [int]$o.pid } } catch {}
        if ($opid -gt 0 -and (Test-ProcAlive $opid @('node'))) { return }
        if ($AsDryRun) { Write-DaemonLog 'DRYRUN would start otel-sink'; return }
        if (-not $nodeExe) { return }
        $newPid = Start-Hidden -Exe $nodeExe -Arguments @($sink) -WorkingDirectory $BotCorp
        Write-DaemonLog "ACTION=OTEL-START pid=$newPid"
    } catch { Write-DaemonLog "otel-sink: swallowed exception (fail-open): $($_.Exception.Message)" }
}

function Invoke-UpdateCheck {
    # Hourly: daemon/update.ps1 -Check records every newer release (with its
    # What / Why / Value notes) in <rt>/state/updates.json. It never applies
    # and never messages.
    param([switch]$AsDryRun)
    try {
        $st = Get-DaemonState
        if (-not (Test-DueMinutes -State $st -Key 'update_check_at' -EveryMin 55)) { return }
        if ($AsDryRun) { Write-DaemonLog 'DRYRUN would run harness update check'; return }
        Set-DaemonState @{ update_check_at = (Get-Date).ToString('o') }
        $r = Invoke-Bounded -Exe (Resolve-PwshExe) -Arguments @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'update.ps1'), '-Check') -TimeoutSec 90 -Label 'update check' -Capture -WorkingDirectory $BotCorp
        $last = ''; try { $last = (($r.Output -split "`n" | Where-Object { $_.Trim() }) | Select-Object -Last 1) } catch {}
        Write-DaemonLog "update check: exit=$($r.ExitCode) $last"
    } catch { Write-DaemonLog "update check: swallowed exception (fail-open): $($_.Exception.Message)" }
}

function Invoke-UpdateApply {
    # Apply is an ADMIN action: only a release the CLI/cockpit marked
    # `status: apply_requested` in <rt>/state/updates.json is ever applied, and
    # only when EVERY bot is at a safe point (fresh breakpoint marker, or idle
    # per Test-SessionBusy; a bot that is not running is trivially safe).
    # update.ps1 -Apply -Tag does the checkout + smoke + rollback; on success
    # this returns the reason string and the per-bot tick restarts every live
    # bot through the normal (idle-gated) restart path onto the new code.
    param([switch]$AsDryRun)
    try {
        $u = Read-JsonFile -Path (Join-Path $StateDir 'updates.json')
        if (-not $u -or -not $u.releases) { return $null }
        $req = @($u.releases | Where-Object { "$($_.status)" -eq 'apply_requested' })
        if ($req.Count -eq 0) { return $null }
        $tag = "$($req[0].tag)"
        foreach ($b in (Get-BotList)) {
            $st = Read-BotState -Bot $b
            $running = $false
            try { if ($st -and ("$($st.status)" -in @('running', 'starting', 'restarting', 'cold-starting'))) { $running = $true } } catch {}
            if ($running -and (Test-SessionBusy -Bot $b)) { Write-DaemonLog "update apply $tag DEFERRED: $b is busy (no breakpoint, transcript fresh)" -Quiet; return $null }
        }
        if ($AsDryRun) { Write-DaemonLog "DRYRUN would apply harness release $tag (every bot at a safe point) and restart the bots"; return $null }
        Write-DaemonLog "ACTION=UPDATE-APPLY tag=$tag (admin-requested, every bot at a safe point)"
        $r = Invoke-Bounded -Exe (Resolve-PwshExe) -Arguments @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'update.ps1'), '-Apply', '-Tag', $tag) -TimeoutSec 220 -Label 'update apply' -Capture -WorkingDirectory $BotCorp
        $last = ''; try { $last = (($r.Output -split "`n" | Where-Object { $_.Trim() }) | Select-Object -Last 1) } catch {}
        Write-DaemonLog "update apply ${tag}: exit=$($r.ExitCode) $last"
        if ($r.ExitCode -eq 0) { return "harness update $tag applied" }
    } catch { Write-DaemonLog "update apply: swallowed exception (fail-open): $($_.Exception.Message)" }
    return $null
}

function Invoke-Janitor {
    # harness/tools/infra/resource_monitor.ps1 -Clean, once a day per bot with
    # the janitor module (it is BOT_HOME/CLAUDE_CONFIG_DIR-parametrised, so it
    # prunes each bot's own transcripts and reaps only bot-spawned strays).
    # `janitor: report` runs the same scan WITHOUT -Clean and logs what it found.
    param([string]$Bot, $Cfg, [hashtable]$Paths, [switch]$AsDryRun)
    try {
        $jan = Join-Path $Harness 'tools\infra\resource_monitor.ps1'
        if (-not (Test-Path $jan)) { return }
        $mode = 'clean'; try { $mode = Get-JanitorMode $Cfg.harness.modules.janitor } catch {}
        if ($mode -eq 'off') { return }
        $st = Read-BotState -Bot $Bot
        $last = $null; try { if ($st -and ($st.PSObject.Properties.Name -contains 'janitor_at')) { $last = $st.janitor_at } } catch {}
        if ($last) { $t = [datetime]::MinValue; if ([datetime]::TryParse("$last", [ref]$t) -and (((Get-Date) - $t).TotalHours -lt 23)) { return } }
        if ($AsDryRun) { Write-DaemonLog "DRYRUN would run janitor ($mode)" -Bot $Bot; return }
        Write-BotState -Bot $Bot -Updates @{ janitor_at = (Get-Date).ToString('o') }
        $r = Invoke-Bounded -Exe (Resolve-PwshExe) -Arguments (Get-JanitorArgs -Script $jan -Mode $mode) -TimeoutSec 300 -Label 'janitor' -Capture:($mode -eq 'report') -Env (Get-BotEnv -Bot $Bot -Cfg $Cfg -Paths $Paths) -WorkingDirectory $Paths.BotHome -Bot $Bot
        if ($mode -eq 'report') {
            $found = ''
            try {
                $j = ("$($r.Output)" -split "`n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1) | ConvertFrom-Json
                $cats = @($j.issues | ForEach-Object { "$($_.cat)" } | Where-Object { $_ } | Select-Object -Unique)
                $found = " worst=$($j.worst_severity) issues=$($j.issue_count)$(if ($cats.Count) { ': ' + ($cats -join ', ') })"
            } catch { $found = ' (no summary)' }
            Write-DaemonLog "janitor: report-only, nothing touched, exit=$($r.ExitCode)$found" -Bot $Bot
        } else { Write-DaemonLog "janitor: exit=$($r.ExitCode)" -Bot $Bot }
    } catch { Write-DaemonLog "janitor: swallowed exception (fail-open): $($_.Exception.Message)" -Bot $Bot }
}

# --- per-bot isolated ticks ------------------------------------------------------
function Invoke-UsageResume {
    # AUTO-CONTINUE after a usage-limit window. usage_monitor.py --resume-check
    # owns the decision (window passed? already resumed? too late?) and arms
    # the resume prompt; exit 10 = relaunch me. Idle-gated like every restart.
    param([string]$Bot, $Cfg, [hashtable]$Paths, [bool]$Alive, [int]$ClaudePid, [int]$ShellPid, [switch]$AsDryRun)
    try {
        $um = Join-Path $Harness 'tools\v2\usage_monitor.py'
        if (-not (Test-Path $um)) { return $false }
        if ($Alive -and (Test-SessionBusy -Bot $Bot)) { return $false }
        $a = @($um, '--resume-check'); if ($AsDryRun) { $a += '--dry-run' }
        $r = Invoke-Bounded -Exe $pyExe -Arguments $a -TimeoutSec 60 -Label 'usage_resume' -Capture -Env (Get-BotEnv -Bot $Bot -Cfg $Cfg -Paths $Paths) -WorkingDirectory $Paths.BotHome -Bot $Bot
        $last = ''; try { $last = (($r.Output -split "`n" | Where-Object { $_.Trim() }) | Select-Object -Last 1) } catch {}
        if ($r.ExitCode -eq 10) {
            Write-DaemonLog 'usage_resume: limit window passed - relaunching to continue work' -Bot $Bot
            if ($AsDryRun) { Write-DaemonLog 'usage_resume: dry-run, no relaunch' -Bot $Bot; return $false }
            return $true   # caller performs the restart/cold-start through the normal gated path
        } elseif ($last -and $last -notmatch '^(NONE|ALREADY-RESUMED)') { Write-DaemonLog "usage_resume: $last" -Bot $Bot }
    } catch { Write-DaemonLog "usage_resume: swallowed exception (fail-open): $($_.Exception.Message)" -Bot $Bot }
    return $false
}

function Invoke-AlertTriage {
    # alert_triage.py scan every BOT_TRIAGE_EVERY_MIN (30): classifies new
    # alerts.log lines and spawns ONE detached headless fix-or-card run. The
    # idle gate lives in the script (--session-busy) with its own staleness
    # waiver; the LLM run is never held under this mutex.
    param([string]$Bot, $Cfg, [hashtable]$Paths, [switch]$AsDryRun)
    try {
        $script = Join-Path $Harness 'tools\v2\alert_triage.py'
        if (-not (Test-Path $script)) { return }
        $every = 30; try { if ($env:BOT_TRIAGE_EVERY_MIN) { $every = [double]$env:BOT_TRIAGE_EVERY_MIN } } catch {}
        $st = Read-BotState -Bot $Bot
        try {
            if ($st -and ($st.PSObject.Properties.Name -contains 'triage_last_scan') -and $st.triage_last_scan) {
                $t = [datetime]::MinValue
                if ([datetime]::TryParse("$($st.triage_last_scan)", [ref]$t) -and (((Get-Date) - $t).TotalMinutes -lt $every)) { return }
            }
        } catch {}
        if (-not $AsDryRun) { Write-BotState -Bot $Bot -Updates @{ triage_last_scan = (Get-Date).ToString('o') } }
        $a = @($script, 'scan')
        if (Test-SessionBusy -Bot $Bot) { $a += '--session-busy' }
        if ($AsDryRun) { $a += '--dry-run' }
        $r = Invoke-Bounded -Exe $pyExe -Arguments $a -TimeoutSec 120 -Label 'alert_triage' -Env (Get-BotEnv -Bot $Bot -Cfg $Cfg -Paths $Paths) -WorkingDirectory $Paths.BotHome -Bot $Bot
        Write-DaemonLog "alert_triage: scan rc=$(if ($null -eq $r.ExitCode) { 'killed' } else { $r.ExitCode })$(if ($AsDryRun) { ' (dry-run)' })" -Bot $Bot
    } catch { Write-DaemonLog "alert_triage: swallowed exception (fail-open): $($_.Exception.Message)" -Bot $Bot }
}

function Invoke-BreakpointRoll {
    # Only while <BotHome>/.claude/.botcorp_breakpoint is fresh (the bot declared
    # a clean breakpoint): update_restart.py --auto (Claude Code's OWN update)
    # owns every gate and spawns restart.ps1 itself. (A harness release is no
    # longer applied at a breakpoint: Invoke-UpdateApply applies an
    # admin-requested one when every bot is safe, then the bots restart.)
    param([string]$Bot, $Cfg, [hashtable]$Paths, [int]$ClaudePid, [switch]$AsDryRun)
    try {
        if (-not (Test-BreakpointFresh -Bot $Bot)) { return $false }
        if ($ClaudePid -le 0) { Write-DaemonLog 'breakpoint: marker present but claude pid unresolved - deferring' -Bot $Bot; return $false }
        $ur = Join-Path $Harness 'tools\v2\update_restart.py'
        if (-not (Test-Path $ur)) { return $false }
        $a = @($ur, '--auto', '--claude-pid', "$ClaudePid"); if ($AsDryRun) { $a += '--dry-run' }
        $r = Invoke-Bounded -Exe $pyExe -Arguments $a -TimeoutSec 300 -Label 'update_restart' -Capture -Env (Get-BotEnv -Bot $Bot -Cfg $Cfg -Paths $Paths) -WorkingDirectory $Paths.BotHome -Bot $Bot
        $last = ''; try { $last = (($r.Output -split "`n" | Where-Object { "$_" -match 'auto|PENDING|spawned|WOULD' }) | Select-Object -Last 1) } catch {}
        if ($last) { Write-DaemonLog "update_restart: $($last.Trim())" -Bot $Bot }
    } catch { Write-DaemonLog "breakpoint: swallowed exception (fail-open): $($_.Exception.Message)" -Bot $Bot }
    return $false
}

function Invoke-BoardPoll {
    # gh_projects.py poll diffs the board vs its snapshot; each card that
    # entered the queue gets ONE tg_send.py line. DryRun logs intent only (the
    # poll mutates the snapshot, so a dry run must not consume a real change).
    param([string]$Bot, $Cfg, [hashtable]$Paths, [switch]$AsDryRun)
    try {
        $gh = Join-Path $Harness 'tools\v2\gh_projects.py'
        if (-not (Test-Path $gh)) { return }
        if ($AsDryRun) { Write-DaemonLog 'board: DRYRUN would poll + TG-alert any queued cards' -Bot $Bot; return }
        $env = Get-BotEnv -Bot $Bot -Cfg $Cfg -Paths $Paths
        $r = Invoke-Bounded -Exe $pyExe -Arguments @($gh, 'poll') -TimeoutSec 90 -Label 'board poll' -Capture -Env $env -WorkingDirectory $Paths.BotHome -Bot $Bot
        if ($r.ExitCode -ne 0) { Write-DaemonLog "board: poll exit=$($r.ExitCode) $((($r.Output -split "`n") | Select-Object -First 2) -join ' | ')" -Bot $Bot; return }
        $json = "$($r.Output)".Trim()
        if (-not $json) { return }
        $jsonLine = ($json -split "`n" | Where-Object { $_.TrimStart().StartsWith('{') } | Select-Object -Last 1)
        if (-not $jsonLine) { return }
        $parsed = $jsonLine | ConvertFrom-Json
        $queued = @($parsed.changes | Where-Object { $_.kind -eq 'queued' })
        if ($queued.Count -eq 0) { return }
        $tg = Join-Path $Harness 'tools\tg\tg_send.py'
        foreach ($c in $queued) {
            $title = "$($c.title)"
            $s = Invoke-Bounded -Exe $pyExe -Arguments @($tg, "Board: '$title' moved to Ready - picking it up") -TimeoutSec 60 -Label 'board tg' -Env $env -WorkingDirectory $Paths.BotHome -Bot $Bot
            Write-DaemonLog "board: TG-alerted queued '$title' (send exit=$($s.ExitCode))" -Bot $Bot
        }
    } catch { Write-DaemonLog "board: swallowed exception (fail-open): $($_.Exception.Message)" -Bot $Bot }
}

function Invoke-HubPush {
    param([string]$Bot, $Cfg, [hashtable]$Paths, [switch]$AsDryRun)
    try {
        $hp = Join-Path $Harness 'tools\infra\hub_push.py'
        if (-not (Test-Path $hp)) { return }
        if ($AsDryRun) { return }
        $r = Invoke-Bounded -Exe $pyExe -Arguments @($hp) -TimeoutSec 60 -Label 'hub push' -Capture -Env (Get-BotEnv -Bot $Bot -Cfg $Cfg -Paths $Paths) -WorkingDirectory $Paths.BotHome -Bot $Bot
        $last = ''; try { $last = (($r.Output -split "`n" | Where-Object { $_.Trim() }) | Select-Object -Last 1) } catch {}
        if ($last) { Write-DaemonLog "hub: $last" -Bot $Bot -Quiet }
    } catch { Write-DaemonLog "hub: swallowed exception (fail-open): $($_.Exception.Message)" -Bot $Bot }
}

function Invoke-Automations {
    param([string]$Bot, [switch]$AsDryRun)
    try {
        $a = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'automations.ps1'), '-Bot', $Bot)
        if ($AsDryRun) { $a += '-DryRun' }
        $r = Invoke-Bounded -Exe (Resolve-PwshExe) -Arguments @($a) -TimeoutSec 120 -Label 'automations' -WorkingDirectory $BotCorp -Bot $Bot
        if ($null -eq $r.ExitCode) { Write-DaemonLog 'automations: scheduler killed (fail-open)' -Bot $Bot }
    } catch { Write-DaemonLog "automations: swallowed exception (fail-open): $($_.Exception.Message)" -Bot $Bot }
}

# --- the per-bot liveness tick ------------------------------------------------------
function Start-BotCold {
    # COLD-START. Kill the bot.pid holder first (the plugin's own stale-kill
    # needs `ps` and is a no-op on Windows; the holder is ours only when its
    # command line names this bot's folder - Stop-BotProcessTree checks), stop
    # a dead pty-host with the same tree-kill the CLI uses, then launch:
    #   session bg  : launch.ps1 -Bg (bounded; `claude --bg --resume <session id>`,
    #                 the same conversation, under the supervisor in session 0).
    #                 Never handed to the visible task - a bg bot is SEEN through
    #                 `claude attach`, it does not need a desktop to run.
    #   session pty : a session-0 tick with a logged-in user hands off to the
    #                 BotCorp-Launch task (a hidden session-0 bot next to a
    #                 logged-in user is what stole a Telegram poller once);
    #                 otherwise pty-host, detached and hidden.
    # Records the launcher so the next tick can tell "still starting" from
    # "hung". Returns a description.
    param([string]$Bot, [hashtable]$Paths, [string]$Service = 'bg')
    try {
        if (Test-Path $Paths.BotPidFile) {
            $bp = Get-FirstPid ((Get-Content $Paths.BotPidFile -ErrorAction SilentlyContinue | Select-Object -First 1))
            if ($bp -gt 0) {
                $bpProc = Get-Process -Id $bp -ErrorAction SilentlyContinue
                if ($bpProc -and ($bpProc.ProcessName -in @('bun', 'node'))) {
                    Write-DaemonLog "orphaned poller bot.pid=$bp ($($bpProc.ProcessName)) before cold-start" -Bot $Bot
                    [void](Stop-BotProcessTree -ProcId $bp -Bot $Bot -Why 'orphaned Telegram poller (bot.pid) before cold-start')
                }
            }
        }
    } catch {}
    try {
        $pty = Read-JsonFile -Path $Paths.PtyFile
        if ($pty) { Write-DaemonLog "stale pty-host record (pid $($pty.pid)) -> pty-host --stop before cold-start" -Bot $Bot; [void](Stop-PtyHost -Bot $Bot) }
    } catch {}
    if ($Service -eq 'bg') {
        Write-BotState -Bot $Bot -Updates @{ launcher_pid = $null; launcher_started_at = (Get-Date).ToString('o') }
        $how = Start-BotBg -Bot $Bot -StartedBy 'daemon-cold'
        Write-BotState -Bot $Bot -Updates @{ launcher_started_at = $null }
        return $how
    }
    if (Test-Headless) {
        $isid = Get-InteractiveSessionId
        if ($isid -gt 0) {
            $how = Start-VisibleLaunchTask -Bot $Bot -SessionId $isid
            if ($how) { Write-BotState -Bot $Bot -Updates @{ launcher_pid = $null; launcher_started_at = (Get-Date).ToString('o') }; return $how }
        }
    }
    $lp = Start-PtyHost -Bot $Bot
    Write-BotState -Bot $Bot -Updates @{ launcher_pid = $(if ($lp -gt 0) { $lp } else { $null }); launcher_started_at = (Get-Date).ToString('o') }
    return "pty-host --continue (hidden) launcher pid $lp"
}

function Invoke-BotTick {
    param([string]$Bot)
    $P = Get-BotPaths -Bot $Bot
    $cfg = Get-BotConfig -Bot $Bot
    if (-not $cfg) { Write-DaemonLog 'skipped (bot.yaml unreadable/invalid)' -Bot $Bot; return }
    $hasTg = Test-BotModule $cfg 'telegram'
    $service = Get-BotSessionKind $cfg

    # --- liveness from the state record --------------------------------------
    $st = Read-BotState -Bot $Bot
    $shellPid = 0; $claudePid = 0; $bgId = ''; $sessionId = ''
    try { if ($st -and $null -ne $st.shell_pid) { $shellPid = [int]$st.shell_pid } } catch {}
    try { if ($st -and $null -ne $st.claude_pid) { $claudePid = [int]$st.claude_pid } } catch {}
    try { if ($st -and ($st.PSObject.Properties.Name -contains 'bg_id')) { $bgId = "$($st.bg_id)" } } catch {}
    try { if ($st -and ($st.PSObject.Properties.Name -contains 'session_id')) { $sessionId = "$($st.session_id)" } } catch {}
    $shellAlive = Test-ProcAlive $shellPid @('pwsh', 'powershell')
    $childPid = 0; $childQueryOk = $true
    if ($shellAlive) { $childPid = Get-ClaudeChildPid $shellPid; if ($childPid -lt 0) { $childQueryOk = $false; $childPid = 0 } }
    if ($childPid -gt 0) { $claudePid = $childPid }
    $claudeAlive = ($claudePid -gt 0) -and (Test-ProcAlive $claudePid @('claude'))
    $alive = (($shellAlive -and $childPid -gt 0) -or $claudeAlive)
    # bg liveness: the supervisor's roster (same token as the launch - the
    # daemon task), by short id, then session id, then cwd. A roster row with a
    # live pid refreshes claude_pid; a `stopped`/`done` row with no pid is dead.
    $bgNote = ''
    if ($service -eq 'bg' -and -not $alive) {
        $agents = Get-BgAgents -Bot $Bot -Paths $P
        if ($null -eq $agents) { $bgNote = 'roster=unknown' }
        else {
            $row = Find-BgAgent -Agents $agents -BgId $bgId -SessionId $sessionId -BotHome $P.BotHome
            if ($row) {
                $bgNote = "roster=$($row.id)/$($row.state)"
                if ("$($row.state)" -in @('done', 'failed')) { $bgNote += $(if ((Get-BgPins -ConfigDir $P.ConfigDir) -contains "$($row.id)") { " (pinned, so not retired for idleness: claude logs $($row.id) says why)" } else { ' (not pinned: Claude Code retires an idle background session after 60 min)' }) }
                if (Test-BgAgentAlive $row) {
                    $alive = $true
                    try { if (($row.PSObject.Properties.Name -contains 'pid') -and $row.pid) { $claudePid = [int]$row.pid } } catch {}
                    try { if (($row.PSObject.Properties.Name -contains 'id') -and $row.id) { $bgId = "$($row.id)" } } catch {}
                    try { if (($row.PSObject.Properties.Name -contains 'sessionId') -and $row.sessionId) { $sessionId = "$($row.sessionId)" } } catch {}
                }
            } else { $bgNote = 'roster=absent' }
        }
    } elseif ($service -eq 'bg') { $bgNote = 'pid alive' }
    if (-not $alive) { $claudePid = 0 }

    # --- poller (telegram module only, only while alive) ---------------------
    # Measured like `status`: bot.pid alive under this bot's claude (Get-PollerVerdict).
    $poller = 'n/a'
    if ($hasTg -and $alive) {
        $rec = ''; try { if ($st -and ($st.PSObject.Properties.Name -contains 'poller')) { $rec = "$($st.poller)" } } catch {}
        $poller = Get-PollerVerdict -BotPidFile (Join-Path $P.ConfigDir 'channels\telegram\bot.pid') -ClaudePid $claudePid -Recorded $rec
    }

    # --- bg: pinned (Claude Code retires an unpinned idle session after 60 min) and not blocked ---
    $blocked = ''
    if ($service -eq 'bg' -and $alive -and $bgId) {
        if (-not $ProbeOnly -and -not $DryRun -and ((Get-BgPins -ConfigDir $P.ConfigDir) -notcontains $bgId)) {
            $prevPin = ''; try { if ($st -and ($st.PSObject.Properties.Name -contains 'pinned_bg_id')) { $prevPin = "$($st.pinned_bg_id)" } } catch {}
            $pin = Set-BgPin -ConfigDir $P.ConfigDir -BgId $bgId -Replace $prevPin
            Write-DaemonLog "bg session $bgId was not pinned -> $pin (Claude Code's supervisor retires an unpinned idle background session after 60 min)" -Bot $Bot
            if ($pin -in @('pinned', 'already')) { $own = Get-BgPinOwner -Result $pin -BgId $bgId -Prev $prevPin; Write-BotState -Bot $Bot -Updates @{ pinned_bg_id = $(if ($own) { $own } else { $null }) } }
        }
        $blocked = Get-BgBlock -ConfigDir $P.ConfigDir -BgId $bgId
        $wasBlocked = ''; try { if ($st -and ($st.PSObject.Properties.Name -contains 'session_blocked') -and $st.session_blocked) { $wasBlocked = "$($st.session_blocked)" } } catch {}
        if ($blocked -ne $wasBlocked) {
            if ($blocked) { Write-DaemonLog "BLOCKED: session $bgId waits on '$blocked' - nothing unattended can answer that (claude attach $bgId, or the cockpit)" -Bot $Bot }
            elseif ($wasBlocked) { Write-DaemonLog "session $bgId no longer blocked (was: '$wasBlocked')" -Bot $Bot }
            if (-not $ProbeOnly -and -not $DryRun) { Write-BotState -Bot $Bot -Updates @{ session_blocked = $(if ($blocked) { $blocked } else { $null }) } }
        }
    }

    Write-DaemonLog "state: alive=$alive service=$service shellPid=$shellPid claudePid=$claudePid$(if ($service -eq 'bg') { " bg=$bgId $bgNote" }) poller=$poller$(if ($blocked) { " blocked='$blocked'" }) modules=$(@($cfg._modules) -join ',')" -Bot $Bot

    if ($alive -and -not $ProbeOnly) {
        $upd = @{ claude_pid = $claudePid; shell_pid = $(if ($shellAlive) { $shellPid } else { $null }); updated_at = (Get-Date).ToString('o'); poller = $poller; status = 'running' }
        if ($service -eq 'bg') { if ($bgId) { $upd['bg_id'] = $bgId }; if ($sessionId) { $upd['session_id'] = $sessionId } }
        Write-BotState -Bot $Bot -Updates $upd
    }
    if ($ProbeOnly) { return }

    # --- decide -----------------------------------------------------------------
    # A poller DEAD within the launcher grace may still be connecting: not yet.
    $startedMin = 1e9
    try { if ($st -and $st.started_at) { $sa = ConvertTo-UtcTime $st.started_at; if ($sa -ne [datetime]::MinValue) { $startedMin = ((Get-Date).ToUniversalTime() - $sa).TotalMinutes } } } catch {}
    $action = 'none'; $why = ''
    if (-not $alive) { $action = 'cold-start' }
    elseif ($poller -eq 'DEAD' -and $startedMin -ge $LauncherGraceMin) { $action = 'restart' }

    if (($action -eq 'cold-start') -and (Test-Path $P.PausedFile)) {
        Write-DaemonLog 'paused (state/<bot>.paused present) - not cold-starting' -Bot $Bot -Quiet
        $action = 'paused'
    }
    if (($action -eq 'cold-start') -and (Test-BotManualService $cfg)) {
        Write-DaemonLog 'harness.service: manual - the daemon does not cold-start this bot' -Bot $Bot -Quiet
        $action = 'paused'
    }

    # --- session-0 stray sweep ---------------------------------------------------
    # Hung session-0 launchers outlive the tick that spawned them (the task's
    # time limit kills the tick, not its detached children) and can only be
    # killed under the task's own token. Any session-0 pwsh/powershell older
    # than 10 min whose command line names THIS bot's folder, is not the owner
    # shell, not our ancestry, and has no claude.exe child -> tree killed,
    # through the ownership guard (the folder match is what makes it ours;
    # protect.json still wins).
    try {
        # ($wp, not $p: PowerShell variable names are case-insensitive and $P is the paths table)
        $all = Get-CimInstance Win32_Process -ErrorAction Stop
        $byPid = @{}; foreach ($wp in $all) { $byPid[[int]$wp.ProcessId] = $wp }
        $anc = @(); $cur = [int]$PID
        while ($cur -gt 0 -and $byPid.ContainsKey($cur) -and $anc.Count -lt 20) { $anc += $cur; $cur = [int]$byPid[$cur].ParentProcessId }
        $claudeParents = @($all | Where-Object { $_.Name -eq 'claude.exe' } | ForEach-Object { [int]$_.ParentProcessId })
        $needle = [regex]::Escape((Join-Path $BotsDir $Bot))
        foreach ($wp in $all) {
            if ($wp.SessionId -ne 0 -or $wp.Name -notin @('pwsh.exe', 'powershell.exe')) { continue }
            $ppid = [int]$wp.ProcessId
            if ($ppid -eq $shellPid -or $anc -contains $ppid -or $claudeParents -contains $ppid) { continue }
            if ("$($wp.CommandLine)" -notmatch $needle) { continue }
            if (-not $wp.CreationDate) { continue }
            $ageMin = ((Get-Date) - $wp.CreationDate).TotalMinutes
            if ($ageMin -le 10) { continue }
            if ($DryRun) { Write-DaemonLog "DRYRUN would kill stray session-0 shell pid $ppid (age $([int]$ageMin)m)" -Bot $Bot; continue }
            [void](Stop-BotProcessTree -ProcId $ppid -Bot $Bot -Why "stray session-0 shell, age $([int]$ageMin)m, no claude child")
        }
    } catch { Write-DaemonLog "stray sweep failed (fail-open): $($_.Exception.Message)" -Bot $Bot }

    # --- cold-start hygiene: launcher grace / hung launcher -----------------------
    if ($action -eq 'cold-start') {
        $st = Read-BotState -Bot $Bot
        $lpid = 0; $lageMin = 1e9
        if ($st) {
            try { if ($null -ne $st.launcher_pid) { $lpid = [int]$st.launcher_pid } } catch {}
            $ls = [datetime]::MinValue
            if ($st.launcher_started_at -and [datetime]::TryParse("$($st.launcher_started_at)", [ref]$ls)) { $lageMin = ((Get-Date) - $ls).TotalMinutes }
            # A launch.ps1 in its bounded pre-steps (manual or ours) has already
            # seeded status=starting; give it the same grace.
            try {
                if ("$($st.status)" -eq 'starting' -and $st.started_at) {
                    $ss = [datetime]::MinValue
                    if ([datetime]::TryParse("$($st.started_at)", [ref]$ss) -and $shellAlive) { $lageMin = [Math]::Min($lageMin, ((Get-Date) - $ss).TotalMinutes) }
                }
            } catch {}
        }
        if ($lpid -gt 0 -and (Test-ProcAlive $lpid @('node', 'pwsh', 'powershell'))) {
            if ($lageMin -lt $LauncherGraceMin) { Write-DaemonLog "cold-start in progress (launcher pid $lpid, age $([int]($lageMin * 60))s) - not spawning another" -Bot $Bot; return }
            if ($DryRun) { Write-DaemonLog "DRYRUN would kill hung launcher pid $lpid (age $([int]$lageMin)m)" -Bot $Bot; return }
            [void](Stop-BotProcessTree -ProcId $lpid -Bot $Bot -Why "launcher HUNG after $([int]$lageMin)m")
            Write-BotState -Bot $Bot -Updates @{ launcher_pid = $null; launcher_started_at = $null }
        } elseif ($lpid -le 0 -and $lageMin -lt $LauncherGraceMin) {
            Write-DaemonLog "cold-start in progress (age $([int]($lageMin * 60))s) - not spawning another" -Bot $Bot; return
        } elseif (($lpid -gt 0 -or $lageMin -lt 1e9) -and -not $DryRun) {
            Write-BotState -Bot $Bot -Updates @{ launcher_pid = $null; launcher_started_at = $null }
        }
    }

    # --- hidden session-0 bot while a user is logged in -> migrate to visible ---
    # pty bots only: a bg bot lives under the supervisor by design.
    $migrateVisible = $false
    if ($service -ne 'bg' -and $action -eq 'none' -and $alive -and $shellAlive -and (Test-Headless)) {
        $ownerSession = Get-ProcessSessionId $shellPid
        $isid = Get-InteractiveSessionId
        if ($ownerSession -eq 0 -and $isid -gt 0) {
            if (Test-SessionBusy -Bot $Bot) { Write-DaemonLog "hidden session-0 bot with user in session ${isid}: migrate DEFERRED (session busy)" -Bot $Bot -Quiet }
            elseif ($claudePid -le 0) { Write-DaemonLog 'hidden session-0 bot: migrate DEFERRED (claude pid unresolved)' -Bot $Bot -Quiet }
            else { $action = 'restart'; $migrateVisible = $true; Write-DaemonLog "hidden session-0 bot (shell $shellPid, claude $claudePid) with user in session $isid -> graceful restart into the visible path" -Bot $Bot }
        }
    }

    # --- isolated per-bot ticks (never gate the liveness decision) ----------------
    $resumeWanted = $false
    if (Test-BotModule $cfg 'usage_resume') { $resumeWanted = Invoke-UsageResume -Bot $Bot -Cfg $cfg -Paths $P -Alive $alive -ClaudePid $claudePid -ShellPid $shellPid -AsDryRun:$DryRun }
    if (Test-BotModule $cfg 'alert_triage') { Invoke-AlertTriage -Bot $Bot -Cfg $cfg -Paths $P -AsDryRun:$DryRun }
    if ($action -eq 'none') {
        if (Invoke-BreakpointRoll -Bot $Bot -Cfg $cfg -Paths $P -ClaudePid $claudePid -AsDryRun:$DryRun) { $action = 'restart'; $why = 'harness update at declared breakpoint' }
        if (Test-BotModule $cfg 'board') { Invoke-BoardPoll -Bot $Bot -Cfg $cfg -Paths $P -AsDryRun:$DryRun }
        if (Test-BotModule $cfg 'hub') { Invoke-HubPush -Bot $Bot -Cfg $cfg -Paths $P -AsDryRun:$DryRun }
        if (Test-BotModule $cfg 'janitor') { Invoke-Janitor -Bot $Bot -Cfg $cfg -Paths $P -AsDryRun:$DryRun }
    }
    if ($resumeWanted -and $action -eq 'none') { $action = $(if ($alive -and $claudePid -gt 0) { 'restart' } else { 'cold-start' }); $why = 'usage-limit window passed' }
    # A harness release applied this tick: every live bot restarts onto the new
    # code (idle-gated below like any restart; a dead bot cold-starts onto it).
    if ($script:RestartAllWhy -and $action -eq 'none' -and $alive) { $action = 'restart'; $why = $script:RestartAllWhy }
    Invoke-Automations -Bot $Bot -AsDryRun:$DryRun

    if ($action -in @('none', 'paused')) { Write-DaemonLog "no action (alive=$alive poller=$poller)" -Bot $Bot -Quiet; return }
    if ($DryRun) { Write-DaemonLog "DRYRUN would $action $Bot (alive=$alive poller=$poller)" -Bot $Bot; return }

    # --- start cap --------------------------------------------------------------
    $recent = Get-RecentStartCount -Bot $Bot -WindowMinutes $WindowMin
    if ($recent -ge $MaxStartsPerWindow) { Write-DaemonLog "start cap hit ($recent/${WindowMin}m) - refusing to $action; manual start needed" -Bot $Bot; return }

    if ($action -eq 'restart') {
        # NEVER kill a session that is actively working: a busy session is
        # deferred, not killed (long-running context is load-bearing).
        if (-not $why) { $why = if ($migrateVisible) { 'migrate hidden session-0 bot to visible' } else { "poller $poller" } }
        if (Test-SessionBusy -Bot $Bot) { Write-DaemonLog "restart DEFERRED ($why): session BUSY (transcript fresh) - not killing live work" -Bot $Bot; return }
        if ($claudePid -le 0) { Write-DaemonLog 'restart DEFERRED: claude pid unresolved (never restart.ps1 -OldPid 0)' -Bot $Bot; return }
        $rel = if ($service -eq 'bg') { "--resume $sessionId" } else { '--continue' }
        Write-DaemonLog "ACTION=START bot=$Bot kind=restart ($why, session idle -> $rel)" -Bot $Bot
        Write-BotState -Bot $Bot -Updates @{ started_by = 'daemon-restart'; updated_at = (Get-Date).ToString('o'); status = 'restarting' }
        $rp = Start-RestartDetached -Bot $Bot -OldPid $claudePid -OldShellPid $shellPid
        if ($service -eq 'bg') {
            # `claude stop <id>` first (the conversation is kept), then the
            # guarded tree-kill if the worker lingers; restart.ps1 relaunches
            # once the pid is gone.
            Write-DaemonLog "restart.ps1 spawned (pid $rp); claude stop $bgId (claude pid $claudePid)" -Bot $Bot
            [void](Stop-BgSession -Bot $Bot -Paths $P)
        } else {
            Write-DaemonLog "restart.ps1 spawned (pid $rp); terminating claude pid $claudePid" -Bot $Bot
            $own = Get-ProcessOwnerRecord -ProcId $claudePid
            if ($own.Ours -and -not $own.Protected) { try { Stop-Process -Id $claudePid -Force -ErrorAction SilentlyContinue } catch {} }
            else { Write-DaemonLog "SKIP not ours: $claudePid $($own.Name) ($($own.Reason)) [restart] $($own.CmdHead)" -Bot $Bot }
        }
        return
    }

    # cold-start: an orphan launcher shell without claude races the owner-lock
    # with the new launch -> terminate it first (TOCTOU re-check right before).
    if ($shellAlive -and $shellPid -gt 0) {
        if ((Get-ClaudeChildPid $shellPid) -gt 0) { Write-DaemonLog "cold-start ABORTED: claude child appeared under shell pid $shellPid (launch raced in)" -Bot $Bot; return }
        [void](Stop-BotProcessTree -ProcId $shellPid -Bot $Bot -Why 'cold-start: orphan launcher shell (no claude child)')
    }
    Write-DaemonLog "ACTION=START bot=$Bot kind=cold-start ($(if ($why) { $why } else { 'bot process down' }))" -Bot $Bot
    Write-BotState -Bot $Bot -Updates @{ started_by = 'daemon-cold'; claude_pid = $null; shell_pid = $null; updated_at = (Get-Date).ToString('o'); status = 'cold-starting' }
    $how = Start-BotCold -Bot $Bot -Paths $P -Service $service
    Write-DaemonLog "cold-start launched via: $how" -Bot $Bot
}

# --- single instance ---------------------------------------------------------------
$mutex = New-Object System.Threading.Mutex($false, 'Global\BotCorpDaemon')
$haveMutex = $false
try { $haveMutex = $mutex.WaitOne(0) }
catch [System.Threading.AbandonedMutexException] { $haveMutex = $true }
if (-not $haveMutex) { Write-DaemonLog 'another daemon tick holds the mutex; exiting'; exit 0 }

try {
    Write-DaemonLog "tick start (probe=$ProbeOnly dry=$DryRun headless=$(Test-Headless) rt=$RtHome)" -Quiet
    $script:RestartAllWhy = $null
    if (-not $ProbeOnly) {
        Invoke-CockpitKeepalive -AsDryRun:$DryRun
        Invoke-OtelSinkKeepalive -AsDryRun:$DryRun
        Invoke-UpdateCheck -AsDryRun:$DryRun
        $script:RestartAllWhy = Invoke-UpdateApply -AsDryRun:$DryRun
    }
    $bots = @(Get-BotList)
    if ($bots.Count -eq 0) { Write-DaemonLog "no bots under $BotsDir" }
    foreach ($b in $bots) {
        try { Invoke-BotTick -Bot $b }
        catch { Write-DaemonLog "EXCEPTION in bot tick (fail-open): $($_.Exception.Message)" -Bot $b }
    }
    if ($ProbeOnly) { Write-DaemonLog 'probe-only; no action' }
}
catch { Write-DaemonLog "EXCEPTION (fail-open): $($_.Exception.Message)" }
finally {
    try { $mutex.ReleaseMutex() } catch {}
    try { $mutex.Dispose() } catch {}
}
exit 0
