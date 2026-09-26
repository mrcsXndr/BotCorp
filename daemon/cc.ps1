# cc.ps1 - the Claude Code update gate: bots run a BotCorp-owned copy of Claude
# Code, <rt>/cc/<version>/claude.exe, named by one machine-wide pin in
# <rt>/state/cc.json (docs/daemon.md "Claude Code pin", docs/cc-compat.md).
# Claude Code's supervisor watches the exe it was started from, so a bot
# started from the shared ~/.local/bin/claude.exe would ride every global
# update untested; a copy nobody writes to never moves.
#
#   pwsh -NoProfile -File daemon/cc.ps1 -Check              # the tick, hourly: bootstrap + stage
#   pwsh -NoProfile -File daemon/cc.ps1 -Test               # the tick, detached: the 8 checks on _canary
#   pwsh -NoProfile -File daemon/cc.ps1 -Prune
#   pwsh -NoProfile -File daemon/cc.ps1 -Rollback [-To <v>] # `botcorp cc rollback`
#
# -Check: no cc.json yet -> BOOTSTRAP: copy the global ~/.local/bin/claude.exe
#   into the store and pin it (by: bootstrap; what runs today, so no gate).
#   Then the newest global version (~/.local/share/claude/versions/<v> or the
#   native exe's --version) is STAGED as the candidate when it is newer than
#   the pin, not rejected and not already the candidate. Never tests, never
#   promotes, never writes to the global install (it is only read and copied).
# Staging: copy to a new temp dir under <rt>/cc, verify (Authenticode Valid,
#   signer "Anthropic, PBC", --version equal to the version, sha256 equal to
#   the source), then rename the dir to <rt>/cc/<v>. A stored exe is
#   IMMUTABLE: an existing <rt>/cc/<v>/claude.exe with the source's sha256 is
#   reused, one with another sha256 is left untouched and nothing is staged.
# -Test (lock <rt>/state/cc.lock): drives _canary with the candidate (every
#   non-SKIP check must PASS) -> promote (the old pin heads previous, prune),
#   else failed (retried an hour later) and on the second failure rejected,
#   with ONE notice per bot: a board card where the board module is on, else a
#   HUMAN: line in <BotHome>/memory/metrics/alerts.log (update.ps1's channel).
# -Prune: delete <rt>/cc/<v> unless it is the pin, previous[0..1], the
#   candidate, or any process runs an exe under it.
# -Rollback: the pin moves to previous[0] (or -To <v>), the version it
#   replaced is rejected; the tick rolls the bots at their next idle point.
#
# Test seams (refused unless BOTCORP_HOME is under %TEMP%):
#   -SkipSignature   no Authenticode check (the tests' stand-in exes are unsigned)
#   -ChecksFile <f>  -Test takes the check results from <f> instead of the canary
# Exit 0 = done / nothing to do; 1 = the action failed; 2 = a refused seam.

param(
    [switch]$Check,
    [switch]$Test,
    [switch]$Prune,
    [switch]$Rollback,
    [string]$To,
    [switch]$SkipSignature,
    [string]$ChecksFile
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot '_common.ps1')

if ($SkipSignature -or $ChecksFile) {
    $tmpRoot = [System.IO.Path]::GetFullPath("$env:TEMP").TrimEnd('\') + '\'
    $rtFull = [System.IO.Path]::GetFullPath($RtHome).TrimEnd('\') + '\'
    if (-not $env:TEMP -or -not $rtFull.StartsWith($tmpRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        Write-Host "cc.ps1: -SkipSignature / -ChecksFile are test seams, refused unless BOTCORP_HOME ($RtHome) is under %TEMP%"
        exit 2
    }
}

$ccDir = Join-Path $RtHome 'cc'
$ccFile = Get-CcStatePath
$lockFile = Join-Path $StateDir 'cc.lock'
$nativeExe = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
$versionsDir = Join-Path $env:USERPROFILE '.local\share\claude\versions'

function Log { param([string]$M) Write-DaemonLog "cc: $M" }
function Now { return (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') }

function Save-Cc {
    # write-then-rename: every resolver reads this file
    param($S)
    $tmp = "$ccFile.tmp"
    if (-not (Write-JsonFile -Path $tmp -Object $S -Depth 8)) { Log "could not write $tmp"; return $false }
    try { [System.IO.File]::Move($tmp, $ccFile, $true); return $true } catch { Log "could not replace ${ccFile}: $($_.Exception.Message)"; return $false }
}

function Get-Sha256 { param([string]$Path) return (Get-FileHash -LiteralPath $Path -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant() }

function Get-ExeVersion {
    param([string]$Exe)
    $r = Invoke-Bounded -Exe $Exe -Arguments @('--version') -TimeoutSec 30 -Label 'cc --version' -Capture
    if ($r.ExitCode -eq 0 -and "$($r.Output)" -match '(\d+\.\d+\.\d+)') { return $matches[1] }
    return ''
}

function Test-CcExe {
    # '' when the file is a genuine Claude Code <Version>, else why not.
    param([string]$Exe, [string]$Version)
    if (-not $SkipSignature) {
        $sig = Get-AuthenticodeSignature -LiteralPath $Exe
        if ("$($sig.Status)" -ne 'Valid') { return "signature $($sig.Status)" }
        $cn = ''
        try { $cn = $sig.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) } catch {}
        if ($cn -ne 'Anthropic, PBC') { return "signed by '$cn', not 'Anthropic, PBC'" }
    }
    $v = Get-ExeVersion $Exe
    if ($v -ne $Version) { return "--version says '$v', expected $Version" }
    return ''
}

function Invoke-CcStage {
    # -> @{ ok; detail; entry = {version, exe, sha256} }
    param([string]$Version, [string]$Source)
    try { $srcSha = Get-Sha256 $Source } catch { return @{ ok = $false; detail = "cannot read ${Source}: $($_.Exception.Message)" } }
    $dir = Join-Path $ccDir $Version
    $exe = Join-Path $dir 'claude.exe'
    if (Test-Path -LiteralPath $exe) {
        $have = ''; try { $have = Get-Sha256 $exe } catch {}
        if ($have -ne $srcSha) { return @{ ok = $false; detail = "$exe exists with another sha256 than $Source - left untouched" } }
        $why = Test-CcExe $exe $Version
        if ($why) { return @{ ok = $false; detail = "${exe}: $why" } }
        return @{ ok = $true; detail = 'reused'; entry = [ordered]@{ version = $Version; exe = $exe; sha256 = $srcSha } }
    }
    if (Test-Path -LiteralPath $dir) { return @{ ok = $false; detail = "$dir exists without claude.exe - left untouched" } }
    $tmpDir = Join-Path $ccDir (".stage-$Version-" + [guid]::NewGuid().ToString('n').Substring(0, 8))
    $tmpExe = Join-Path $tmpDir 'claude.exe'
    try {
        New-Item -ItemType Directory -Force -Path $tmpDir -ErrorAction Stop | Out-Null
        Copy-Item -LiteralPath $Source -Destination $tmpExe -ErrorAction Stop
        if ((Get-Sha256 $tmpExe) -ne $srcSha) { throw 'the copy differs from the source (it changed while copying)' }
        $why = Test-CcExe $tmpExe $Version
        if ($why) { throw $why }
        # one rename on one volume; it fails rather than merge when the dir appeared meanwhile.
        # A scanner may hold a fresh exe for a moment, so try a few times.
        $moved = $false
        for ($i = 0; $i -lt 5 -and -not $moved; $i++) {
            try { [System.IO.Directory]::Move($tmpDir, $dir); $moved = $true } catch { if (Test-Path -LiteralPath $dir) { throw }; Start-Sleep -Milliseconds 600 }
        }
        if (-not $moved) { throw "could not rename $tmpDir to $dir" }
        return @{ ok = $true; detail = 'copied'; entry = [ordered]@{ version = $Version; exe = $exe; sha256 = $srcSha } }
    } catch {
        return @{ ok = $false; detail = "stage ${Version}: $($_.Exception.Message)" }
    } finally {
        if (Test-Path -LiteralPath $tmpDir) {
            Remove-Item -LiteralPath $tmpExe -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $tmpDir -Force -ErrorAction SilentlyContinue
        }
    }
}

function Get-CcNewestSource {
    # @{ version; path } of the newest build the global install has, $null when none.
    # For the same version the native exe wins (it is what bootstrap pins).
    $list = @()
    if (Test-Path -LiteralPath $nativeExe) { $v = Get-ExeVersion $nativeExe; if ($v) { $list += @{ version = $v; path = $nativeExe } } }
    if (Test-Path -LiteralPath $versionsDir) {
        foreach ($f in @(Get-ChildItem -LiteralPath $versionsDir -File -ErrorAction SilentlyContinue)) {
            if (ConvertTo-CcVersion $f.Name) { $list += @{ version = $f.Name; path = $f.FullName } }
        }
    }
    if (-not $list) { return $null }
    return ($list | Sort-Object { ConvertTo-CcVersion $_.version } -Descending -Stable | Select-Object -First 1)
}

function Test-CcLockLive {
    try {
        if (-not (Test-Path -LiteralPath $lockFile)) { return $false }
        $p = Get-FirstPid ("" + (Get-Content -LiteralPath $lockFile -Raw -ErrorAction Stop))
        return ($p -gt 0 -and $p -ne $PID -and (Test-ProcAlive $p @('pwsh', 'powershell')))
    } catch { return $false }
}

function Enter-CcLock {
    # $true when this run holds <rt>/state/cc.lock (a dead holder's lock is taken over)
    if (Test-CcLockLive) { return $false }
    try {
        Remove-Item -LiteralPath $lockFile -Force -ErrorAction SilentlyContinue
        $fs = [System.IO.File]::Open($lockFile, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
        try { $b = [System.Text.Encoding]::ASCII.GetBytes("$PID"); $fs.Write($b, 0, $b.Length) } finally { $fs.Dispose() }
        return $true
    } catch { return $false }
}

function Exit-CcLock {
    try { if ((Get-FirstPid ("" + (Get-Content -LiteralPath $lockFile -Raw -ErrorAction Stop))) -eq $PID) { Remove-Item -LiteralPath $lockFile -Force -ErrorAction SilentlyContinue } } catch {}
}

function Get-CcInUseVersions {
    # The <rt>/cc/<v> names some process runs an exe from; $null when the process query failed.
    $root = [System.IO.Path]::GetFullPath($ccDir).TrimEnd('\') + '\'
    try { $procs = @(Get-CimInstance Win32_Process -Property ExecutablePath -ErrorAction Stop) } catch { return $null }
    $v = @()
    foreach ($p in $procs) {
        $x = "$($p.ExecutablePath)"
        if ($x -and $x.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) { $v += ($x.Substring($root.Length) -split '\\')[0] }
    }
    return , @($v | Select-Object -Unique)   # the comma: none in use is an empty array, not $null (unknown)
}

function Invoke-CcPrune {
    param($State)
    if (-not (Test-Path -LiteralPath $ccDir)) { return }
    $inUse = Get-CcInUseVersions
    if ($null -eq $inUse) { Log 'prune skipped: the process list could not be read'; return }
    $dirs = @(Get-ChildItem -LiteralPath $ccDir -Directory -ErrorAction SilentlyContinue)
    $versions = @($dirs | Where-Object { ConvertTo-CcVersion $_.Name } | ForEach-Object { $_.Name })
    $gone = @(Get-CcPruneList -Versions $versions -State $State -InUse $inUse)
    # an abandoned staging dir (a run that died mid-copy) older than an hour
    $gone += @($dirs | Where-Object { $_.Name -like '.stage-*' -and $_.LastWriteTime -lt (Get-Date).AddHours(-1) -and ($inUse -notcontains $_.Name) } | ForEach-Object { $_.Name })
    foreach ($n in $gone) {
        # the one file the store puts there, then the empty dir: never a recursive
        # delete. Windows also refuses to delete an exe a process runs.
        $d = Join-Path $ccDir $n
        try {
            $f = Join-Path $d 'claude.exe'
            if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force -ErrorAction Stop }
            Remove-Item -LiteralPath $d -Force -ErrorAction Stop
            Log "pruned $n"
        } catch { Log "prune ${n}: $($_.Exception.Message)" }
    }
}

function Send-CcRejectNotice {
    # One notice per bot through its channel of record (daemon/update.ps1's failure channel).
    param($Candidate, [string]$Pinned)
    $text = "Claude Code $($Candidate.version) failed the BotCorp gate twice and is rejected; bots stay on $Pinned. $($Candidate.detail). See botcorp cc status."
    foreach ($b in (Get-BotList)) {
        try {
            $P = Get-BotPaths -Bot $b
            $cfg = Get-BotConfig -Bot $b
            $carded = $false
            if ($cfg -and (Test-BotModule $cfg 'board')) {
                $gh = Join-Path $Harness 'tools\v2\gh_projects.py'
                if (Test-Path $gh) {
                    $bodyFile = Join-Path $StateDir 'cc_rejected_card.md'
                    [System.IO.File]::WriteAllText($bodyFile, "$text`n`nThe version is in cc.json rejected[] and is never staged again; a newer Claude Code release is staged and tested on its own. Checks: botcorp cc status.`n")
                    $r = Invoke-Bounded -Exe (Resolve-Python) -Arguments @($gh, 'add', "CLAUDE CODE $($Candidate.version) REJECTED", '--body-file', $bodyFile) -TimeoutSec 60 -Label 'board card' -Capture -Env (Get-BotEnv -Bot $b -Cfg $cfg -Paths $P) -WorkingDirectory $P.BotHome -Bot $b
                    $carded = ($r.ExitCode -eq 0)
                    Log "board card 'CLAUDE CODE $($Candidate.version) REJECTED' for ${b}: exit=$($r.ExitCode)"
                }
            }
            if (-not $carded) {
                $al = Join-Path (Join-Path $P.BotHome 'memory\metrics') 'alerts.log'
                $ad = Split-Path $al -Parent
                if (-not (Test-Path $ad)) { New-Item -ItemType Directory -Force -Path $ad | Out-Null }
                "$((Get-Date).ToString('s'))  HUMAN: $text" | Out-File -FilePath $al -Append -Encoding utf8
                Log "HUMAN: line appended to $b memory/metrics/alerts.log"
            }
        } catch { Log "could not report the rejection to $b (fail-open): $($_.Exception.Message)" }
    }
}

# --- the canary run (-Test) ------------------------------------------------------------------
# _canary is driven through the CLI (start, send, stop) exactly as an operator
# would, with BOTCORP_CLAUDE_EXE=<candidate> on this process only, so every
# launcher it reaches resolves the candidate. Each check returns PASS, FAIL or
# SKIP; after the first FAIL only check 8 (the teardown assertion) still runs.
$canary = '_canary'

function Test-SamePath {
    param([string]$A, [string]$B)
    if (-not $A -or -not $B) { return $false }
    try { return ([System.IO.Path]::GetFullPath($A) -ieq [System.IO.Path]::GetFullPath($B)) } catch { return $false }
}

function Test-Number { param($X) return ($X -is [int] -or $X -is [long] -or $X -is [double] -or $X -is [decimal]) }

function Get-CcCanaryProblem {
    # '' when _canary can take a gate run, else why not (such a run is not counted as an attempt)
    $P = Get-BotPaths -Bot $canary
    if (-not (Test-Path -LiteralPath (Join-Path $P.BotHome 'bot.yaml'))) { return "canary not provisioned: no $canary\bot.yaml under $BotsDir" }
    $store = $null
    try { $store = Read-VaultStore -BotHome $P.BotHome } catch { return "canary not provisioned: its vault is unreadable ($($_.Exception.Message))" }
    if (-not $store.ContainsKey('oauth_token')) { return "canary not provisioned: no oauth_token in its vault (botcorp secrets set $canary oauth)" }
    if (Test-VaultLocked -BotHome $P.BotHome -Bot $canary) { return "canary not provisioned: its vault is locked (botcorp secrets unlock $canary)" }
    $st = Read-BotState -Bot $canary
    if ($st -and (Test-ProcAlive ([int]$st.claude_pid) @('claude'))) { return "canary busy: $canary is running (pid $($st.claude_pid)); the gate starts and stops it itself" }
    return ''
}

function Get-CanaryWorkers {
    # <config>/daemon/roster.json workers with their short id (read from the file, no CLI call)
    param($P)
    $j = Read-JsonFile -Path (Join-Path $P.ConfigDir 'daemon\roster.json')
    if (-not $j -or -not $j.workers) { return @() }
    return @($j.workers.PSObject.Properties | ForEach-Object { [pscustomobject]@{ id = $_.Name; pid = [int]$_.Value.pid; sessionId = "$($_.Value.sessionId)"; cliVersion = "$($_.Value.cliVersion)" } })
}

function Get-ProcExe { param([int]$ProcId) try { return "$((Get-CimInstance Win32_Process -Filter "ProcessId=$ProcId" -ErrorAction Stop).ExecutablePath)" } catch { return '' } }

function Read-Shared {
    # a file another process is appending to
    param([string]$Path)
    try {
        $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        try { return ([System.IO.StreamReader]::new($fs)).ReadToEnd() } finally { $fs.Dispose() }
    } catch { return '' }
}

function Wait-Until {
    # polls $Cond once a second; $true as soon as it holds, $false after $Sec
    param([int]$Sec, [scriptblock]$Cond)
    $deadline = (Get-Date).AddSeconds($Sec)
    while ($true) {
        if (@(& $Cond)[-1] -eq $true) { return $true }
        if ((Get-Date) -ge $deadline) { return $false }
        Start-Sleep -Seconds 1
    }
}

function Invoke-CcCli {
    param([string[]]$A, [int]$TimeoutSec = 240)
    $r = Invoke-Bounded -Exe (Resolve-Node) -Arguments (@((Join-Path $BotCorp 'cli\botcorp.mjs')) + $A) -TimeoutSec $TimeoutSec -Label "cc gate: botcorp $($A[0])" -Capture -WorkingDirectory $BotCorp
    return @{ code = $r.ExitCode; out = "$($r.Output)" }
}

function Tail { param([string]$Text, [int]$N = 2) return ((($Text -split "`n") | Where-Object { $_.Trim() } | Select-Object -Last $N | ForEach-Object { $_.Trim() }) -join ' | ') }
function Pass { param([string]$D) return @{ r = 'PASS'; d = $D } }
function Fail { param([string]$D) return @{ r = 'FAIL'; d = $D } }
function Skip { param([string]$D) return @{ r = 'SKIP'; d = $D } }

function Step {
    param([int]$N, [string]$Name, [scriptblock]$Body)
    if ($script:ccFailed -and $N -ne 8) { return }
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $res = 'FAIL'; $detail = ''
    try { $o = @(& $Body)[-1]; $res = "$($o.r)"; $detail = "$($o.d)" } catch { $detail = "exception: $($_.Exception.Message)" }
    if ($res -cne 'PASS' -and $res -cne 'SKIP') { $res = 'FAIL' }
    $script:ccChecks += [ordered]@{ n = $N; name = $Name; result = $res; detail = $detail }
    Log "check $N ($Name) $res ($([int]$sw.Elapsed.TotalSeconds)s) $detail"
    if ($res -eq 'FAIL' -and -not $script:ccFailed) { $script:ccFailed = $N }
}

function Invoke-CcCanaryRun {
    # The 8 checks (docs/daemon.md "Claude Code pin") -> the checks, by number.
    # _canary is stopped before this returns, whatever happened.
    param($Candidate)
    $P = Get-BotPaths -Bot $canary
    $cand = "$($Candidate.exe)"; $cv = "$($Candidate.version)"
    $t0 = (Get-Date).ToUniversalTime().AddSeconds(-1)
    $t0Iso = $t0.ToString('yyyy-MM-ddTHH:mm:ssZ'); $t0Unix = ([DateTimeOffset]$t0).ToUnixTimeSeconds()
    $script:ccChecks = @(); $script:ccFailed = 0
    $env:BOTCORP_CLAUDE_EXE = $cand; $env:BOT_HOOK_TRACE = '1'; $env:BOT_TG_MUTE = '1'
    try {
        Step 2 'bg launch visible' {
            $r = Invoke-CcCli @('start', $canary, '--fresh')
            if ($r.code -ne 0) { return (Fail "botcorp start $canary --fresh exited $($r.code): $(Tail $r.out)") }
            $script:why = 'no bg_id in the state file'
            $ok = Wait-Until 60 {
                $st = Read-BotState -Bot $canary; $id = "$($st.bg_id)"
                if (-not $id) { return $false }
                $w = @(Get-CanaryWorkers $P | Where-Object { $_.id -eq $id }) | Select-Object -First 1
                if (-not $w -or -not (Test-ProcAlive $w.pid @('claude'))) { $script:why = "no live roster row for $id"; return $false }
                if ($w.cliVersion -ne $cv) { $script:why = "roster row $id runs Claude Code '$($w.cliVersion)'"; return $false }
                $d = Get-BgDaemon -ConfigDir $P.ConfigDir
                if (-not $d.Alive) { $script:why = 'no live daemon in daemon.lock'; return $false }
                $x = Get-ProcExe $d.Pid
                if (-not (Test-SamePath $x $cand)) { $script:why = "the daemon (pid $($d.Pid)) runs '$x'"; return $false }
                $script:why = "roster row $id cliVersion $cv; daemon pid $($d.Pid) runs the candidate"
                return $true
            }
            if ($ok) { Pass $script:why } else { Fail "$($script:why) after 60 s" }
        }
        Step 1 'version / status parse' {
            $v = Get-ExeVersion $cand
            if ($v -ne $cv) { return (Fail "--version says '$v'") }
            $cenv = @{ CLAUDE_CONFIG_DIR = $P.ConfigDir }
            $a = Invoke-Bounded -Exe $cand -Arguments @('agents', '--json') -TimeoutSec 60 -Label 'cc gate: agents --json' -Capture -Env $cenv -WorkingDirectory $P.BotHome
            $rows = $null
            if ("$($a.Output)" -match '\[') { $rows = ConvertFrom-BgRoster -Text "$($a.Output)" }
            if ($a.ExitCode -ne 0 -or $null -eq $rows) { return (Fail "agents --json: exit $($a.ExitCode), no JSON array: $(Tail $a.Output)") }
            $ds = Invoke-Bounded -Exe $cand -Arguments @('daemon', 'status') -TimeoutSec 60 -Label 'cc gate: daemon status' -Capture -Env $cenv -WorkingDirectory $P.BotHome
            if ($ds.ExitCode -ne 0) { return (Fail "daemon status exited $($ds.ExitCode): $(Tail $ds.Output)") }
            Pass "--version $v; agents --json $(@($rows).Count) row(s); daemon status exit 0"
        }
        Step 4 'inbox delivers' {
            $nonce = 'CANARY-' + [guid]::NewGuid().ToString('n').Substring(0, 8).ToUpperInvariant()
            $r = Invoke-CcCli @('send', $canary, '--wait', '--ttl', '5m', "Reply with the word $nonce and nothing else.") 480
            if ($r.code -ne 0) { return (Fail "botcorp send --wait exited $($r.code): $(Tail $r.out)") }
            $dir = Join-Path (Join-Path $P.ConfigDir 'projects') ($P.BotHome -replace '[^A-Za-z0-9]', '-')
            $ok = Wait-Until 180 {
                foreach ($f in @(Get-ChildItem -LiteralPath $dir -Filter '*.jsonl' -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTimeUtc -ge $t0 })) {
                    foreach ($ln in ((Read-Shared $f.FullName) -split "`n")) {
                        if (-not $ln.Contains($nonce)) { continue }
                        $e = $null; try { $e = $ln | ConvertFrom-Json -ErrorAction Stop } catch {}
                        if ($e -and "$($e.type)" -eq 'assistant') { return $true }
                    }
                }
                return $false
            }
            if ($ok) { Pass "delivered; the reply carries $nonce" } else { Fail "delivered, but no assistant reply with $nonce in $dir after 180 s" }
        }
        Step 3 'hooks fire' {
            $log = Join-Path $P.BotHome 'memory\metrics\hook-trace.log'
            $need = @('session-start', 'user-prompt-submit', 'memory-sync')
            $script:missing = $need
            $ok = Wait-Until 60 {
                $seen = @{}
                foreach ($ln in ((Read-Shared $log) -split "`r?`n")) {
                    $parts = $ln.Split(' ', 2)
                    if ($parts.Count -eq 2 -and [string]::CompareOrdinal($parts[0], $t0Iso) -ge 0) { $seen[$parts[1].Trim()] = $true }
                }
                $script:missing = @($need | Where-Object { -not $seen.ContainsKey($_) })
                return ($script:missing.Count -eq 0)
            }
            if ($ok) { Pass 'SessionStart, UserPromptSubmit and Stop hooks traced' } else { Fail "not traced since ${t0Iso}: $($script:missing -join ', ') ($log)" }
        }
        Step 7 'statusline numbers' {
            $f = Join-Path $P.ConfigDir 'botcorp\status.json'
            $script:why = "no $f"
            $ok = Wait-Until 60 {
                $j = Read-JsonFile -Path $f
                if (-not $j) { return $false }
                $ts = 0.0; try { $ts = [double]$j.ts } catch {}
                if ($ts -lt $t0Unix) { $script:why = "status.json not rewritten since the gate started (ts $ts)"; return $false }
                if ("$($j.version)" -ne $cv) { $script:why = "status.json version '$($j.version)'"; return $false }
                $ctx = $j.context_window.used_percentage; $five = $j.rate_limits.five_hour.used_percentage
                if (-not (Test-Number $ctx) -or -not (Test-Number $five)) { $script:why = "context_window.used_percentage '$ctx', rate_limits.five_hour.used_percentage '$five'"; return $false }
                $script:why = "version $cv; context $ctx%; five-hour $five%"
                return $true
            }
            if ($ok) { Pass $script:why } else { Fail "$($script:why) after 60 s" }
        }
        Step 5 'resume keeps session id' {
            $sid = "$((Read-BotState -Bot $canary).session_id)"
            if (-not $sid) { return (Fail 'no session_id in the state file') }
            $r = Invoke-CcCli @('stop', $canary) 120
            if ($r.code -ne 0) { return (Fail "botcorp stop exited $($r.code): $(Tail $r.out)") }
            $r = Invoke-CcCli @('start', $canary)
            if ($r.code -ne 0) { return (Fail "botcorp start (resume) exited $($r.code): $(Tail $r.out)") }
            $script:why = ''
            $ok = Wait-Until 60 {
                $st = Read-BotState -Bot $canary
                if ("$($st.session_id)" -ne $sid) { $script:why = "state session_id '$($st.session_id)'"; return $false }
                $w = @(Get-CanaryWorkers $P | Where-Object { $_.id -eq "$($st.bg_id)" -and (Test-ProcAlive $_.pid @('claude')) }) | Select-Object -First 1
                if (-not $w) { $script:why = "no live roster row for $($st.bg_id)"; return $false }
                if ($w.sessionId -ne $sid) { $script:why = "roster sessionId '$($w.sessionId)'"; return $false }
                return $true
            }
            if ($ok) { Pass "session $sid kept across stop / start" } else { Fail "expected session ${sid}: $($script:why) after 60 s" }
        }
        Step 6 'TG poller owns its token' {
            $cfg = Get-BotConfig -Bot $canary
            $tok = $false
            try { $tok = (Read-VaultStore -BotHome $P.BotHome).ContainsKey('telegram_token') } catch {}
            if (-not ($cfg -and (Test-BotModule $cfg 'telegram')) -or -not $tok) { return (Skip "$canary has no telegram module or no telegram_token") }
            $r = Invoke-CcCli @('observe', $canary, '--json') 60
            $obs = $null
            try { $obs = $r.out | ConvertFrom-Json -ErrorAction Stop } catch {}
            if ($obs -and "$($obs.poller)" -eq 'OWNED') { Pass 'poller OWNED (a live bun below the canary session)' } else { Fail "observe: poller '$($obs.poller)'" }
        }
        Step 8 'clean teardown' {
            $r = Invoke-CcCli @('stop', $canary) 120
            if ($r.code -ne 0) { return (Fail "botcorp stop exited $($r.code): $(Tail $r.out)") }
            $script:why = ''
            $ok = Wait-Until 30 {
                $procs = $null
                try { $procs = @(Get-CimInstance Win32_Process -Property ProcessId, Name, ExecutablePath, CommandLine -ErrorAction Stop) } catch { $script:why = 'the process list could not be read'; return $false }
                $left = @()
                $left += @($procs | Where-Object { Test-SamePath "$($_.ExecutablePath)" $cand } | ForEach-Object { "candidate pid $($_.ProcessId)" })
                $left += @(Get-CanaryWorkers $P | Where-Object { Test-ProcAlive $_.pid @('claude') } | ForEach-Object { "live roster row $($_.id)" })
                $left += @($procs | Where-Object { $_.Name -in @('bun.exe', 'node.exe') -and "$($_.CommandLine)".IndexOf($P.BotHome, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 } | ForEach-Object { "$($_.Name) pid $($_.ProcessId)" })
                if (-not (Test-Path -LiteralPath $P.PausedFile)) { $left += 'no .paused marker' }
                $script:why = $left -join ', '
                return ($left.Count -eq 0)
            }
            if ($ok) { Pass 'no candidate process, no live roster row, no canary bun/node, .paused set' } else { Fail "after 30 s: $($script:why)" }
        }
    } finally {
        # Never leave the canary up, nor a candidate process behind (it is not
        # pinned, so nothing else runs that exe); this happens before any promote.
        try {
            $st = Read-BotState -Bot $canary
            $up = ($st -and (Test-ProcAlive ([int]$st.claude_pid) @('claude'))) -or (@(Get-CanaryWorkers $P | Where-Object { Test-ProcAlive $_.pid @('claude') }).Count -gt 0)
            if ($up) { Log "teardown: stopping $canary"; [void](Invoke-CcCli @('stop', $canary) 120) }
            $gone = Wait-Until 30 { @(Get-CimInstance Win32_Process -Property ExecutablePath -ErrorAction Stop | Where-Object { Test-SamePath "$($_.ExecutablePath)" $cand }).Count -eq 0 }
            if (-not $gone) {
                foreach ($proc in @(Get-CimInstance Win32_Process -Property ProcessId, ExecutablePath -ErrorAction Stop | Where-Object { Test-SamePath "$($_.ExecutablePath)" $cand })) {
                    Log "teardown: pid $($proc.ProcessId) still runs the candidate after the stop - killed"
                    Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
                }
            }
        } catch { Log "teardown: $($_.Exception.Message)" }
        Remove-Item Env:BOTCORP_CLAUDE_EXE, Env:BOT_HOOK_TRACE -ErrorAction SilentlyContinue
    }
    return @($script:ccChecks | Sort-Object { $_.n })
}

# --- Check --------------------------------------------------------------------------------
if ($Check) {
    $s = ConvertTo-CcState (Read-CcState)
    $s.checked_at = Now
    if (-not $s.pinned) {
        if (-not (Test-Path -LiteralPath $nativeExe)) { Log "bootstrap: no native Claude Code at $nativeExe - nothing to pin (bots keep the PATH claude)"; exit 0 }
        $v = Get-ExeVersion $nativeExe
        if (-not $v) { Log "bootstrap: $nativeExe --version unreadable - nothing pinned"; exit 1 }
        $r = Invoke-CcStage -Version $v -Source $nativeExe
        if (-not $r.ok) { Log "bootstrap failed, nothing pinned: $($r.detail)"; exit 1 }
        $s.pinned = [ordered]@{ version = $v; exe = $r.entry.exe; sha256 = $r.entry.sha256; promoted_at = (Now); by = 'bootstrap' }
        if (-not (Save-Cc $s)) { exit 1 }
        Log "bootstrap: pinned $v ($($r.entry.exe), $($r.detail))"
    }
    if (Test-CcLockLive) { Log 'a gate run holds cc.lock - staging skipped this time'; [void](Save-Cc $s); exit 0 }
    $src = Get-CcNewestSource
    if (-not $src) { Log 'no global Claude Code build found to compare with'; [void](Save-Cc $s); exit 0 }
    $d = Get-CcStageDecision -State $s -Source $src.version
    if ($d -eq 'stage') {
        $r = Invoke-CcStage -Version $src.version -Source $src.path
        if ($r.ok) {
            $s.candidate = [ordered]@{ version = $src.version; exe = $r.entry.exe; sha256 = $r.entry.sha256; status = 'staged'; attempts = 0; checks = @(); staged_at = (Now); tested_at = $null; detail = '' }
            Log "staged $($src.version) as the candidate ($($r.detail); pinned $($s.pinned.version)); the gate tests it on _canary before any bot runs it"
        } else { Log "could not stage $($src.version): $($r.detail)" }
    } else { Log "pinned $($s.pinned.version); newest global $($src.version): $($d -replace '^none:', '')" -Quiet }
    if (-not (Save-Cc $s)) { exit 1 }
    exit 0
}

# --- Prune --------------------------------------------------------------------------------
if ($Prune) {
    Invoke-CcPrune -State (Read-CcState)
    exit 0
}

# --- Rollback -----------------------------------------------------------------------------
if ($Rollback) {
    if (Test-CcLockLive) { Log 'rollback refused: a gate run holds cc.lock; retry when it ends'; exit 1 }
    $r = Get-CcRollbackState -State (Read-CcState) -To $To -Now (Now)
    if (-not $r.Ok) { Log "rollback refused: $($r.Detail)"; exit 1 }
    $exe = "$($r.Target.exe)"
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { Log "rollback refused: $exe is gone"; exit 1 }
    $sha = ''; try { $sha = Get-Sha256 $exe } catch {}
    if ($sha -ne "$($r.Target.sha256)") { Log "rollback refused: $exe does not match its recorded sha256"; exit 1 }
    if (-not (Save-Cc $r.State)) { exit 1 }
    Log "rollback: pinned $($r.Target.version) (was $($r.From), now rejected); bots roll onto it at their next idle point"
    exit 0
}

# --- Test ---------------------------------------------------------------------------------
if ($Test) {
    if (-not (Enter-CcLock)) { Log 'a gate run already holds cc.lock - skipped'; exit 0 }
    try {
        $s = ConvertTo-CcState (Read-CcState)
        $c = $s.candidate
        if (-not $c -or "$($c.status)" -notin @('staged', 'failed', 'testing')) { Log "nothing to test (candidate: $(if ($c) { "$($c.version) $($c.status)" } else { 'none' }))"; exit 0 }
        if ("$($c.status)" -eq 'testing') {
            # We hold the lock, so the run that set `testing` is gone: it died
            # mid-test. That counts as a failed attempt (a second death rejects),
            # so a build that kills the gate can neither loop nor stay stuck.
            $o = Get-CcTestOutcome -State $s -Checks @() -Now (Now)
            $o.State.candidate['detail'] = "the gate run died mid-test ($($o.State.candidate.detail))"
            if (-not (Save-Cc $o.State)) { exit 1 }
            if ($o.Action -eq 'reject') {
                Log "candidate $($c.version) REJECTED: its gate run died twice"
                Send-CcRejectNotice -Candidate $o.State.candidate -Pinned "$($o.State.pinned.version)"
            } else { Log "candidate $($c.version): its last gate run died mid-test (attempt 1 of 2, retried in an hour)" }
            exit 0
        }
        if ($ChecksFile) { $checks = @(Get-Content -LiteralPath $ChecksFile -Raw | ConvertFrom-Json) }
        else {
            $why = Get-CcCanaryProblem
            if ($why) {
                $c.status = 'failed'; $c.detail = $why; $c.tested_at = (Now)
                [void](Save-Cc $s)
                Log "candidate $($c.version) not tested: $why (not counted as an attempt)"
                exit 1
            }
            $c.status = 'testing'; $c.detail = ''
            if (-not (Save-Cc $s)) { exit 1 }
            Log "testing candidate $($c.version) on $canary ($($c.exe))"
            $checks = @(Invoke-CcCanaryRun -Candidate $c)
        }
        $o = Get-CcTestOutcome -State $s -Checks $checks -Now (Now)
        if (-not (Save-Cc $o.State)) { exit 1 }
        switch ($o.Action) {
            'promote' {
                Log "PROMOTED $($o.State.pinned.version) (was $($o.State.previous[0].version)); bots roll onto it at their next idle point"
                Invoke-CcPrune -State $o.State
            }
            'retry' { Log "candidate $($c.version) FAILED (attempt 1 of 2, retried in an hour): $($o.State.candidate.detail)" }
            'reject' {
                Log "candidate $($c.version) REJECTED after 2 failed runs: $($o.State.candidate.detail)"
                Send-CcRejectNotice -Candidate $o.State.candidate -Pinned "$($o.State.pinned.version)"
            }
        }
        exit 0
    } finally { Exit-CcLock }
}

Write-Host 'usage: cc.ps1 -Check | -Test | -Prune | -Rollback [-To <version>]'
exit 0
