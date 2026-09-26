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
    return @($v | Select-Object -Unique)
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
        if (-not $ChecksFile) { Log 'the canary run is not available in this build; pass -ChecksFile (tests only)'; exit 1 }
        $checks = @(Get-Content -LiteralPath $ChecksFile -Raw | ConvertFrom-Json)
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
