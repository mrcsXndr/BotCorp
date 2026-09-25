# _common.ps1 - helpers shared by the daemon scripts. Dot-source it:
#
#   . (Join-Path $PSScriptRoot '_common.ps1')
#
# Everything here is fail-open: a helper returns $null / $false / 0 on error
# and never throws into the caller, because every caller is a tick that must
# always exit 0. Nothing here prints a secret; nothing here sends Telegram.
#
# Layout it assumes (one BotCorp checkout per machine):
#   <BotCorp>/daemon/          this folder
#   <BotCorp>/harness/         the Claude Code plugin (tools/, hooks/)
#   <BotCorp>/bots/<name>/     BOT_HOME; config home bots/<name>/.claude-<name>/
#   <BOTCORP_HOME>/            machine runtime (default ~/.botcorp): daemon.log,
#                              state/<bot>.json, state/<bot>.pty.json, logs/<bot>/
#
# Test seam: BOTCORP_FAKE_NOW=<ISO timestamp> overrides "now" for SCHEDULING
# decisions only (Get-DaemonNow). Log stamps, process ages and file mtimes
# stay real, so the seam cannot make a live process look dead.

Set-StrictMode -Off

$script:BotCorp   = Split-Path $PSScriptRoot -Parent
$script:BotsDir   = Join-Path $script:BotCorp 'bots'
$script:Harness   = Join-Path $script:BotCorp 'harness'
$script:RtHome    = if ($env:BOTCORP_HOME) { $env:BOTCORP_HOME } else { Join-Path $env:USERPROFILE '.botcorp' }
$script:StateDir  = Join-Path $script:RtHome 'state'
$script:LogsDir   = Join-Path $script:RtHome 'logs'
$script:DaemonLog = Join-Path $script:RtHome 'daemon.log'
# Children (pty-host, python tools, the automation waiter) must agree with us
# on the runtime root, so export the resolved value.
$env:BOTCORP_HOME = $script:RtHome

$BotCorp = $script:BotCorp; $BotsDir = $script:BotsDir; $Harness = $script:Harness
$RtHome = $script:RtHome; $StateDir = $script:StateDir; $LogsDir = $script:LogsDir; $DaemonLog = $script:DaemonLog

foreach ($d in @($script:RtHome, $script:StateDir, $script:LogsDir)) {
    try { if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null } } catch {}
}

# vault.ps1 (launch nonces, lock state, the one decrypt path) sets Stop for
# itself; every caller here is fail-open, so restore its preference.
$__eap = $ErrorActionPreference
. (Join-Path $PSScriptRoot 'vault.ps1')
$ErrorActionPreference = $__eap

# --- time ----------------------------------------------------------------------
function Get-DaemonNow {
    # BOTCORP_FAKE_NOW (ISO 8601) overrides scheduling time. Harmless when unset.
    if ($env:BOTCORP_FAKE_NOW) {
        try { return [datetime]::Parse($env:BOTCORP_FAKE_NOW, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind) } catch {}
    }
    return Get-Date
}

# --- logging -------------------------------------------------------------------
function Write-DaemonLog {
    # One line to <rt>/daemon.log; with -Bot also to <rt>/logs/<bot>/daemon.log
    # (that per-bot file is where the start cap counts ACTION=START lines).
    # Stamp format "yyyy-MM-ddTHH:mm:ss" + TWO spaces is load-bearing: the cap
    # splits on the double space and TryParses the stamp.
    param([string]$Message, [string]$Bot, [switch]$Quiet)
    $stamp = (Get-Date).ToString('s')
    $line = if ($Bot) { "$stamp  [$Bot] $Message" } else { "$stamp  $Message" }
    try { $line | Out-File -FilePath $script:DaemonLog -Append -Encoding utf8 } catch {}
    if ($Bot) {
        try {
            $bl = Join-Path (Join-Path $script:LogsDir $Bot) 'daemon.log'
            $bd = Split-Path $bl -Parent
            if (-not (Test-Path $bd)) { New-Item -ItemType Directory -Force -Path $bd | Out-Null }
            "$stamp  $Message" | Out-File -FilePath $bl -Append -Encoding utf8
        } catch {}
    }
    if (-not $Quiet) { Write-Host $line }
}

# --- json files ------------------------------------------------------------------
function Read-JsonFile {
    param([string]$Path)
    try {
        if (-not (Test-Path $Path)) { return $null }
        $raw = Get-Content $Path -Raw -ErrorAction Stop
        if (-not $raw -or -not $raw.Trim()) { return $null }
        return ($raw | ConvertFrom-Json -ErrorAction Stop)
    } catch { return $null }
}

function Write-JsonFile {
    # No BOM, trailing newline, parent dir created. Fail-open (returns $false).
    param([string]$Path, $Object, [int]$Depth = 8)
    try {
        $dir = Split-Path $Path -Parent
        if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        [System.IO.File]::WriteAllText($Path, (($Object | ConvertTo-Json -Depth $Depth) + "`n"))
        return $true
    } catch { return $false }
}

function ConvertTo-Hashtable {
    # PSCustomObject (from ConvertFrom-Json) -> hashtable, one level.
    param($Object)
    $h = @{}
    if ($null -eq $Object) { return $h }
    if ($Object -is [hashtable]) { foreach ($k in $Object.Keys) { $h[$k] = $Object[$k] }; return $h }
    foreach ($p in $Object.PSObject.Properties) { $h[$p.Name] = $p.Value }
    return $h
}

# --- processes -----------------------------------------------------------------
function Get-FirstPid {
    param([string]$Raw)
    if ($Raw -and ($Raw -match '\d+')) { return [int]$matches[0] }
    return 0
}

function Test-ProcAlive {
    # Alive AND (optionally) one of the expected process names (guards PID reuse).
    param([int]$ProcId, [string[]]$Names)
    if ($ProcId -le 0) { return $false }
    $p = Get-Process -Id $ProcId -ErrorAction SilentlyContinue
    if (-not $p) { return $false }
    if ($Names) { return ($Names -contains $p.ProcessName) }
    return $true
}

function Stop-ProcessTree {
    # taskkill /T /F: on Windows Stop-Process kills ONE process and leaves
    # claude.exe + the Telegram poller as orphans holding the getUpdates slot.
    # RAW primitive: daemon code calls Stop-BotProcessTree (ownership-guarded)
    # instead; this stays only as its implementation.
    param([int]$ProcId)
    if ($ProcId -le 0) { return $false }
    try { & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $ProcId /T /F 2>$null | Out-Null; return ($LASTEXITCODE -eq 0) } catch { return $false }
}

# --- ownership guard (every kill goes through this) -------------------------------
# A daemon once killed a process that was not its own (an operator's shell that
# merely looked like a launcher). Now a pid is OURS only when it is recorded in
# <rt>/state/<bot>.json / <bot>.pty.json (any bot), in daemon.json / otel.json
# (cockpit, sink), or its command line names <BotCorp>\bots\<name> for a bot
# that exists. Anything else is refused and logged. On top of that,
# <rt>/protect.json (operator-maintained) lists pids and command-line regex
# patterns that are never killed even when they look like ours.
function Get-ProtectedList {
    $pids = @(); $pats = @()
    try {
        $j = Read-JsonFile -Path (Join-Path $script:RtHome 'protect.json')
        if ($j) {
            try { if ($j.pids) { $pids = @($j.pids | ForEach-Object { [int]$_ }) } } catch {}
            try { if ($j.patterns) { $pats = @($j.patterns | Where-Object { "$_" }) } } catch {}
        }
    } catch {}
    return @{ Pids = $pids; Patterns = $pats }
}

function Get-ProcessOwnerRecord {
    # Returns @{ Ours; Protected; Bot; Reason; Name; CmdHead } for a pid.
    # Ours = recorded in a state file or command line under bots/<known bot>.
    # Protected = listed in protect.json (never kill, ours or not). Unknown /
    # dead pid -> Ours=$false so a wrong kill is impossible on an error path.
    param([Parameter(Mandatory)][int]$ProcId)
    $rec = @{ Ours = $false; Protected = $false; Bot = $null; Reason = 'not ours'; Name = '?'; CmdHead = '' }
    if ($ProcId -le 0) { $rec.Reason = 'pid <= 0'; return $rec }
    $wp = $null
    try { $wp = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcId" -ErrorAction Stop } catch {}
    if (-not $wp) { $rec.Reason = 'no such process'; return $rec }
    $rec.Name = "$($wp.Name)"
    $cmd = "$($wp.CommandLine)"
    $rec.CmdHead = $(if ($cmd.Length -gt 120) { $cmd.Substring(0, 120) + '...' } else { $cmd })
    try {
        $prot = Get-ProtectedList
        if ($prot.Pids -contains $ProcId) { $rec.Protected = $true; $rec.Reason = 'protect.json pid' }
        else { foreach ($pat in $prot.Patterns) { try { if ($cmd -match $pat) { $rec.Protected = $true; $rec.Reason = "protect.json pattern '$pat'"; break } } catch {} } }
    } catch {}
    if ($rec.Protected) { return $rec }
    try {
        foreach ($b in (Get-BotList)) {
            $st = Read-JsonFile -Path (Join-Path $script:StateDir "$b.json")
            if ($st) {
                foreach ($k in @('claude_pid', 'shell_pid', 'launcher_pid')) {
                    try { if (($st.PSObject.Properties.Name -contains $k) -and $null -ne $st.$k -and ([int]$st.$k -eq $ProcId)) { $rec.Ours = $true; $rec.Bot = $b; $rec.Reason = "state/$b.json $k"; return $rec } } catch {}
                }
            }
            $pty = Read-JsonFile -Path (Join-Path $script:StateDir "$b.pty.json")
            if ($pty) {
                foreach ($k in @('pid', 'ptyPid')) {
                    try { if (($pty.PSObject.Properties.Name -contains $k) -and $null -ne $pty.$k -and ([int]$pty.$k -eq $ProcId)) { $rec.Ours = $true; $rec.Bot = $b; $rec.Reason = "state/$b.pty.json $k"; return $rec } } catch {}
                }
            }
            if ($cmd -and ($cmd -match [regex]::Escape((Join-Path $script:BotsDir $b)))) { $rec.Ours = $true; $rec.Bot = $b; $rec.Reason = "command line names bots\$b"; return $rec }
        }
        $d = Read-JsonFile -Path (Join-Path $script:StateDir 'daemon.json')
        try { if ($d -and $d.cockpit_pid -and ([int]$d.cockpit_pid -eq $ProcId)) { $rec.Ours = $true; $rec.Reason = 'state/daemon.json cockpit_pid'; return $rec } } catch {}
        $o = Read-JsonFile -Path (Join-Path $script:StateDir 'otel.json')
        try { if ($o -and $o.pid -and ([int]$o.pid -eq $ProcId)) { $rec.Ours = $true; $rec.Reason = 'state/otel.json pid'; return $rec } } catch {}
    } catch { $rec.Reason = "owner lookup failed: $($_.Exception.Message)" }
    return $rec
}

function Stop-BotProcessTree {
    # The ONE guarded kill. Refuses (and logs `SKIP not ours` / `SKIP protected`)
    # unless Get-ProcessOwnerRecord says the pid is ours. Returns $true only
    # when a kill actually happened.
    param([Parameter(Mandatory)][int]$ProcId, [string]$Bot, [string]$Why = 'kill')
    if ($ProcId -le 0) { return $false }
    $r = Get-ProcessOwnerRecord -ProcId $ProcId
    if ($r.Protected) { Write-DaemonLog "SKIP protected: $ProcId $($r.Name) ($($r.Reason)) [$Why] $($r.CmdHead)" -Bot $Bot; return $false }
    if (-not $r.Ours) { Write-DaemonLog "SKIP not ours: $ProcId $($r.Name) ($($r.Reason)) [$Why] $($r.CmdHead)" -Bot $Bot; return $false }
    $ok = Stop-ProcessTree $ProcId
    Write-DaemonLog "killed tree $ProcId $($r.Name) ($($r.Reason)) [$Why] -> $ok" -Bot $Bot
    return $ok
}

function Get-ClaudeChildPid {
    # >0 = the claude.exe child of $ShellPid; 0 = queried fine, none; -1 = the
    # CIM query itself failed (unknown, NOT "dead").
    param([int]$ShellPid)
    if ($ShellPid -le 0) { return 0 }
    try {
        $kid = Get-CimInstance Win32_Process -Filter "ParentProcessId=$ShellPid" -ErrorAction Stop |
               Where-Object { $_.Name -eq 'claude.exe' } | Select-Object -First 1
        if ($kid) { return [int]$kid.ProcessId }
        return 0
    } catch { return -1 }
}

function Get-ProcessSessionId {
    param([int]$ProcId)
    try { return [int](Get-CimInstance Win32_Process -Filter "ProcessId=$ProcId" -ErrorAction Stop).SessionId } catch { return -1 }
}

function Resolve-PwshExe {
    # Never a versioned WindowsApps path (breaks on every PowerShell update).
    # A bare 'powershell'/'pwsh' name can fail to spawn from session 0 (PATH is
    # unreliable there), so every tier below returns an ABSOLUTE path.
    $known = Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'
    if (Test-Path $known) { return $known }
    $p = (Get-Command pwsh.exe -ErrorAction SilentlyContinue).Source
    if ($p) { return $p }
    $alias = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\pwsh.exe'
    if (Test-Path $alias) { return $alias }
    return (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
}

function Resolve-Python {
    # PATH is unreliable in session 0 (a bare 'python'/'py' failed to spawn
    # there), so the py launcher and the registry are checked BEFORE PATH.
    # Pinning a version directory is a time bomb (a copy of this daemon that
    # named a Python version that was later uninstalled had every python step
    # die silently, fail-open) - the registry lookup below always picks the
    # newest installed version instead of a fixed one. `botcorp doctor` is
    # what reports a missing python; Resolve-Python itself stays fail-open to
    # the bare 'python' name as the last resort.
    if ($env:BOT_PYTHON -and (Test-Path $env:BOT_PYTHON)) { return $env:BOT_PYTHON }
    $py = $null
    foreach ($c in @((Join-Path $env:SystemRoot 'py.exe'), (Join-Path $env:LOCALAPPDATA 'Programs\Python\Launcher\py.exe'))) {
        if (Test-Path $c) { $py = $c; break }
    }
    if (-not $py) { $py = (Get-Command py.exe -ErrorAction SilentlyContinue).Source }
    if ($py) {
        try {
            $out = (& $py -3 -c 'import sys; print(sys.executable)' 2>$null | Select-Object -First 1)
            if ($out -and (Test-Path "$out".Trim())) { return "$out".Trim() }
        } catch {}
    }
    try {
        foreach ($base in @('HKCU:\Software\Python\PythonCore', 'HKLM:\SOFTWARE\Python\PythonCore')) {
            $entries = Get-ItemProperty -Path (Join-Path $base '*\InstallPath') -ErrorAction SilentlyContinue
            if (-not $entries) { continue }
            $ranked = foreach ($e in $entries) {
                $verLeaf = Split-Path (Split-Path $e.PSPath -Parent) -Leaf
                $v = $null
                if ([version]::TryParse($verLeaf, [ref]$v)) { [pscustomobject]@{ Ver = $v; Entry = $e } }
            }
            foreach ($r in ($ranked | Sort-Object Ver -Descending)) {
                $e = $r.Entry
                $exe = if (($e.PSObject.Properties.Name -contains 'ExecutablePath') -and $e.ExecutablePath) { $e.ExecutablePath } else { Join-Path $e.'(default)' 'python.exe' }
                if ($exe -and (Test-Path $exe)) { return $exe }
            }
        }
    } catch {}
    try {
        $c = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python3*\python.exe') -ErrorAction Stop |
             Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
        if ($c) { return $c }
    } catch {}
    $p = (Get-Command python.exe -ErrorAction SilentlyContinue).Source
    if ($p -and ($p -notmatch 'WindowsApps')) { return $p }
    return 'python'
}

function Resolve-Node {
    $n = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
    if (-not $n) { foreach ($c in @("$env:ProgramFiles\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe")) { if (Test-Path $c) { $n = $c; break } } }
    return $n
}

# --- Claude Code specifics (the only CLI; no driver seam) -----------------------------
function Resolve-ClaudeExe {
    # Native installer first: a stale npm shim in %APPDATA%\npm can shadow it and
    # break; PATH `claude` is the fallback for npm-only installs.
    $native = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
    if (Test-Path $native) { return $native }
    $onPath = (Get-Command claude -ErrorAction SilentlyContinue).Source
    if ($onPath) { return $onPath }
    return $native
}

function Get-ClaudeEnv {
    # $Secrets: hashtable key -> plaintext (only the keys the launcher decided
    # this bot needs), mapped to Claude Code's env names. The launcher masks
    # them when it prints and never puts them on a command line.
    # Env names: the two Claude Code / plugin names, else the key upper-cased
    # (hub_token -> HUB_TOKEN, the same rule automations.ps1 applies).
    param([string]$ConfigDir, [hashtable]$Secrets = @{})
    $e = @{ CLAUDE_CONFIG_DIR = $ConfigDir }
    foreach ($k in $Secrets.Keys) { $e[(Get-SecretEnvName $k)] = $Secrets[$k] }
    return $e
}

function Get-SecretEnvName {
    param([string]$Key)
    switch ($Key) {
        'oauth_token'    { return 'CLAUDE_CODE_OAUTH_TOKEN' }
        'telegram_token' { return 'TELEGRAM_BOT_TOKEN' }
        default          { return "$Key".ToUpperInvariant() }
    }
}

function Get-ClaudeArgv {
    # The interactive / background launch argv (never contains a secret).
    #   -Bg            claude --bg (background session under Claude Code's supervisor)
    #   -ResumeId      --resume <session uuid> (with --bg: continues under the same id;
    #                  `--bg --continue` always starts a COPY, so it is never used here)
    #   -Continue      --continue (foreground / pty launches only)
    # `--channels ... --settings <tg-enable>` is LAST: the reference host proved
    # the plugin flag must close the argv.
    param(
        [bool]$Bg,
        [string]$ResumeId,
        [bool]$Continue,
        [string]$Permissions = 'bypass',      # bypass | default
        [string]$PluginDir,
        [bool]$Channels,                      # own the Telegram poller this launch
        [string]$TgSettings,                  # tg-enable.settings.json (enablement rides in via --settings ONLY)
        [string[]]$Passthrough = @()
    )
    $a = @()
    if ($Bg) { $a += '--bg' }
    if ($Permissions -eq 'bypass') { $a += '--dangerously-skip-permissions' }
    if ($PluginDir) { $a += @('--plugin-dir', $PluginDir) }
    if ($ResumeId) { $a += @('--resume', $ResumeId) }
    elseif ($Continue -and -not $Bg) { $a += '--continue' }
    if ($Passthrough) { $a += @($Passthrough | Where-Object { $_ }) }
    if ($Channels) {
        # --channels alone cannot load a disabled plugin; the --settings file is
        # the ONE place enablement lives, so a plain `claude` in this cwd never
        # starts a second poller.
        $a += @('--channels', 'plugin:telegram@claude-plugins-official', '--settings', $TgSettings)
    }
    return $a
}

function Get-ClaudeHeadlessArgv {
    # Utility spawns (triage, debrief): prompt on STDIN (never argv), user
    # settings only (never the tg-enable file), no plugin dir unless asked.
    # There is deliberately NO --bare option: --bare never reads OAuth (CC
    # 2.1.281: "Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper"),
    # so a token-authenticated bot cannot use it (docs/cc-compat.md row viii).
    param([string]$Model, [bool]$WithHooks, [string]$PluginDir)
    $a = @('-p', '--setting-sources', 'user', '--dangerously-skip-permissions')
    if ($Model) { $a += @('--model', $Model) }
    if ($WithHooks -and $PluginDir) { $a += @('--plugin-dir', $PluginDir) }
    return $a
}

function Test-ClaudeVersion {
    param([string]$Min = '2.1.280')
    try {
        $exe = Resolve-ClaudeExe
        $line = (& $exe --version 2>$null | Select-Object -First 1)
        if ($line -match '(\d+)\.(\d+)\.(\d+)') {
            $have = [version]"$($matches[1]).$($matches[2]).$($matches[3])"
            return ($have -ge [version]$Min)
        }
    } catch {}
    return $false
}

# --- background sessions (harness.session: bg) -----------------------------------------
function Get-BgAgents {
    # `claude agents --json` (run under the bot's CLAUDE_CONFIG_DIR) -> array of
    # {id, kind, sessionId, pid, state, status, cwd, startedAt}. The roster is
    # PER USER (a probe under a throwaway config dir still listed the user's
    # other sessions), so callers match by id / session id / cwd (Find-BgAgent),
    # never by position. $null = the query itself failed (unknown, NOT "none").
    # The supervisor pipe is scoped to the token that started it: a supervisor
    # started by an elevated task answers only elevated callers (a non-elevated
    # call sees []), so this must run in the same context as the launch (the
    # daemon task).
    param([Parameter(Mandatory)][string]$Bot, [hashtable]$Paths, [int]$TimeoutSec = 30)
    if (-not $Paths) { $Paths = Get-BotPaths -Bot $Bot }
    try {
        $exe = Resolve-ClaudeExe
        if (-not (Test-Path $exe)) { return $null }
        $env = @{ CLAUDE_CONFIG_DIR = $Paths.ConfigDir }
        $r = Invoke-Bounded -Exe $exe -Arguments @('agents', '--json') -TimeoutSec $TimeoutSec -Label 'claude agents' -Capture -Env $env -WorkingDirectory $Paths.BotHome -Bot $Bot
        if ($r.Killed -or $null -eq $r.ExitCode) { return $null }
        return (ConvertFrom-BgRoster -Text "$($r.Output)")
    } catch { return $null }
}

function ConvertFrom-BgRoster {
    # `claude agents --json` output -> a FLAT array of rows. The comma: an empty
    # roster must come back as an EMPTY ARRAY (known: none), never as $null
    # (unknown). (Piping into `ConvertFrom-Json -NoEnumerate` inside @() nested
    # the whole roster as ONE element, so no row ever matched by id and
    # Test-BgAgentAlive was always false.) Unparsable -> $null.
    param([string]$Text)
    try {
        $txt = "$Text".Trim()
        $i = $txt.IndexOf('['); if ($i -lt 0) { return ,@() }
        $j = $txt.LastIndexOf(']'); if ($j -lt $i) { return ,@() }
        # piped through Where-Object: flat on pwsh 7 (which enumerates) AND on
        # Windows PowerShell 5.1 (which returns the array as one object)
        $parsed = ConvertFrom-Json -InputObject ($txt.Substring($i, $j - $i + 1))
        $arr = @($parsed | Where-Object { $null -ne $_ })
        return ,$arr
    } catch { return $null }
}

function Find-BgAgent {
    # The roster row for this bot: by short id, then full session id, then
    # cwd = BotHome (a bg session started by launch.ps1 has cwd = BotHome).
    param($Agents, [string]$BgId, [string]$SessionId, [string]$BotHome)
    if ($null -eq $Agents) { return $null }
    foreach ($a in @($Agents)) {
        try { if ($BgId -and ($a.PSObject.Properties.Name -contains 'id') -and ("$($a.id)" -eq $BgId)) { return $a } } catch {}
    }
    foreach ($a in @($Agents)) {
        try { if ($SessionId -and ($a.PSObject.Properties.Name -contains 'sessionId') -and ("$($a.sessionId)" -eq $SessionId)) { return $a } } catch {}
    }
    foreach ($a in @($Agents)) {
        try { if ($BotHome -and ("$($a.kind)" -eq 'background') -and ("$($a.cwd)".TrimEnd('\') -ieq $BotHome.TrimEnd('\'))) { return $a } } catch {}
    }
    return $null
}

function Test-BgAgentAlive {
    # A roster row counts as alive when its process is alive, or when the
    # supervisor still owns it as working/blocked (it restarts such a process
    # itself). A `stopped`/`done`/`failed` row with no live pid is dead.
    param($Agent)
    if ($null -eq $Agent) { return $false }
    try { if (($Agent.PSObject.Properties.Name -contains 'pid') -and $Agent.pid -and (Test-ProcAlive ([int]$Agent.pid) @('claude'))) { return $true } } catch {}
    try { if (($Agent.PSObject.Properties.Name -contains 'state') -and ("$($Agent.state)" -in @('working', 'blocked'))) { return $true } } catch {}
    return $false
}

# --- the config home's Claude Code daemon ----------------------------------------------
# `claude --bg` hands the session to a supervisor ("daemon") that is PER CONFIG
# HOME (<config>/daemon.lock, daemon.log) and spawns EVERY worker with the
# environment of the client that STARTED the daemon. A later `claude --bg`
# client's env never reaches its session (probe 2026-09-25, CC 2.1.282: a
# session spawned by an already-running daemon carried the first client's
# BOT_LAUNCHER_PID and no TELEGRAM_BOT_TOKEN, so the Telegram plugin exited
# "TELEGRAM_BOT_TOKEN required": no bun child, no bot.pid, statusline red).
# The daemon idles out 5 s after its last worker and client are gone; an
# attached client (`claude attach`, the cockpit) keeps it - and its env - alive.
function Get-BgDaemon {
    # @{ Pid; Alive; StartedAt; SpawnedByPid } from <config>/daemon.lock.
    # Alive = that pid is a live `claude daemon run` (pid reuse guarded).
    param([Parameter(Mandatory)][string]$ConfigDir)
    $d = @{ Pid = 0; Alive = $false; StartedAt = $null; SpawnedByPid = 0 }
    try {
        $j = Read-JsonFile -Path (Join-Path $ConfigDir 'daemon.lock')
        if (-not $j -or -not $j.pid) { return $d }
        $d.Pid = [int]$j.pid
        try { if ($j.startedAt) { $d.StartedAt = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$j.startedAt).LocalDateTime.ToString('s') } } catch {}
        try { if ($j.spawnedBy -and $j.spawnedBy.pid) { $d.SpawnedByPid = [int]$j.spawnedBy.pid } } catch {}
        if (-not (Test-ProcAlive $d.Pid @('claude'))) { return $d }
        $cmd = ''
        try { $cmd = "$((Get-CimInstance Win32_Process -Filter "ProcessId=$($d.Pid)" -ErrorAction Stop).CommandLine)" } catch {}
        # an unreadable command line (another session's process) still counts as the daemon
        $d.Alive = (-not $cmd) -or ($cmd -match '\bdaemon\s+run\b')
    } catch {}
    return $d
}

function Get-BgDaemonAction {
    # What a bg launch does about the config home's daemon BEFORE `claude --bg`:
    #   spawn    no live daemon: `claude --bg` starts one with THIS launch's env
    #   recycle  a live daemon with no live session: stop it first, so the one
    #            this launch starts carries this launch's env (vault tokens)
    #   inherit  a live daemon with live sessions (or a roster that could not
    #            be read, -1): never stopped from here; the new session gets
    #            the DAEMON's env, not this launch's
    param([bool]$DaemonAlive, [int]$LiveWorkers)
    if (-not $DaemonAlive) { return 'spawn' }
    if ($LiveWorkers -eq 0) { return 'recycle' }
    return 'inherit'
}

function Stop-BgDaemon {
    # `claude daemon stop --any` under the bot's config home, then wait for the
    # pid to go. $true when it is gone. Only ever called for a daemon with no
    # live session (Get-BgDaemonAction 'recycle').
    param([Parameter(Mandatory)][string]$Bot, [Parameter(Mandatory)][hashtable]$Paths, [int]$DaemonPid, [int]$WaitSec = 15)
    try {
        $r = Invoke-Bounded -Exe (Resolve-ClaudeExe) -Arguments @('daemon', 'stop', '--any') -TimeoutSec 30 -Label 'claude daemon stop' -Capture -Env @{ CLAUDE_CONFIG_DIR = $Paths.ConfigDir } -WorkingDirectory $Paths.BotHome -Bot $Bot
        $until = (Get-Date).AddSeconds($WaitSec)
        while ((Get-Date) -lt $until -and (Test-ProcAlive $DaemonPid @('claude'))) { Start-Sleep -Milliseconds 500 }
        return (-not (Test-ProcAlive $DaemonPid @('claude')))
    } catch { return $false }
}

# --- the Telegram poller ------------------------------------------------------------
function Test-ProcDescendant {
    # Is $ProcId $AncestorId itself or somewhere below it (ParentProcessId walk)?
    param([int]$ProcId, [int]$AncestorId, [int]$MaxDepth = 12)
    if ($ProcId -le 0 -or $AncestorId -le 0) { return $false }
    $cur = $ProcId
    for ($i = 0; $i -le $MaxDepth -and $cur -gt 4; $i++) {
        if ($cur -eq $AncestorId) { return $true }
        try { $cur = [int](Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction Stop).ParentProcessId } catch { return $false }
    }
    return $false
}

function Get-TgPoller {
    # The plugin writes channels/telegram/bot.pid (its bun server.ts pid) only
    # AFTER its token check. Up = that pid is alive AND below $ClaudePid.
    param([Parameter(Mandatory)][string]$BotPidFile, [int]$ClaudePid)
    $botPid = 0
    try { if (Test-Path $BotPidFile) { $botPid = Get-FirstPid ((Get-Content $BotPidFile -ErrorAction Stop | Select-Object -First 1)) } } catch {}
    $alive = Test-ProcAlive $botPid
    return @{ BotPid = $botPid; Alive = $alive; Up = ($alive -and (Test-ProcDescendant -ProcId $botPid -AncestorId $ClaudePid)) }
}

function Wait-TgPoller {
    # Poll Get-TgPoller until it is up or $TimeoutSec passed (the plugin
    # connects a few seconds into the session). No claude pid = not up.
    param([Parameter(Mandatory)][string]$BotPidFile, [int]$ClaudePid, [int]$TimeoutSec = 30)
    $p = @{ BotPid = 0; Alive = $false; Up = $false }
    if ($ClaudePid -le 0) { return $p }
    $until = (Get-Date).AddSeconds($TimeoutSec)
    while ($true) {
        $p = Get-TgPoller -BotPidFile $BotPidFile -ClaudePid $ClaudePid
        if ($p.Up -or (Get-Date) -ge $until) { return $p }
        Start-Sleep -Milliseconds 1000
    }
}

function Complete-TgTokenFile {
    # harness.telegram_token_file: the ACL'd <config>/channels/telegram/.env is
    # needed only until the plugin has read it. Wait (bounded) for the poller to
    # come up under $ClaudePid, then delete the file WHATEVER happened - the
    # token never stays on disk at rest. Returns @{ Deleted; Up; BotPid }.
    param([Parameter(Mandatory)][string]$TokenFile, [Parameter(Mandatory)][string]$BotPidFile, [int]$ClaudePid, [int]$TimeoutSec = 30)
    $p = Wait-TgPoller -BotPidFile $BotPidFile -ClaudePid $ClaudePid -TimeoutSec $TimeoutSec
    $deleted = $true
    try { if (Test-Path $TokenFile) { Remove-Item -LiteralPath $TokenFile -Force -ErrorAction Stop } } catch { $deleted = $false }
    if (Test-Path $TokenFile) { $deleted = $false }
    return @{ Deleted = $deleted; Up = [bool]$p.Up; BotPid = $p.BotPid }
}

function Get-BotSessionKind {
    # bot.yaml harness.session: bg (default) | pty - HOW the bot's Claude Code
    # process runs (background session under the supervisor, or inside our
    # pty-host). Distinct from harness.service (daemon | manual = WHETHER the
    # daemon cold-starts it). Read defensively: the key may not be in
    # botyaml.mjs yet; anything but 'pty' is bg.
    param($Cfg)
    try { if ($Cfg -and $Cfg.harness -and ($Cfg.harness.PSObject.Properties.Name -contains 'session') -and ("$($Cfg.harness.session)".ToLowerInvariant() -eq 'pty')) { return 'pty' } } catch {}
    return 'bg'
}

function Test-BotManualService {
    # bot.yaml harness.service: manual = the daemon never cold-starts this bot
    # (cockpit / CLI starts only); it still heals a running one. Defensive read.
    param($Cfg)
    try { return ($Cfg -and $Cfg.harness -and ($Cfg.harness.PSObject.Properties.Name -contains 'service') -and ("$($Cfg.harness.service)".ToLowerInvariant() -eq 'manual')) } catch { return $false }
}

function Start-BotBg {
    # COLD-START a bg bot: launch.ps1 -Bg (bounded; `claude --bg` returns as
    # soon as the supervisor accepted the session). launch.ps1 records bg_id /
    # session_id / claude_pid in the state file. Returns the launcher's last line.
    param([Parameter(Mandatory)][string]$Bot, [switch]$Fresh, [string]$StartedBy = 'daemon-cold')
    $a = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'launch.ps1'), '-Bot', $Bot, '-Bg', '-StartedBy', $StartedBy)
    if ($Fresh) { $a += '-Fresh' }
    # Attestation: this is a trusted start path, so mint the launch nonce the
    # vault requires (raw nonce via env only; state holds its hash).
    $env = @{}
    try { $env['BOTCORP_LAUNCH_NONCE'] = New-LaunchNonce -Bot $Bot } catch { Write-DaemonLog "launch nonce not minted (fail-open, launch runs unattested): $($_.Exception.Message)" -Bot $Bot }
    $r = Invoke-Bounded -Exe (Resolve-PwshExe) -Arguments $a -TimeoutSec 150 -Label 'launch -Bg' -Capture -Env $env -WorkingDirectory $script:BotCorp -Bot $Bot
    $last = ''; try { $last = (($r.Output -split "`n" | Where-Object { $_.Trim() }) | Select-Object -Last 1) } catch {}
    return "launch.ps1 -Bg exit=$($r.ExitCode) $last".Trim()
}

function Stop-BgSession {
    # `claude stop <id>` (bounded; the conversation is kept and `--resume`
    # works afterwards), then the guarded tree-kill on the recorded claude pid
    # if it is still there. Returns $true when nothing of it is left alive.
    param([Parameter(Mandatory)][string]$Bot, [hashtable]$Paths, [int]$TimeoutSec = 45)
    if (-not $Paths) { $Paths = Get-BotPaths -Bot $Bot }
    $st = Read-BotState -Bot $Bot
    $bgId = ''; $cpid = 0
    try { if ($st -and ($st.PSObject.Properties.Name -contains 'bg_id')) { $bgId = "$($st.bg_id)" } } catch {}
    try { if ($st -and $null -ne $st.claude_pid) { $cpid = [int]$st.claude_pid } } catch {}
    if ($bgId) {
        $exe = Resolve-ClaudeExe
        $r = Invoke-Bounded -Exe $exe -Arguments @('stop', $bgId) -TimeoutSec $TimeoutSec -Label 'claude stop' -Capture -Env @{ CLAUDE_CONFIG_DIR = $Paths.ConfigDir } -WorkingDirectory $Paths.BotHome -Bot $Bot
        Write-DaemonLog "claude stop ${bgId}: exit=$($r.ExitCode) $((($r.Output -split "`n" | Where-Object { $_.Trim() }) | Select-Object -Last 1))" -Bot $Bot
    }
    if ($cpid -gt 0 -and (Test-ProcAlive $cpid @('claude'))) {
        $until = (Get-Date).AddSeconds(10)
        while ((Get-Date) -lt $until -and (Test-ProcAlive $cpid @('claude'))) { Start-Sleep -Milliseconds 500 }
        if (Test-ProcAlive $cpid @('claude')) { [void](Stop-BotProcessTree -ProcId $cpid -Bot $Bot -Why 'bg stop: claude pid still alive after claude stop') }
    }
    # Every OTHER live session of this bot (cwd = bot home, in its own config
    # home: a `--resume` that started a copy, an unrecorded earlier launch)
    # goes too. Each keeps the config home's daemon alive, and the next
    # launch's session would run with that daemon's old env (Get-BgDaemon).
    if ((Get-BgDaemon -ConfigDir $Paths.ConfigDir).Alive) {
        $agents = Get-BgAgents -Bot $Bot -Paths $Paths -TimeoutSec 20
        foreach ($a in @($agents)) {
            try {
                if (-not $a -or ("$($a.id)" -eq $bgId) -or ("$($a.cwd)".TrimEnd('\') -ine $Paths.BotHome.TrimEnd('\')) -or -not (Test-BgAgentAlive $a)) { continue }
                $r = Invoke-Bounded -Exe (Resolve-ClaudeExe) -Arguments @('stop', "$($a.id)") -TimeoutSec $TimeoutSec -Label 'claude stop' -Capture -Env @{ CLAUDE_CONFIG_DIR = $Paths.ConfigDir } -WorkingDirectory $Paths.BotHome -Bot $Bot
                Write-DaemonLog "claude stop $($a.id) (unrecorded session of this bot, pid $($a.pid)): exit=$($r.ExitCode)" -Bot $Bot
            } catch {}
        }
    }
    return (-not ($cpid -gt 0 -and (Test-ProcAlive $cpid @('claude'))))
}

function Test-Headless {
    # True when this process has no interactive desktop of its own (the daemon
    # task, Password or S4U logon: session 0). A manual run from a terminal is
    # not headless.
    try {
        return (([System.Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) -or (-not [Environment]::UserInteractive))
    } catch { return $false }
}

function Get-InteractiveSessionId {
    # Session id of a logged-in desktop user (explorer.exe outside session 0),
    # 0 at the login screen. Unsure -> 0 (selects the hidden launch).
    try {
        $ex = Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" -ErrorAction Stop |
              Where-Object { $_.SessionId -ne 0 } | Select-Object -First 1
        if ($ex) { return [int]$ex.SessionId }
    } catch {}
    return 0
}

function Invoke-Bounded {
    # Run a child with a HARD timeout; the whole tree is killed on overrun.
    # ProcessStartInfo.ArgumentList quotes each element (Start-Process
    # -ArgumentList joins with spaces and does not). Returns
    #   @{ ExitCode = <int or $null when killed>; Output = <stdout+stderr when -Capture>; Killed = <bool> }
    # Without -Capture, output is discarded rather than buffered (a chatty child
    # on a full, undrained pipe would deadlock).
    param(
        [Parameter(Mandatory)][string]$Exe,
        [string[]]$Arguments = @(),
        [int]$TimeoutSec = 180,
        [string]$Label = 'step',
        [string]$WorkingDirectory,
        [hashtable]$Env,
        [switch]$Capture,
        [string]$Bot
    )
    $p = $null
    try {
        $psi = [System.Diagnostics.ProcessStartInfo]::new()
        $psi.FileName = $Exe
        foreach ($a in $Arguments) { [void]$psi.ArgumentList.Add([string]$a) }
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        if ($WorkingDirectory) { $psi.WorkingDirectory = $WorkingDirectory }
        if ($Env) { foreach ($k in $Env.Keys) { $psi.Environment[[string]$k] = [string]$Env[$k] } }
        $psi.RedirectStandardOutput = [bool]$Capture
        $psi.RedirectStandardError = [bool]$Capture
        $p = [System.Diagnostics.Process]::Start($psi)
        $outTask = $null; $errTask = $null
        if ($Capture) { $outTask = $p.StandardOutput.ReadToEndAsync(); $errTask = $p.StandardError.ReadToEndAsync() }
        $done = $p.WaitForExit($TimeoutSec * 1000)
        if (-not $done) {
            try { $p.Kill($true) } catch {}
            try { & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $p.Id /T /F 2>$null | Out-Null } catch {}
            Write-DaemonLog "$Label`: KILLED after ${TimeoutSec}s (was holding the tick)" -Bot $Bot
        }
        $text = ''
        if ($Capture) { try { $text = ($outTask.Result + $errTask.Result) } catch {} }
        return [pscustomobject]@{ ExitCode = $(if ($done) { $p.ExitCode } else { $null }); Output = $text; Killed = (-not $done) }
    } catch {
        Write-DaemonLog "$Label`: launch failed (fail-open): $($_.Exception.Message)" -Bot $Bot
        return [pscustomobject]@{ ExitCode = $null; Output = ''; Killed = $false }
    } finally { if ($p) { $p.Dispose() } }
}

function Start-Hidden {
    # Fire-and-forget: a fully OS-orphaned, windowless child that survives this
    # process (Start-Process -WindowStyle Hidden = ShellExecute; verified in the
    # restart dance). Inherits our environment. Returns the pid (0 on failure).
    param([Parameter(Mandatory)][string]$Exe, [string[]]$Arguments = @(), [string]$WorkingDirectory)
    try {
        $quoted = @()
        foreach ($a in $Arguments) { $quoted += $(if ("$a" -match '[\s"]') { '"' + ("$a" -replace '"', '\"') + '"' } else { "$a" }) }
        $sp = @{ FilePath = $Exe; WindowStyle = 'Hidden'; PassThru = $true }
        if ($quoted.Count -gt 0) { $sp.ArgumentList = $quoted }
        if ($WorkingDirectory) { $sp.WorkingDirectory = $WorkingDirectory }
        $p = Start-Process @sp
        if ($p) { return [int]$p.Id }
    } catch { Write-DaemonLog "Start-Hidden $Exe failed (fail-open): $($_.Exception.Message)" }
    return 0
}

# --- bots ------------------------------------------------------------------------
function Get-BotList {
    # Every bots/<name>/bot.yaml whose folder does not start with '_'.
    $out = @()
    try {
        foreach ($d in (Get-ChildItem -Path $script:BotsDir -Directory -ErrorAction Stop)) {
            if ($d.Name.StartsWith('_')) { continue }
            if (Test-Path (Join-Path $d.FullName 'bot.yaml')) { $out += $d.Name }
        }
    } catch {}
    return $out
}

function Get-BotPaths {
    param([Parameter(Mandatory)][string]$Bot)
    $bh  = Join-Path $script:BotsDir $Bot
    $cfg = Join-Path $bh ".claude-$Bot"
    return @{
        Bot         = $Bot
        BotHome     = $bh
        ConfigDir   = $cfg
        StateFile   = Join-Path $script:StateDir "$Bot.json"
        PtyFile     = Join-Path $script:StateDir "$Bot.pty.json"
        BotStateDir = Join-Path $script:StateDir $Bot
        BotLogDir   = Join-Path $script:LogsDir $Bot
        LockFile    = Join-Path $cfg 'botcorp\tg_owner.lock'
        BotPidFile  = Join-Path $cfg 'channels\telegram\bot.pid'
        Breakpoint  = Join-Path $bh '.claude\.botcorp_breakpoint'
        FreshMarker = Join-Path $bh '.claude\.botcorp_fresh_restart'
        PausedFile  = Join-Path $script:StateDir "$Bot.paused"
    }
}

function Get-BotConfig {
    # bot.yaml -> effective config (defaults applied) via the ONE parser.
    # $null when unreadable or invalid (logged).
    param([Parameter(Mandatory)][string]$Bot)
    try {
        $node = Resolve-Node
        if (-not $node) { Write-DaemonLog 'node.exe not found - cannot read bot.yaml' -Bot $Bot; return $null }
        $yaml = Join-Path (Join-Path $script:BotsDir $Bot) 'bot.yaml'
        $r = Invoke-Bounded -Exe $node -Arguments @((Join-Path $PSScriptRoot 'botyaml.mjs'), $yaml) -TimeoutSec 30 -Label 'botyaml' -Capture -Bot $Bot -WorkingDirectory $script:BotCorp
        if ($r.ExitCode -ne 0) { Write-DaemonLog "bot.yaml unreadable: $(($r.Output -split "`n" | Select-Object -First 1))" -Bot $Bot; return $null }
        $cfg = $r.Output | ConvertFrom-Json
        if ($cfg._errors -and @($cfg._errors).Count -gt 0) { Write-DaemonLog "bot.yaml invalid: $(@($cfg._errors) -join '; ')" -Bot $Bot; return $null }
        return $cfg
    } catch { Write-DaemonLog "bot.yaml parse failed (fail-open): $($_.Exception.Message)" -Bot $Bot; return $null }
}

function Test-BotModule {
    param($Cfg, [string]$Module)
    try { return (@($Cfg._modules) -contains $Module) } catch { return $false }
}

function Read-BotState {
    param([Parameter(Mandatory)][string]$Bot)
    return Read-JsonFile -Path (Join-Path $script:StateDir "$Bot.json")
}

function Write-BotState {
    # Merge $Updates over the existing record (launch.ps1 writes the same file
    # with the same shape; every key it wrote is preserved).
    param([Parameter(Mandatory)][string]$Bot, [hashtable]$Updates)
    try {
        $cur = Read-BotState -Bot $Bot
        $m = [ordered]@{}
        if ($cur) { foreach ($p in $cur.PSObject.Properties) { $m[$p.Name] = $p.Value } }
        if (-not $m.Contains('bot')) { $m['bot'] = $Bot }
        foreach ($k in $Updates.Keys) { $m[$k] = $Updates[$k] }
        [void](Write-JsonFile -Path (Join-Path $script:StateDir "$Bot.json") -Object $m -Depth 6)
    } catch { Write-DaemonLog "state write failed (fail-open): $($_.Exception.Message)" -Bot $Bot }
}

function Get-BotEnv {
    # The env every python/tool call for a bot gets.
    param([Parameter(Mandatory)][string]$Bot, $Cfg, [hashtable]$Paths)
    if (-not $Paths) { $Paths = Get-BotPaths -Bot $Bot }
    $mods = ''
    try { if ($Cfg) { $mods = (@($Cfg._modules) -join ',') } } catch {}
    $e = @{
        BOT_HOME          = $Paths.BotHome
        BOT_NAME          = $Bot
        BOTCORP_HOME      = $script:RtHome
        BOTCORP_ROOT      = $script:BotCorp
        CLAUDE_CONFIG_DIR = $Paths.ConfigDir
        CLAUDE_PLUGIN_ROOT = $script:Harness
        PYTHONIOENCODING  = 'utf-8'
        BOT_MODULES       = $mods
        GIT_TERMINAL_PROMPT = '0'
        GCM_INTERACTIVE   = 'never'
    }
    # Absolute interpreter for hooks/tools this env feeds - PATH is unreliable
    # in session 0, and _guard.sh already prefers BOT_PYTHON when set.
    try { $py = Resolve-Python; if ($py -and (Test-Path $py)) { $e['BOT_PYTHON'] = $py } } catch {}
    return $e
}

function Test-SessionBusy {
    # Is this bot's session ACTIVELY working? Returns $true = busy (defer),
    # $false = idle (safe). CONSERVATIVE: any error / no transcript -> BUSY.
    #
    # 1. Breakpoint marker: <BotHome>/.claude/.botcorp_breakpoint younger than
    #    BOT_BREAKPOINT_TTL_MIN (30) => IDLE. The bot declares a clean
    #    breakpoint itself as the LAST action of a turn with nothing in flight,
    #    because transcript-quiet never holds during long autonomous work and
    #    every idle-gated action would otherwise wait for days. A stale marker
    #    is ignored so a missed window never authorises a later kill.
    # 2. Newest Claude Code transcript (.jsonl) under <config>/projects/<slug>/,
    #    RECURSIVE: subagents write <session>/subagents/**/agent-*.jsonl while
    #    the main transcript sits idle (a top-level-only check once killed two
    #    mid-run workflows). Quiet >= QuietMin => idle. The slug is the bot
    #    folder with every non-alphanumeric char -> '-', exactly as Claude Code
    #    derives it (no drive-letter special case).
    param([Parameter(Mandatory)][string]$Bot, [int]$QuietMin = 5)
    $P = Get-BotPaths -Bot $Bot
    try {
        if (Test-Path $P.Breakpoint) {
            $ttl = 30; try { if ($env:BOT_BREAKPOINT_TTL_MIN) { $ttl = [double]$env:BOT_BREAKPOINT_TTL_MIN } } catch {}
            if (((Get-Date) - (Get-Item $P.Breakpoint).LastWriteTime).TotalMinutes -lt $ttl) { return $false }
        }
    } catch {}
    try {
        $slug = ($P.BotHome -replace '[^A-Za-z0-9]', '-')
        $projDir = Join-Path (Join-Path $P.ConfigDir 'projects') $slug
        if (-not (Test-Path $projDir)) { return $true }
        $newest = Get-ChildItem -Path $projDir -Filter '*.jsonl' -Recurse -ErrorAction SilentlyContinue |
                  Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if (-not $newest) { return $true }
        return (((Get-Date) - $newest.LastWriteTime).TotalMinutes -lt $QuietMin)
    } catch { return $true }
}

function Test-BreakpointFresh {
    param([Parameter(Mandatory)][string]$Bot)
    $P = Get-BotPaths -Bot $Bot
    try {
        if (-not (Test-Path $P.Breakpoint)) { return $false }
        $ttl = 30; try { if ($env:BOT_BREAKPOINT_TTL_MIN) { $ttl = [double]$env:BOT_BREAKPOINT_TTL_MIN } } catch {}
        return (((Get-Date) - (Get-Item $P.Breakpoint).LastWriteTime).TotalMinutes -lt $ttl)
    } catch { return $false }
}

function Test-BotAccountBlocked {
    # <rt>/state/accounts.json marks a Claude account usage-blocked:
    #   {"accounts":{"<account>":{"blocked_until":"<iso>","bots":["a","b"]}}}
    # (a top-level map without the "accounts" wrapper is accepted too). A bot
    # is blocked while an entry naming it has blocked_until in the future.
    param([Parameter(Mandatory)][string]$Bot)
    try {
        $j = Read-JsonFile -Path (Join-Path $script:StateDir 'accounts.json')
        if (-not $j) { return $false }
        $map = if ($j.PSObject.Properties.Name -contains 'accounts') { $j.accounts } else { $j }
        foreach ($p in $map.PSObject.Properties) {
            $e = $p.Value
            if ($null -eq $e -or -not ($e.PSObject.Properties.Name -contains 'blocked_until') -or -not $e.blocked_until) { continue }
            $names = @()
            try { if ($e.PSObject.Properties.Name -contains 'bots') { $names = @($e.bots) } } catch {}
            if (($names -contains $Bot) -or ($p.Name -eq $Bot)) {
                $until = [datetime]::MinValue
                if ($e.blocked_until -is [datetime]) { $until = $e.blocked_until }
                elseif (-not [datetime]::TryParse("$($e.blocked_until)", [ref]$until)) { continue }
                if ($until -gt (Get-DaemonNow)) { return $true }
            }
        }
    } catch {}
    return $false
}

# --- launching -----------------------------------------------------------------
function Start-PtyHost {
    # node daemon/pty-host.mjs --bot <name> --botcorp <root> --continue|--fresh,
    # detached and hidden (it owns the ConPTY; the cockpit attaches over WS).
    # Returns the pty-host pid, 0 on failure.
    param([Parameter(Mandatory)][string]$Bot, [switch]$Fresh)
    $node = Resolve-Node
    if (-not $node) { Write-DaemonLog 'node.exe not found - cannot start pty-host' -Bot $Bot; return 0 }
    $a = @((Join-Path $PSScriptRoot 'pty-host.mjs'), '--bot', $Bot, '--botcorp', $script:BotCorp, $(if ($Fresh) { '--fresh' } else { '--continue' }))
    # Start-Hidden inherits our environment: the launch nonce rides to
    # pty-host and on to launch.ps1 inside the pty (which strips it before claude).
    try { $env:BOTCORP_LAUNCH_NONCE = New-LaunchNonce -Bot $Bot } catch { Write-DaemonLog "launch nonce not minted (fail-open, launch runs unattested): $($_.Exception.Message)" -Bot $Bot }
    try { return (Start-Hidden -Exe $node -Arguments $a -WorkingDirectory $script:BotCorp) }
    finally { Remove-Item Env:BOTCORP_LAUNCH_NONCE -ErrorAction SilentlyContinue }
}

function Stop-PtyHost {
    # The ONE stop path: pty-host's own --stop (taskkill /T on the pty root,
    # then the host), so nothing else ever half-kills a tree.
    param([Parameter(Mandatory)][string]$Bot)
    $node = Resolve-Node
    if (-not $node) { return $false }
    $r = Invoke-Bounded -Exe $node -Arguments @((Join-Path $PSScriptRoot 'pty-host.mjs'), '--stop', $Bot) -TimeoutSec 45 -Label 'pty-host --stop' -Capture -Bot $Bot -WorkingDirectory $script:BotCorp
    $last = ''; try { $last = (($r.Output -split "`n" | Where-Object { $_.Trim() }) | Select-Object -Last 1) } catch {}
    Write-DaemonLog "pty-host --stop: exit=$($r.ExitCode) $last" -Bot $Bot
    return ($r.ExitCode -eq 0)
}

function Start-VisibleLaunchTask {
    # Hand a launch to the 'BotCorp-Launch' scheduled task (Interactive
    # principal, no triggers). Started from session 0 it still runs in the
    # user's desktop session. The task is per-machine; it learns which bot from
    # <rt>/state/launch-request.json written right before Start-ScheduledTask.
    # Returns a description on success, $null when the task is missing/fails.
    param([Parameter(Mandatory)][string]$Bot, [int]$SessionId = 0)
    try {
        $t = Get-ScheduledTask -TaskName 'BotCorp-Launch' -ErrorAction Stop
        [void](Write-JsonFile -Path (Join-Path $script:StateDir 'launch-request.json') -Object ([ordered]@{ bot = $Bot; requested_at = (Get-Date).ToString('o'); by = 'daemon' }))
        Start-ScheduledTask -InputObject $t -ErrorAction Stop
        return "BotCorp-Launch task (interactive session $SessionId)"
    } catch {
        Write-DaemonLog "BotCorp-Launch task unavailable ($($_.Exception.Message)) -> hidden launch" -Bot $Bot
        return $null
    }
}

function Start-RestartDetached {
    # RESTART: spawn restart.ps1 detached with the live claude pid (+ shell).
    # It waits for that pid to exit (the caller kills it) then relaunches:
    # --continue for a pty bot, --resume <session id> for a bg bot (restart.ps1
    # reads harness.session). NEVER with OldPid 0 (System Idle Process reads "alive").
    param([Parameter(Mandatory)][string]$Bot, [Parameter(Mandatory)][int]$OldPid, [int]$OldShellPid = 0)
    $a = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'restart.ps1'), '-Bot', $Bot, '-OldPid', "$OldPid")
    if ($OldShellPid -gt 0) { $a += @('-OldShellPid', "$OldShellPid") }
    return (Start-Hidden -Exe (Resolve-PwshExe) -Arguments $a -WorkingDirectory $script:BotCorp)
}
