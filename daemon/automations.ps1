# automations.ps1 - run ONE bot's `automations:` (bot.yaml) from the daemon tick.
#
#   pwsh -NoProfile -File daemon/automations.ps1 -Bot <name> [-DryRun] [-RunNow <automation>]
#
# Every bot declares its jobs in bot.yaml (docs/automations.md); the ONE daemon
# runs them all. Per enabled entry, each tick decides "due" (cron / interval_min
# / an event queued under <rt>/state/<bot>/events/<event>.queue), enforces
# max_per_day, exponential backoff after failures (backoff.base_min doubling up
# to backoff.max_min, reset on success), idle_gated (same Test-SessionBusy as
# every restart gate) and critical (still runs while the bot's Claude account
# is usage-blocked per <rt>/state/accounts.json), then runs it bounded by
# timeout_min with a tree-kill on overrun. cwd = BOT_HOME; env = the bot env +
# BOT_AUTOMATION=<name> + BOT_RUN_ID + the vault keys listed in `secrets:`
# (decrypted in-process, for that run only, never on a command line).
#
# The daemon mutex is never held across a run: anything with timeout_min > 0.5
# is spawned DETACHED as its own waiter (`-ExecJob <job file>`, internal) that
# owns the timeout and the tree-kill. Short jobs run inline.
#
# Every run is recorded: <rt>/state/<bot>/runs.jsonl one line
#   {automation, run_id, start, end, exit, duration_s, summary, log}
# summary = the first stdout line starting `SUMMARY:` else the last non-empty
# line (200 chars); exit = 124 on timeout. log = <rt>/logs/<bot>/<automation>/<run_id>.log.
# Retention: logs 14 days or 50 MB per automation (oldest first), runs.jsonl
# rotated at 10 MB (one previous kept), a daily rollup appended to the bot's
# tracked memory/metrics/automations.csv (date,automation,runs,failures,avg_s).
# Per-automation state (failure_streak, next_due, runs_today, last_ok, ...) in
# <rt>/state/<bot>/automations.json.
#
# `botcorp automations pause` flips `enabled: false` in bot.yaml; this script
# only honours it. -RunNow <name> queues one run now, respecting timeout_min but
# not max_per_day (the cockpit's "Run now").
#
# Test seam: BOTCORP_FAKE_NOW=<ISO> overrides "now" for the schedule (due,
# next_due, runs_today's date, run start/end stamps). Harmless when unset.
# Fail-open: exit 0 always.

param(
    [Parameter(Mandatory)][string]$Bot,
    [switch]$DryRun,
    [string]$RunNow,
    # internal: the detached waiter mode (path to a job file written by the scheduler)
    [string]$ExecJob
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot '_common.ps1')

if ($Bot -notmatch '^[a-z0-9][a-z0-9-]{0,31}$') { Write-DaemonLog "automations: bad bot name '$Bot'"; exit 0 }
$P = Get-BotPaths -Bot $Bot
$AutoStateFile = Join-Path $P.BotStateDir 'automations.json'
$RunsFile = Join-Path $P.BotStateDir 'runs.jsonl'
$EventsDir = Join-Path $P.BotStateDir 'events'
$JobsDir = Join-Path $P.BotStateDir 'jobs'
foreach ($d in @($P.BotStateDir, $JobsDir)) { try { if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null } } catch {} }

function Log { param([string]$M, [switch]$Quiet) Write-DaemonLog "automations: $M" -Bot $Bot -Quiet:$Quiet }
function ToIso { param([datetime]$T) return $T.ToString('o') }
function FromIso { param($S)
    # ConvertFrom-Json already turns ISO strings into [datetime]; never round-trip
    # those through a culture-formatted string (dd/MM boxes would misparse).
    if ($S -is [datetime]) { return $S }
    try { if ($S) { return [datetime]::Parse("$S", [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind) } } catch {}
    return $null
}
function Num { param($V, [double]$Default) try { if ($null -ne $V -and "$V" -ne '') { return [double]$V } } catch {}; return $Default }

# --- cron (5 fields: min hour dom month dow; * */n a,b a-b a-b/n; dow 0-7, 7=Sunday) ---
function Expand-CronField {
    param([string]$Field, [int]$Min, [int]$Max)
    $set = New-Object 'System.Collections.Generic.HashSet[int]'
    foreach ($part in ($Field -split ',')) {
        $p = $part.Trim(); if (-not $p) { return $null }
        $step = 1
        if ($p -match '^(.+)/(\d+)$') { $p = $matches[1]; $step = [int]$matches[2]; if ($step -le 0) { return $null } }
        $lo = $Min; $hi = $Max
        if ($p -eq '*') { }
        elseif ($p -match '^(\d+)-(\d+)$') { $lo = [int]$matches[1]; $hi = [int]$matches[2] }
        elseif ($p -match '^\d+$') { $lo = [int]$p; $hi = $(if ($step -gt 1) { $Max } else { [int]$p }) }
        else { return $null }
        if ($lo -lt $Min -or $hi -gt $Max -or $lo -gt $hi) { return $null }
        for ($v = $lo; $v -le $hi; $v += $step) { [void]$set.Add($v) }
    }
    return $set
}

function ConvertFrom-Cron {
    param([string]$Expr)
    $f = @("$Expr".Trim() -split '\s+')
    if ($f.Count -ne 5) { return $null }
    $m = Expand-CronField $f[0] 0 59; $h = Expand-CronField $f[1] 0 23
    $dom = Expand-CronField $f[2] 1 31; $mon = Expand-CronField $f[3] 1 12; $dow = Expand-CronField $f[4] 0 7
    if ($null -eq $m -or $null -eq $h -or $null -eq $dom -or $null -eq $mon -or $null -eq $dow) { return $null }
    if ($dow.Contains(7)) { [void]$dow.Add(0) }
    return @{ m = $m; h = $h; dom = $dom; mon = $mon; dow = $dow; domAny = ($f[2] -eq '*'); dowAny = ($f[4] -eq '*') }
}

function Test-CronDay {
    param($C, [datetime]$T)
    $domOk = $C.dom.Contains($T.Day); $dowOk = $C.dow.Contains([int]$T.DayOfWeek)
    if ($C.domAny -and $C.dowAny) { return $true }
    if ($C.domAny) { return $dowOk }
    if ($C.dowAny) { return $domOk }
    return ($domOk -or $dowOk)   # both restricted: standard cron ORs them
}

function Get-CronNext {
    # First minute strictly after $From that matches; $null if the expression
    # is invalid or nothing matches within 400 days.
    param([string]$Expr, [datetime]$From)
    $c = ConvertFrom-Cron $Expr
    if (-not $c) { return $null }
    $t = $From.AddSeconds(-$From.Second).AddMilliseconds(-$From.Millisecond).AddMinutes(1)
    $limit = $From.AddDays(400)
    while ($t -lt $limit) {
        if (-not $c.mon.Contains($t.Month)) { $t = ([datetime]::new($t.Year, $t.Month, 1, 0, 0, 0, $t.Kind)).AddMonths(1); continue }
        if (-not (Test-CronDay $c $t)) { $t = $t.Date.AddDays(1); continue }
        if (-not $c.h.Contains($t.Hour)) { $t = $t.Date.AddHours($t.Hour + 1); continue }
        if (-not $c.m.Contains($t.Minute)) { $t = $t.AddMinutes(1); continue }
        return $t
    }
    return $null
}

# --- per-automation state, read-modify-write under a per-bot mutex -----------------
function Use-AutoState {
    # $Body receives the state hashtable (name -> hashtable) and mutates it.
    param([scriptblock]$Body)
    $mx = New-Object System.Threading.Mutex($false, "Global\BotCorpAutomations-$Bot")
    $have = $false
    try { $have = $mx.WaitOne(30000) } catch [System.Threading.AbandonedMutexException] { $have = $true } catch {}
    try {
        $st = @{}
        $raw = Read-JsonFile -Path $AutoStateFile
        # $prop, never $p: $Body runs in a child scope of THIS one, and $P (the
        # bot paths, case-insensitive) would otherwise resolve to the last property.
        if ($raw) { foreach ($prop in $raw.PSObject.Properties) { $st[$prop.Name] = ConvertTo-Hashtable $prop.Value } }
        & $Body $st
        [void](Write-JsonFile -Path $AutoStateFile -Object $st -Depth 6)
    } catch { Log "state update failed (fail-open): $($_.Exception.Message)" }
    finally { if ($have) { try { $mx.ReleaseMutex() } catch {} }; try { $mx.Dispose() } catch {} }
}

function Get-NextDueAfterSuccess {
    param($A, [datetime]$T)
    $trig = $A.trigger
    if ($trig.interval_min) { return (ToIso $T.AddMinutes((Num $trig.interval_min 60))) }
    if ($trig.cron) { $n = Get-CronNext -Expr "$($trig.cron)" -From $T; if ($n) { return (ToIso $n) } }
    return $null
}

# --- the run itself (inline or in the detached waiter) -------------------------------
function Invoke-AutomationJob {
    param([string]$JobFile)
    $job = Read-JsonFile -Path $JobFile
    if (-not $job) { Log "job file unreadable: $JobFile"; return }
    $a = $job.automation; $name = "$($a.name)"; $runId = "$($job.run_id)"; $logPath = "$($job.log)"
    if ($job.fake_now -and -not $env:BOTCORP_FAKE_NOW) { $env:BOTCORP_FAKE_NOW = "$($job.fake_now)" }
    $timeoutMin = Num $a.timeout_min 20
    if ($timeoutMin -le 0) { $timeoutMin = 20 }
    try { $ld = Split-Path $logPath -Parent; if (-not (Test-Path $ld)) { New-Item -ItemType Directory -Force -Path $ld | Out-Null } } catch {}

    # env: bot env + run identity + vault secrets by name (Windows env names
    # are case-insensitive; injected as the key upper-cased).
    $envMap = @{
        BOT_HOME = $P.BotHome; BOT_NAME = $Bot; BOTCORP_HOME = $RtHome; BOTCORP_ROOT = $BotCorp
        CLAUDE_CONFIG_DIR = $P.ConfigDir; CLAUDE_PLUGIN_ROOT = $Harness; PYTHONIOENCODING = 'utf-8'
        BOT_MODULES = (@($job.modules) -join ','); BOT_AUTOMATION = $name; BOT_RUN_ID = $runId
        GIT_TERMINAL_PROMPT = '0'; GCM_INTERACTIVE = 'never'
    }
    $secretNames = @(); try { $secretNames = @($a.secrets | Where-Object { $_ }) } catch {}
    if ($secretNames.Count -gt 0) {
        try {
            . (Join-Path $PSScriptRoot 'vault.ps1')
            foreach ($k in $secretNames) {
                $v = $null
                try { $v = Get-VaultSecret -BotHome $P.BotHome -Bot $Bot -Key "$k" } catch { Log "run ${name}: vault key '$k' unreadable - re-enter it with: botcorp secrets set $Bot $k" }
                if ($v) { $envMap["$k".ToUpperInvariant()] = $v } else { Log "run ${name}: vault key '$k' missing" }
            }
        } catch { Log "run ${name}: vault unavailable ($($_.Exception.Message))" }
        $ErrorActionPreference = 'Continue'   # vault.ps1 sets Stop for itself
    }

    $start = Get-DaemonNow
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $exit = $null; $timedOut = $false
    $proc = $null
    try {
        $psi = [System.Diagnostics.ProcessStartInfo]::new()
        $psi.FileName = $(if ($env:ComSpec) { $env:ComSpec } else { 'cmd.exe' })
        # cmd.exe does the redirect itself: no pipe to drain, no deadlock on a
        # chatty job. /s strips the outer quotes; the command runs verbatim,
        # grouped: without the parentheses a chained `a & b` / `a && b` sent
        # only b's output to the log. The exit code is the group's (its last command).
        $psi.Arguments = "/d /s /c `"($($a.command)) > `"$logPath`" 2>&1`""
        $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
        $psi.WorkingDirectory = $P.BotHome
        foreach ($k in $envMap.Keys) { $psi.Environment[[string]$k] = [string]$envMap[$k] }
        $proc = [System.Diagnostics.Process]::Start($psi)
        if ($proc.WaitForExit([int]($timeoutMin * 60000))) { $exit = $proc.ExitCode }
        else { $timedOut = $true; try { $proc.Kill($true) } catch {}; try { & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $proc.Id /T /F 2>$null | Out-Null } catch {}; $exit = 124 }
    } catch { Log "run ${name}: launch failed: $($_.Exception.Message)"; $exit = 127; try { "launch failed: $($_.Exception.Message)" | Out-File -FilePath $logPath -Append -Encoding utf8 } catch {} }
    finally { if ($proc) { $proc.Dispose() } }
    $sw.Stop()
    $end = $(if ($env:BOTCORP_FAKE_NOW) { $start } else { Get-Date })
    $durationS = [Math]::Round($sw.Elapsed.TotalSeconds, 1)
    foreach ($k in $secretNames) { $envMap.Remove("$k".ToUpperInvariant()) }

    # summary: first `SUMMARY:` line, else the last non-empty line, 200 chars.
    $summary = ''
    try {
        $lines = @(Get-Content $logPath -ErrorAction SilentlyContinue)
        $s = $lines | Where-Object { "$_".TrimStart().StartsWith('SUMMARY:') } | Select-Object -First 1
        if (-not $s) { $s = $lines | Where-Object { "$_".Trim() } | Select-Object -Last 1 }
        if ($s) { $summary = "$s".Trim() }
    } catch {}
    if ($timedOut -and -not $summary.StartsWith('SUMMARY:')) { $summary = "TIMEOUT after ${timeoutMin} min (tree killed)" + $(if ($summary) { "; last: $summary" } else { '' }) }
    if ($summary.Length -gt 200) { $summary = $summary.Substring(0, 200) }

    $rec = [ordered]@{ automation = $name; run_id = $runId; start = (ToIso $start); end = (ToIso $end); exit = $exit; duration_s = $durationS; summary = $summary; log = $logPath }
    try { ($rec | ConvertTo-Json -Compress -Depth 3) | Out-File -FilePath $RunsFile -Append -Encoding utf8 } catch { Log "runs.jsonl append failed: $($_.Exception.Message)" }

    Use-AutoState {
        param($st)
        if (-not $st.ContainsKey($name)) { $st[$name] = @{} }
        $e = $st[$name]
        $e['last_end'] = ToIso $end; $e['last_exit'] = $exit; $e['last_run_id'] = $runId; $e['last_duration_s'] = $durationS; $e['last_summary'] = $summary
        $e['running_run_id'] = $null; $e['running_pid'] = $null; $e['running_since'] = $null
        if ($exit -eq 0) {
            $e['failure_streak'] = 0; $e['last_ok'] = ToIso $end; $e['backoff_min'] = $null
            $e['next_due'] = Get-NextDueAfterSuccess -A $a -T $end
        } else {
            $streak = [int](Num $e['failure_streak'] 0) + 1
            $base = Num $a.backoff.base_min 10; $max = Num $a.backoff.max_min 240
            if ($base -le 0) { $base = 10 }; if ($max -lt $base) { $max = $base }
            $gap = [Math]::Min($base * [Math]::Pow(2, $streak - 1), $max)
            $nd = $end.AddMinutes($gap)
            $e['failure_streak'] = $streak; $e['backoff_min'] = $gap; $e['next_due'] = ToIso $nd
            $hist = @(); if ($e.ContainsKey('backoff_history') -and $e['backoff_history']) { $hist = @($e['backoff_history']) }
            $hist += [ordered]@{ at = (ToIso $end); streak = $streak; gap_min = $gap; next_due = (ToIso $nd) }
            if ($hist.Count -gt 10) { $hist = @($hist | Select-Object -Last 10) }
            $e['backoff_history'] = $hist
        }
    }
    Log "run $name $runId exit=$exit ${durationS}s: $summary" -Quiet
}

if ($ExecJob) {
    try { Invoke-AutomationJob -JobFile $ExecJob } catch { Log "waiter failed (fail-open): $($_.Exception.Message)" }
    try { Remove-Item $ExecJob -Force -ErrorAction SilentlyContinue } catch {}
    exit 0
}

# --- scheduler -----------------------------------------------------------------------
$cfg = Get-BotConfig -Bot $Bot
if (-not $cfg) { exit 0 }
$autos = @($cfg.automations | Where-Object { $_ -and $_.name })
$now = Get-DaemonNow
$today = $now.ToString('yyyy-MM-dd')
$blocked = Test-BotAccountBlocked -Bot $Bot
$inline = @()

if ($autos.Count -gt 0 -or $RunNow) {
    Use-AutoState {
        param($st)
        foreach ($a in $autos) {
            $name = "$($a.name)"
            if ($RunNow -and $name -ne $RunNow) { continue }
            if (-not $st.ContainsKey($name)) { $st[$name] = @{} }
            $e = $st[$name]
            $enabled = -not (($a.PSObject.Properties.Name -contains 'enabled') -and ($a.enabled -eq $false))

            if ($e['running_run_id']) {
                $rp = [int](Num $e['running_pid'] 0)
                if ($rp -gt 0 -and (Test-ProcAlive $rp @('pwsh', 'powershell'))) { Log "$name still running (run $($e['running_run_id']), waiter pid $rp)" -Quiet; continue }
                Log "$name run $($e['running_run_id']) has no live waiter - clearing the record"
                $e['running_run_id'] = $null; $e['running_pid'] = $null; $e['running_since'] = $null
            }
            # A skip reason is logged once per change, not every 3-minute tick.
            if (-not $enabled) { if ("$($e['last_skip'])" -ne 'disabled') { Log "skip ${name}: disabled (enabled: false in bot.yaml)"; $e['last_skip'] = 'disabled' }; continue }
            if ("$($e['runs_today_date'])" -ne $today) { $e['runs_today'] = 0; $e['runs_today_date'] = $today }

            $trig = $a.trigger
            $due = $false; $reason = ''
            $eventName = $null; try { if ($trig.event) { $eventName = "$($trig.event)" } } catch {}
            if ($RunNow) { $due = $true; $reason = 'run-now' }
            elseif ($eventName) {
                $q = Join-Path $EventsDir "$eventName.queue"
                if ((Test-Path $q) -and ((Get-Item $q).Length -gt 0)) { $due = $true; $reason = "event $eventName queued" }
            } elseif ($e['next_due']) {
                $nd = FromIso $e['next_due']
                if ($nd -and $now -ge $nd) { $due = $true; $reason = "due since $($e['next_due'])" }
            } elseif ($trig.interval_min) { $due = $true; $reason = 'first run (interval)' }
            elseif ($trig.cron) {
                $n = Get-CronNext -Expr "$($trig.cron)" -From $now
                if ($n) { $e['next_due'] = ToIso $n; Log "$name scheduled: first cron match $($e['next_due'])" -Quiet } else { Log "$name has an invalid cron '$($trig.cron)' - never due" }
            }
            if (-not $due) { continue }

            $critical = (($a.PSObject.Properties.Name -contains 'critical') -and ($a.critical -eq $true))
            if ($blocked -and -not $critical) { if ("$($e['last_skip'])" -ne 'blocked') { Log "skip ${name}: account usage-blocked (accounts.json) and not critical"; $e['last_skip'] = 'blocked' }; continue }
            $maxPerDay = [int](Num $a.max_per_day 0)
            if ($maxPerDay -gt 0 -and [int](Num $e['runs_today'] 0) -ge $maxPerDay -and -not $RunNow) { if ("$($e['last_skip'])" -ne 'max_per_day') { Log "skip ${name}: max_per_day $maxPerDay reached ($($e['runs_today']) today)"; $e['last_skip'] = 'max_per_day' }; continue }
            $idleGated = (($a.PSObject.Properties.Name -contains 'idle_gated') -and ($a.idle_gated -eq $true))
            if ($idleGated -and (Test-SessionBusy -Bot $Bot)) { if ("$($e['last_skip'])" -ne 'busy') { Log "skip ${name}: idle_gated and the session is busy"; $e['last_skip'] = 'busy' }; continue }
            $e['last_skip'] = $null
            if ($DryRun) { Log "DRYRUN would run $name ($reason)"; continue }

            $runId = $now.ToString('yyyyMMdd-HHmmss') + '-' + ('{0:x4}' -f (Get-Random -Maximum 65535))
            $logPath = Join-Path (Join-Path $P.BotLogDir $name) "$runId.log"
            $job = [ordered]@{ bot = $Bot; run_id = $runId; automation = $a; modules = @($cfg._modules); log = $logPath; fake_now = $env:BOTCORP_FAKE_NOW; queued_at = (ToIso $now) }
            $jobFile = Join-Path $JobsDir "$runId.json"
            if (-not (Write-JsonFile -Path $jobFile -Object $job -Depth 8)) { Log "could not write job file for $name"; continue }
            if ($eventName) { try { Remove-Item (Join-Path $EventsDir "$eventName.queue") -Force -ErrorAction SilentlyContinue } catch {} }
            $e['runs_today'] = [int](Num $e['runs_today'] 0) + 1
            $e['last_start'] = ToIso $now; $e['running_run_id'] = $runId; $e['running_since'] = ToIso $now
            $timeoutMin = Num $a.timeout_min 20
            if ($timeoutMin -gt 0.5) {
                $wp = Start-Hidden -Exe (Resolve-PwshExe) -Arguments @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-Bot', $Bot, '-ExecJob', $jobFile) -WorkingDirectory $BotCorp
                $e['running_pid'] = $wp
                Log "run $name $runId ($reason) -> detached waiter pid $wp, timeout ${timeoutMin}m"
            } else {
                $e['running_pid'] = 0
                $script:inline += $jobFile
                Log "run $name $runId ($reason) -> inline, timeout ${timeoutMin}m"
            }
        }
    }
}

foreach ($jf in $inline) {
    try { Invoke-AutomationJob -JobFile $jf } catch { Log "inline run failed (fail-open): $($_.Exception.Message)" }
    try { Remove-Item $jf -Force -ErrorAction SilentlyContinue } catch {}
}

# --- retention + daily rollup ------------------------------------------------------------
try {
    if (Test-Path $P.BotLogDir) {
        foreach ($dir in (Get-ChildItem -Path $P.BotLogDir -Directory -ErrorAction SilentlyContinue)) {
            $files = @(Get-ChildItem -Path $dir.FullName -Filter '*.log' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime)
            if ($files.Count -eq 0) { continue }
            $cut = (Get-Date).AddDays(-14)
            foreach ($f in $files) { if ($f.LastWriteTime -lt $cut) { Remove-Item $f.FullName -Force -ErrorAction SilentlyContinue } }
            $files = @(Get-ChildItem -Path $dir.FullName -Filter '*.log' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime)
            $total = ($files | Measure-Object -Property Length -Sum).Sum
            $i = 0
            while ($total -gt 50MB -and $i -lt $files.Count) { $total -= $files[$i].Length; Remove-Item $files[$i].FullName -Force -ErrorAction SilentlyContinue; $i++ }
        }
    }
    if ((Test-Path $RunsFile) -and ((Get-Item $RunsFile).Length -gt 10MB)) { Move-Item -Force $RunsFile "$RunsFile.1"; Log 'runs.jsonl rotated at 10 MB' }
} catch { Log "retention failed (fail-open): $($_.Exception.Message)" }

try {
    $yesterday = $now.Date.AddDays(-1).ToString('yyyy-MM-dd')
    Use-AutoState {
        param($st)
        if (-not $st.ContainsKey('_meta')) { $st['_meta'] = @{} }
        if ("$($st['_meta']['rollup_done_for'])" -eq $yesterday) { return }
        $agg = @{}
        foreach ($f in @($RunsFile, "$RunsFile.1")) {
            if (-not (Test-Path $f)) { continue }
            foreach ($ln in (Get-Content $f -ErrorAction SilentlyContinue)) {
                if (-not $ln.Trim()) { continue }
                try { $r = $ln | ConvertFrom-Json } catch { continue }
                $d = FromIso $r.start
                if (-not $d -or $d.ToString('yyyy-MM-dd') -ne $yesterday) { continue }
                if (-not $agg.ContainsKey($r.automation)) { $agg[$r.automation] = @{ runs = 0; failures = 0; secs = 0.0 } }
                $g = $agg[$r.automation]; $g.runs++; if ($r.exit -ne 0) { $g.failures++ }; $g.secs += (Num $r.duration_s 0)
            }
        }
        if ($agg.Count -gt 0) {
            $csv = Join-Path (Join-Path $P.BotHome 'memory\metrics') 'automations.csv'
            $cd = Split-Path $csv -Parent
            if (-not (Test-Path $cd)) { New-Item -ItemType Directory -Force -Path $cd | Out-Null }
            if (-not (Test-Path $csv)) { 'date,automation,runs,failures,avg_s' | Out-File -FilePath $csv -Encoding utf8 }
            foreach ($k in ($agg.Keys | Sort-Object)) { $g = $agg[$k]; "$yesterday,$k,$($g.runs),$($g.failures),$([Math]::Round($g.secs / [Math]::Max(1, $g.runs), 1))" | Out-File -FilePath $csv -Append -Encoding utf8 }
            Log "daily rollup for $yesterday appended ($($agg.Count) automations) -> memory/metrics/automations.csv" -Quiet
        }
        $st['_meta']['rollup_done_for'] = $yesterday
    }
} catch { Log "rollup failed (fail-open): $($_.Exception.Message)" }

exit 0
