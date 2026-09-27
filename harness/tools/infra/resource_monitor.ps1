# resource_monitor.ps1 — local resource + stray-process janitor for a bot box.
#
# Intent: baseline = ONLY the bot + what it needs should be running. This
# watches for the bot's OWN exhaust (stray automation browsers, abandoned
# dev/test procs, duplicate pollers) and reports/cleans it. It NEVER touches
# the operator's own apps, work, or games — only bot-spawned automation.
#
# Usage:  pwsh -File tools/infra/resource_monitor.ps1 [-Clean]
#   -Clean : auto-kill stray agent-browser "Chrome for Testing" orphans (safe:
#            isolated browser, no user data). Other strays are reported, not killed.
# Output: one compact JSON object on stdout. Fail-open (errors never throw).
#
# Paths: everything below is parametrized off $env:BOT_HOME (the bot repo —
# BOT_HOME > CLAUDE_PROJECT_DIR > cwd), $env:BOTCORP_HOME / $env:CLAUDE_CONFIG_DIR
# (Claude Code's own state, for the transcript prune) and $env:BOT_PYTHON /
# $env:BOT_HAS_TG-style env — never a hardcoded user profile path.

param(
  [switch]$Clean,
  [switch]$Tg,                 # self-alert to TG on warn/critical (cooldown dedup)
  [int]$AbKillThreshold = 30,  # total agent-browser chrome cap: 1 live session = 11-12 procs, so warn only past ~2 sessions (33-proc orphan pile still trips)
  [int]$AbMaxAgeMin = 20,      # ab.sh heartbeat staleness (min) past which a still-alive agent-browser pile is treated as ABANDONED and reaped. ab.sh AB_TIMEOUT is 90s, so 20m idle = nobody's driving it.
  [int]$TestMaxAgeMin = 60,    # age past which a `node --test` / `tsx --test` proc is treated as HUNG — a fast suite that never exits looks exactly like a passing run.
  [int]$TgCooldownH = 6,       # don't re-alert the SAME issue set within this many hours
  [double]$DupBridgeMinMin = 10, # how long TWO procs must have held the SAME tg-enable settings file before it is a warn. A launch overlap or a scratch bot lasts minutes; a real dual-poller keeps 409-ing and ages past this by the next tick.
  [double]$DevSrvMaxAgeH = 4   # age past which a `wrangler dev`/vite/next dev server counts as left-behind. Count thresholds can't see these (a wrangler dev tree is only 3 node procs) — one has been seen running for DAYS on --remote.
)

$ErrorActionPreference = 'SilentlyContinue'
$issues  = @()
$actions = @()

# --- path seam: bot repo, Claude Code config home, python interpreter ---
$BotHome = if ($env:BOT_HOME) { $env:BOT_HOME } elseif ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { (Get-Location).Path }
$ConfigHome = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $env:USERPROFILE '.claude' }
# This script lives at <harness>/tools/infra/resource_monitor.ps1; the sibling
# tg_send.py lives at <harness>/tools/tg/tg_send.py — a SIBLING TOOL, so it is
# resolved off the harness root (two parents up from this script), not BotHome.
$HarnessRoot = if ($env:CLAUDE_PLUGIN_ROOT) { $env:CLAUDE_PLUGIN_ROOT } else { Split-Path (Split-Path $PSScriptRoot -Parent) -Parent }

# Python resolution: BOT_PYTHON > py launcher (session-0 / Scheduled-Task PATH
# can lack a bare python3/python entirely, but the py launcher is a stock
# install) > a real python.exe on PATH not the WindowsApps execution-alias
# stub > 'python3'/'python' as a last resort.
function Resolve-Py {
  if ($env:BOT_PYTHON) { return $env:BOT_PYTHON }
  foreach ($launcher in @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Python\Launcher\py.exe'),
    (Join-Path $env:SystemRoot 'py.exe')
  )) {
    if ($launcher -and (Test-Path $launcher)) {
      try {
        $resolved = (& $launcher -3 -c 'import sys; print(sys.executable)' 2>$null | Select-Object -Last 1)
        if ($resolved -and (Test-Path $resolved)) { return $resolved }
      } catch {}
    }
  }
  $cmd = Get-Command python.exe -ErrorAction SilentlyContinue | Where-Object { $_.Source -notlike '*WindowsApps*' } | Select-Object -First 1
  if ($cmd) { return $cmd.Source }
  if (Get-Command python3 -ErrorAction SilentlyContinue) { return 'python3' }
  return 'python'
}
$Py = Resolve-Py

function Add-Issue($sev,$cat,$detail){ $script:issues += ,([ordered]@{ sev=$sev; cat=$cat; detail=$detail }) }

# --- the duplicate-bridge decision, lifted out so a test can drive it --------
# Live process ages cannot be faked on a box (you cannot make a real claude.exe
# two hours old), so the rule itself is the unit: given the ages in minutes of
# every proc holding ONE tg-enable settings file, is this a standing duplicate?
# 'held' is the SECOND-oldest age = how long the file has had two holders, which
# is the thing that must persist. See the dual-poller section below for why.
function Get-BridgeHolderKey {
  # '' when this command line does not hold a Telegram bridge, else the group it
  # holds: the --settings tg-enable file, or '(default)' for a bare --channels
  # shape. The FLAG forms only, never a loose mention of the path — a headless
  # claude carries its own PROMPT in argv, and a triage tick whose prompt quotes
  # this very warning (settings path and all) would otherwise count itself as a
  # second holder of its own bridge. A check its own alert text can trip is a
  # loop.
  # A `claude --bg-pty-host <pipe> ... -- claude <argv>` wrapper (the
  # background session host) repeats its child's argv verbatim, so one session
  # can read as two holders. The child holds the bridge; the wrapper never does.
  param([string]$CommandLine)
  if ($CommandLine -match '--bg-pty-host') { return '' }
  if ($CommandLine -match '--settings\s+"?([^"\s]+tg-enable\.settings\.json)') { return $matches[1].ToLower() }
  if ($CommandLine -match '--channels\s+"?plugin:telegram') { return '(default)' }
  return ''
}

function Get-BridgeVerdict {
  param([double[]]$Ages, [double]$MinMin)
  $s = @(@($Ages) | Sort-Object -Descending)
  if ($s.Count -le 1) { return [pscustomobject]@{ verdict = 'none'; count = $s.Count; held = 0.0 } }
  $held = [math]::Round($s[1], 1)
  [pscustomobject]@{ verdict = $(if ($held -ge $MinMin) { 'dup' } else { 'young' }); count = $s.Count; held = $held }
}

# --- reap helper: kill a set, VERIFY, and return what SURVIVED ---------------
# A -Clean branch that Add-Issue's 'warn' BEFORE the kill pages for a condition
# the janitor already remediated. Box health is the bot's own job to fix, not
# the operator's to read: a warn from a -Clean run should mean "the kill did
# not work", which is the only part of this a human can act on.
# Accepts CIM Win32_Process objects; -Tree uses taskkill /T for procs whose
# children do not match the finder (test runners, dev servers).
function Invoke-Reap {
  param($Set, [switch]$Tree)
  foreach ($p in @($Set)) {
    if ($Tree) { & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $($p.ProcessId) /T /F 2>&1 | Out-Null }
    else       { Stop-Process -Id $p.ProcessId -Force -EA SilentlyContinue }
  }
  Start-Sleep -Milliseconds 400
  $alive = @{}
  Get-Process -EA SilentlyContinue | ForEach-Object { $alive[$_.Id] = $true }
  return @(@($Set) | Where-Object { $alive[[int]$_.ProcessId] })
}

# --- GPU (NVIDIA) ---
$gpu = $null
$smi = "$env:SystemRoot\System32\nvidia-smi.exe"
if (Test-Path $smi) {
  try {
    $g = (& $smi --query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>$null) -split ','
    if ($g.Count -ge 4) {
      $gpu = [ordered]@{ util=[int]$g[0].Trim(); temp=[int]$g[1].Trim(); mem_used_mb=[int]$g[2].Trim(); mem_total_mb=[int]$g[3].Trim() }
      # GPU temp is TELEMETRY ONLY — high temp may be the operator's own
      # games/work, not the bot, and that's fine. The bot-attributable runaway
      # signal is a stray browser/test/dev-server proc (detected below), not
      # temperature on its own.
    }
  } catch {}
}

# --- agent-browser "Chrome for Testing" orphans (bot's automation browser) ---
# Orphan = an agent-browser chrome whose PARENT process is gone (daemon/root
# chrome died without teardown). A raw proc COUNT is the wrong signal: one
# healthy live session spawns 11+ children, which trips false "orphan pile"
# warns — and with -Clean would kill a session mid-use. $AbKillThreshold is
# kept as a belt-and-braces cap on TOTAL procs (a huge pile is suspect even
# with live parents — e.g. the daemon itself is leaking sessions).
$abAll = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -EA SilentlyContinue |
         Where-Object { $_.ExecutablePath -like '*\.agent-browser\*' }
$abCount = @($abAll).Count
$abMem = 0
if ($abCount -gt 0) {
  $livePids = @{}
  Get-Process -EA SilentlyContinue | ForEach-Object { $livePids[$_.Id] = $true }
  $orphans = @($abAll | Where-Object { -not $livePids[[int]$_.ParentProcessId] })
  $mem = { param($set) if (@($set).Count) { [math]::Round((($set | Measure-Object WorkingSetSize -Sum).Sum)/1MB,0) } else { 0 } }
  $abMem = & $mem $abAll
  # Activity heartbeat written by ab.sh (tools/browser/ab.sh -> $AB_HEARTBEAT) on
  # every browser op. FRESH stamp = a session in active use → spare it (this is
  # what prevents a mid-use kill). STALE/MISSING = a pile ab.sh opened and never
  # closed → reap it whole (root+children). Killing only parent-DEAD procs would
  # leak an abandoned-but-alive session unbounded.
  $hbFile = Join-Path $env:USERPROFILE '.agent-browser\.botcorp_activity'
  $hbAgeMin = 999999
  if (Test-Path $hbFile) { $hbAgeMin = [math]::Round((New-TimeSpan -Start (Get-Item $hbFile).LastWriteTime -End (Get-Date)).TotalMinutes,1) }
  $stale = $hbAgeMin -ge $AbMaxAgeMin

  if (@($orphans).Count -gt 0) {
    $oMem = & $mem $orphans
    if ($Clean) {
      $left = Invoke-Reap $orphans
      $gone = @($orphans).Count - @($left).Count
      if ($gone -gt 0) { $actions += "killed $gone orphaned agent-browser Chrome procs (${oMem}MB freed)" }
      if (@($left).Count -gt 0) { Add-Issue 'warn' 'browser' "$(@($left).Count) orphaned agent-browser Chrome procs SURVIVED -Clean (parent dead) of $abCount total" }
      else { Add-Issue 'info' 'browser' "cleaned $gone orphaned agent-browser Chrome procs ($oMem MB, parent dead) of $abCount total" }
    } else {
      Add-Issue 'warn' 'browser' "$(@($orphans).Count) orphaned agent-browser Chrome procs ($oMem MB, parent dead) of $abCount total"
    }
  } elseif ($stale) {
    if ($Clean) {
      $left = Invoke-Reap $abAll
      $gone = $abCount - @($left).Count
      if ($gone -gt 0) { $actions += "reaped $gone abandoned agent-browser Chrome procs (${abMem}MB freed, idle ${hbAgeMin}m)" }
      if (@($left).Count -gt 0) { Add-Issue 'warn' 'browser' "$(@($left).Count) of $abCount abandoned agent-browser Chrome procs SURVIVED -Clean (idle ${hbAgeMin}m)" }
      else { Add-Issue 'info' 'browser' "reaped $gone abandoned agent-browser Chrome procs ($abMem MB, idle ${hbAgeMin}m >= ${AbMaxAgeMin}m)" }
    } else {
      Add-Issue 'warn' 'browser' "$abCount agent-browser Chrome procs ($abMem MB) — idle ${hbAgeMin}m (>= ${AbMaxAgeMin}m, no ab.sh activity) = abandoned session"
    }
  } elseif ($abCount -gt $AbKillThreshold) {
    Add-Issue 'warn' 'browser' "$abCount agent-browser Chrome procs ($abMem MB) — heartbeat fresh (${hbAgeMin}m) but pile > $AbKillThreshold; possible leak in an ACTIVE session (not auto-killed while in use)"
  } else {
    Add-Issue 'info' 'browser' "$abCount agent-browser Chrome procs ($abMem MB) — live session (idle ${hbAgeMin}m)"
  }
}

# --- agent-browser DAEMON orphans (the binary itself, not its Chrome) ---
# The block above only ever looks at chrome.exe, so the agent-browser daemon
# process is never a reap candidate there. A daemon can survive DAYS with a
# dead parent and zero Chrome children before anyone notices by hand.
# Same orphan rule as above — parent gone = nobody is driving it — and a
# daemon with no Chrome left is finished by definition.
$abDaemons = @(Get-CimInstance Win32_Process -EA SilentlyContinue |
               Where-Object { $_.Name -like 'agent-browser-*' })
if (@($abDaemons).Count -gt 0) {
  $liveNow = @{}
  Get-Process -EA SilentlyContinue | ForEach-Object { $liveNow[$_.Id] = $true }
  # Reap a daemon only when its parent is dead AND it has no Chrome of its own
  # still running — never touch the daemon behind a live session.
  #
  # Re-query Chrome LIVE rather than reusing $abCount from before the block
  # above. $abCount is the PRE-clean count, so after a whole-pile reap the
  # daemon that owned the pile is childless right now but still looked busy,
  # and its reap would slip to the next tick — one condition, two alerts an
  # hour apart. One tick should leave the box clean.
  $abLive = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -EA SilentlyContinue |
              Where-Object { $_.ExecutablePath -like '*\.agent-browser\*' }).Count
  $abDaemonOrphans = @($abDaemons | Where-Object {
    (-not $liveNow[[int]$_.ParentProcessId]) -and $abLive -eq 0
  })
  if (@($abDaemonOrphans).Count -gt 0) {
    if ($Clean) {
      $left = Invoke-Reap $abDaemonOrphans
      $gone = @($abDaemonOrphans).Count - @($left).Count
      if ($gone -gt 0) { $actions += "killed $gone orphaned agent-browser daemon procs" }
      if (@($left).Count -gt 0) { Add-Issue 'warn' 'browser' "$(@($left).Count) orphaned agent-browser daemon procs SURVIVED -Clean (parent dead, no Chrome children)" }
      else { Add-Issue 'info' 'browser' "killed $gone orphaned agent-browser daemon procs (parent dead, no Chrome children)" }
    } else {
      Add-Issue 'warn' 'browser' "$(@($abDaemonOrphans).Count) orphaned agent-browser daemon procs (parent dead, no Chrome children)"
    }
  }
}

# --- hung test-runner trees (node --test / tsx --test) ---
# THE OUTPUT LOOKS LIKE A SUCCESSFUL RUN, which is why a hung suite can sit
# unnoticed for days. Node's test runner waits for the event loop to drain, so
# a suite that PASSES while leaving a handle open (a server, an interval, a
# watcher) prints every green checkmark and then sits there forever. The other
# shape — a test that never settles — hangs with no default timeout.
#
# AGE IS THE SIGNAL, NOT EXISTENCE. A test run is supposed to be here; a fast
# suite finishes in seconds. An hour means it is not running, it is stuck.
# Matching on '--test' in the command line keeps this off any long-lived
# harness worker processes, which never carry that flag.
$testProcs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -EA SilentlyContinue |
  Where-Object { $_.CommandLine -match '(^|\s)--test(\s|$|=)' })
$hungTests = @($testProcs | Where-Object {
  $started = $null
  try { $started = $_.CreationDate } catch {}
  $started -and ((Get-Date) - $started).TotalMinutes -ge $TestMaxAgeMin
})
if (@($hungTests).Count -gt 0) {
  $tMem = [math]::Round((($hungTests | Measure-Object WorkingSetSize -Sum).Sum) / 1MB)
  $oldest = [math]::Round((($hungTests | ForEach-Object { ((Get-Date) - $_.CreationDate).TotalHours } | Measure-Object -Maximum).Maximum), 1)
  if ($Clean) {
    # /T because the runner spawns a child per test file and those children do
    # NOT carry --test in their own command lines, so killing only the matches
    # would orphan the workers that hold most of the memory.
    $left = Invoke-Reap $hungTests -Tree
    $gone = @($hungTests).Count - @($left).Count
    if ($gone -gt 0) { $actions += "reaped $gone hung test-runner procs (${tMem}MB freed, oldest ${oldest}h)" }
    if (@($left).Count -gt 0) { Add-Issue 'warn' 'tests' "$(@($left).Count) hung test-runner proc(s) SURVIVED -Clean (oldest ${oldest}h >= ${TestMaxAgeMin}m)" }
    else { Add-Issue 'info' 'tests' "reaped $gone hung test-runner procs ($tMem MB, oldest ${oldest}h)" }
  } else {
    Add-Issue 'warn' 'tests' "$(@($hungTests).Count) hung test-runner proc(s) ($tMem MB, oldest ${oldest}h >= ${TestMaxAgeMin}m) — a passing suite that never exited looks exactly like this"
  }
}

# --- duplicate bot sessions / pollers (single-poller invariant) ---
# ASK THE QUESTION THE CHECK IS ACTUALLY FOR: does more than one process hold
# the Telegram poll slot? That is decided by how a claude was LAUNCHED, not by
# how many exist — a headless worker cannot dual-poll no matter who spawned it.
#
# A plain process COUNT is the wrong signal: any harness feature that spawns a
# claude per sub-task (a review pass, a build lane) can legitimately put
# several claude procs on the box at once, and a monitor that alarms on that
# is a warning nobody reads ([[enumerations-rot]]).
#
# Two launch shapes can start the bridge: an explicit `--channels
# plugin:telegram@…`, and a `--settings` pointing at a tracked tg-enable file,
# since current CC auto-starts the bridge from `enabledPlugins` in ANY loaded
# settings file. Match both. A claude started with neither is a worker, and is
# reported as info so the count stays visible without being an alarm.
#
# The residual case — a bridge enabled through some other settings path — is
# what the TG watchdog's getUpdates-409 probe is for; this check does not need
# to be the last line of defence, it needs to stop crying wolf.
#
# One slot PER BOT TOKEN, not per box: a second bot instance on the same
# machine, with its own token, legitimately holds its own bridge. Group by the
# --settings file (one per bot instance; bare --channels with no --settings is
# this bot's own default shape) and warn only when ONE group has more than one
# holder.
#
# AGE, not the instant. A duplicate that matters is one that PERSISTS: two
# sessions polling one token keep 409-ing until someone stops one. A duplicate
# that lives for minutes is a launch overlap, or a scratch/probe bot spun up
# and torn down the same hour — paging for either is a page nobody can act on.
# So: warn only when at least two holders of one group have been alive >=
# $DupBridgeMinMin (the second-oldest age is exactly that test — see
# Get-BridgeVerdict above), and report a younger duplicate as info so it stays
# visible without alarming. A real dual-poller is still caught — one tick
# later, by which time it has aged into the warn. The last line of defence
# remains the TG watchdog's getUpdates-409 probe, as above.
$allClaude = @(Get-Process -Name claude -EA SilentlyContinue)
$claudeCount = 0
$bridgeGroups = @{}   # settings file -> ages in minutes of the procs holding it
if ($allClaude.Count -gt 0) {
  $byPid = @{}
  Get-CimInstance Win32_Process -Filter "Name='claude.exe'" -EA SilentlyContinue |
    ForEach-Object { $byPid[[int]$_.ProcessId] = $_ }
  foreach ($c in $allClaude) {
    $p  = $byPid[[int]$c.Id]
    $grp = Get-BridgeHolderKey ([string]$p.CommandLine)
    if ($grp) {
      $claudeCount++
      # No CreationDate (a proc that vanished between the two queries) = age 0:
      # unknown never promotes a duplicate to a warn.
      $age = 0.0
      try { if ($p.CreationDate) { $age = ((Get-Date) - $p.CreationDate).TotalMinutes } } catch {}
      # Seed the list explicitly: `@($null) + ,$age` is a TWO-element array whose
      # first item is $null, which made every single holder look like a pair.
      if (-not $bridgeGroups.ContainsKey($grp)) { $bridgeGroups[$grp] = @() }
      $bridgeGroups[$grp] = @($bridgeGroups[$grp]) + ,[double]$age
    }
  }
}
$claudeWorkers = $allClaude.Count - $claudeCount
foreach ($g in $bridgeGroups.Keys) {
  $v = Get-BridgeVerdict -Ages @($bridgeGroups[$g]) -MinMin $DupBridgeMinMin
  if ($v.verdict -eq 'dup') {
    Add-Issue 'warn' 'bot' "$($v.count) claude procs hold the SAME TG bridge ($g), 2+ of them for $($v.held)m — duplicate session / dual-poller risk"
  } elseif ($v.verdict -eq 'young') {
    Add-Issue 'info' 'bot' "$($v.count) claude procs hold the SAME TG bridge ($g) but only for $($v.held)m — launch overlap or scratch bot; warns past ${DupBridgeMinMin}m"
  }
}
if ($claudeWorkers -gt 0) { Add-Issue 'info' 'bot' "$claudeWorkers headless claude worker(s) — no TG bridge, cannot dual-poll" }

# --- stray node dev servers (vite left running) ---
$nodeCount = @(Get-Process -Name node -EA SilentlyContinue).Count
if ($nodeCount -gt 4) { Add-Issue 'info' 'node' "$nodeCount node procs — possible stray vite/dev servers" }

# --- long-lived dev servers (wrangler dev / vite / next), AGE not count ---
# A count threshold cannot see these: a `wrangler dev --remote` tree is only 3
# node procs, so it can sit under a >4-proc rule for days holding a live
# connection. Age is the correct signal — nobody legitimately leaves a dev
# server up for hours unattended.
$devSrvMaxAgeH = $DevSrvMaxAgeH
$devServers = @(Get-CimInstance Win32_Process -EA SilentlyContinue |
  Where-Object {
    $_.Name -match '^node(\.exe)?$' -and $_.CommandLine -and
    $_.CommandLine -match '(wrangler(\.js)?\s+dev|vite(\s|$)|next\s+dev)' -and
    # the cockpit's own long-running server is legitimate — never flag it
    $_.CommandLine -notmatch 'cockpit[/\\]server\.mjs'
  })
if (@($devServers).Count -gt 0) {
  $nowT = Get-Date
  $staleSrv = @($devServers | Where-Object {
    $_.CreationDate -and (New-TimeSpan -Start $_.CreationDate -End $nowT).TotalHours -ge $devSrvMaxAgeH
  })
  if (@($staleSrv).Count -gt 0) {
    $oldestH = [math]::Round((($staleSrv | ForEach-Object { (New-TimeSpan -Start $_.CreationDate -End $nowT).TotalHours } | Measure-Object -Maximum).Maximum),1)
    if ($Clean) {
      # /T so the workerd + esbuild children go with it; a bare Stop-Process
      # orphans them.
      $left = Invoke-Reap $staleSrv -Tree
      $gone = @($staleSrv).Count - @($left).Count
      if ($gone -gt 0) { $actions += "killed $gone stale dev server tree(s) (oldest ${oldestH}h)" }
      if (@($left).Count -gt 0) { Add-Issue 'warn' 'node' "$(@($left).Count) stale dev server proc(s) SURVIVED -Clean (up to ${oldestH}h >= ${devSrvMaxAgeH}h)" }
      else { Add-Issue 'info' 'node' "killed $gone stale dev server tree(s) (oldest ${oldestH}h >= ${devSrvMaxAgeH}h)" }
    } else {
      Add-Issue 'warn' 'node' "$(@($staleSrv).Count) stale dev server proc(s) running up to ${oldestH}h (>= ${devSrvMaxAgeH}h) — left behind by a CLI run"
    }
  }
}

# --- system RAM ---
$memPct = $null
try {
  $os = Get-CimInstance Win32_OperatingSystem -EA SilentlyContinue
  if ($os) {
    $memPct = [math]::Round(100*(1-($os.FreePhysicalMemory/$os.TotalVisibleMemorySize)),0)
    if ($memPct -ge 92) { Add-Issue 'warn' 'mem' "RAM ${memPct}% used" }
  }
} catch {}

# --- C: free space (low disk breaks bot writes/hooks/journal directly) ---
$cFreeGb = $null
try {
  $cd = Get-PSDrive C -EA SilentlyContinue
  if ($cd) {
    $cFreeGb = [math]::Round($cd.Free/1GB,1)
    if     ($cFreeGb -lt 3) { Add-Issue 'critical' 'disk' "C: only ${cFreeGb}GB free — bot writes will start failing (clear cache / free space)" }
    elseif ($cFreeGb -lt 8) { Add-Issue 'warn'     'disk' "C: ${cFreeGb}GB free — low, clean up soon" }
  }
} catch {}

# --- CC transcript retention (disk hygiene): prune raw session logs > 7d ---
# Raw CC transcripts (*.jsonl + per-session tool-results dirs) under every
# project this bot (or any bot sharing this Claude Code config) has opened are
# pure logs — a fresh session picks up context from the journal/timeline
# handoff, not by resuming a week-old transcript — so old ones are dead
# weight. Keep 7d; NEVER touch a 'memory' subdirectory (auto-memory,
# load-bearing). Once/day (marker-guarded), only under -Clean. Fail-open.
if ($Clean) {
  try {
    $projectsDir = Join-Path $ConfigHome 'projects'
    # Per config home, never in the harness checkout: a shared stamp let one
    # bot's daily prune skip every other bot's, and dirtied the checkout.
    $stamp = Join-Path $ConfigHome '.botcorp_transcript_prune_stamp'
    $due = -not (Test-Path $stamp)
    if (-not $due) { if (((Get-Date) - (Get-Item $stamp).LastWriteTime).TotalHours -ge 24) { $due = $true } }
    if ($due -and (Test-Path $projectsDir)) {
      $cut = (Get-Date).AddDays(-7)
      $freed = 0; $n = 0
      foreach ($projDir in Get-ChildItem $projectsDir -Directory -EA SilentlyContinue) {
        Get-ChildItem $projDir.FullName -Filter *.jsonl -File -EA SilentlyContinue |
          Where-Object { $_.LastWriteTime -lt $cut } |
          ForEach-Object { $freed += $_.Length; $n++; Remove-Item $_.FullName -Force -EA SilentlyContinue }
        Get-ChildItem $projDir.FullName -Directory -EA SilentlyContinue |
          Where-Object { $_.Name -ne 'memory' -and $_.LastWriteTime -lt $cut } |
          ForEach-Object { Remove-Item $_.FullName -Recurse -Force -EA SilentlyContinue }
      }
      Set-Content -Path $stamp -Value ((Get-Date).ToUniversalTime().ToString('o')) -Encoding utf8 -EA SilentlyContinue
      if ($n -gt 0) { $actions += "pruned $n CC transcripts >7d ($([math]::Round($freed/1MB,0))MB) + old tool-result dirs" }
    }
  } catch {}
}

# --- session snapshot retention: memory/sessions/<stamp>.md > 7d -------------
# session_summarize.py (Stop / PreCompact) writes one snapshot per turn and
# nothing reads the old ones. Only those top-level YYYY-MM-DD_HHMMSS.md files,
# aged by the stamp in the name (a clone resets mtimes); never a
# memory/sessions/<id>/ folder (journal + timeline). Only under -Clean.
function Remove-OldSessionSnapshots {
  param([string]$Dir, [int]$Days = 7, [datetime]$Now = (Get-Date))
  $n = 0
  foreach ($f in @(Get-ChildItem -LiteralPath $Dir -Filter '*.md' -File -EA SilentlyContinue)) {
    if ($f.Name -notmatch '^(\d{4}-\d{2}-\d{2}_\d{6})\.md$') { continue }
    $at = [datetime]::MinValue
    if (-not [datetime]::TryParseExact($Matches[1], 'yyyy-MM-dd_HHmmss', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None, [ref]$at)) { continue }
    if ($at -lt $Now.AddDays(-$Days)) { Remove-Item -LiteralPath $f.FullName -Force -EA SilentlyContinue; $n++ }
  }
  return $n
}
if ($Clean) {
  try {
    $n = Remove-OldSessionSnapshots -Dir (Join-Path $BotHome 'memory\sessions')
    if ($n -gt 0) { $actions += "pruned $n session snapshots >7d" }
  } catch {}
}

# --- janitor audit trail -----------------------------------------------------
# A reap that no longer alerts must not become invisible: the caller often
# sends this script's JSON to Out-Null, so without this line a successful
# -Clean would leave no record anywhere that the box was touched.
# Local (under the bot's own memory/), append-only, never TG. Fail-open.
if ($Clean -and @($actions).Count -gt 0) {
  try {
    $janLog = Join-Path $BotHome 'memory\metrics\resource_janitor.log'
    New-Item -ItemType Directory -Force -Path (Split-Path $janLog -Parent) -EA SilentlyContinue | Out-Null
    $stampT = (Get-Date).ToUniversalTime().ToString('o')
    foreach ($a in @($actions)) { Add-Content -Path $janLog -Value "$stampT`t$a" -Encoding utf8 -EA SilentlyContinue }
  } catch {}
}

$worst = 'none'
foreach ($s in @('critical','warn','info')) { if ($issues | Where-Object { $_.sev -eq $s }) { $worst = $s; break } }

$result = [ordered]@{
  ts                   = (Get-Date).ToUniversalTime().ToString('o')
  gpu                  = $gpu
  agent_browser_chrome = $abCount
  agent_browser_mem_mb = $abMem
  claude_procs         = $claudeCount
  node_procs           = $nodeCount
  ram_pct              = $memPct
  c_free_gb            = $cFreeGb
  worst_severity       = $worst
  issue_count          = @($issues).Count
  issues               = @($issues)
  actions              = @($actions)
}

# --- optional TG self-alert (-Tg): warn/critical only, with same-issue cooldown ---
# The monitor alerts itself so the (durable) caller stays thin. Fail-open: a
# TG/state failure never throws and never blocks the JSON.
if ($Tg -and ($worst -in @('warn','critical'))) {
  try {
    $stateF = Join-Path $BotHome '.claude\.resource_monitor_state.json'
    $sig = (@($issues) | ForEach-Object { "$($_.sev):$($_.cat):$($_.detail)" }) -join '||'
    $now = (Get-Date).ToUniversalTime()
    $skip = $false
    if (Test-Path $stateF) {
      try {
        $prev = Get-Content $stateF -Raw | ConvertFrom-Json
        if ($prev.sig -eq $sig -and $prev.last) {
          if ((($now - [datetime]$prev.last)).TotalHours -lt $TgCooldownH) { $skip = $true }
        }
      } catch {}
    }
    if (-not $skip) {
      $lines = (@($issues) | ForEach-Object { "- [$($_.sev)] $($_.detail)" }) -join "`n"
      $msg = "Box health ($worst):`n$lines"
      $tgSend = Join-Path $HarnessRoot 'tools\tg\tg_send.py'
      $env:PYTHONIOENCODING = 'utf-8'
      # --alert: box health is the bot's own job to fix, not the operator's to
      # read. Stray browser/daemon procs are exactly the kind of thing that
      # should be cleaned up automatically, not pushed to a phone.
      & $Py $tgSend '--alert' $msg 2>$null | Out-Null
      @{ sig = $sig; last = $now.ToString('o') } | ConvertTo-Json | Out-File -FilePath $stateF -Encoding utf8
    }
  } catch {}
}

$result | ConvertTo-Json -Depth 6 -Compress
