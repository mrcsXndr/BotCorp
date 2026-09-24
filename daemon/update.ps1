# update.ps1 - harness self-update: hourly CHECK (records releases with their
# plain-language notes) and an ADMIN-requested APPLY. Nothing applies by itself.
#
#   pwsh -NoProfile -File daemon/update.ps1 -Check                 # from the tick (hourly) or by hand
#   pwsh -NoProfile -File daemon/update.ps1 -Request -Tag v1.2.0   # admin: mark a release apply_requested
#   pwsh -NoProfile -File daemon/update.ps1 -Skip -Tag v1.2.0      # admin: mark it skipped
#   pwsh -NoProfile -File daemon/update.ps1 -Apply -Tag v1.2.0     # the tick, once every bot is at a safe point
#   pwsh -NoProfile -File daemon/update.ps1 -ParseChangelog <file> -Tag v1.2.0   # test seam: print the notes as JSON
#
# -Check: `git -C <BotCorp> fetch --tags` bounded 45 s with no credential
#   prompts (GIT_TERMINAL_PROMPT=0, GCM_INTERACTIVE=never); EVERY `v*` tag on
#   origin/main newer than HEAD becomes a release in <rt>/state/updates.json
#     {checked_at, head, head_sha,
#      releases: [{tag, sha, date, what: [..], why: [..], value: [..],
#                  status: pending|apply_requested|applied|skipped|failed, ...}]}
#   where what/why/value come from the release's CHANGELOG.md section
#   (`## <tag>` up to the next `## `; bullets under `What` / `Why` / `Value`
#   headings when present, else the first three bullets become What and why /
#   value read "see changelog"). An existing entry keeps its status; a tag that
#   HEAD has reached is marked applied. No Telegram, no apply: the operator
#   sees pending releases (with the notes) in the cockpit and the weekly digest
#   and presses Apply / Skip there. Not a git checkout -> "not a git checkout",
#   exit 0.
#
# -Apply -Tag (bounded 3 min total): refuse on a dirty tree (someone edited
#   core in place; the release is marked failed with reason 'dirty tree');
#   `git checkout --detach <tag>`; daemon/smoke.ps1; pass -> <rt>/state/harness.json
#   {tag, sha, channel, applied_at, schema, migrations}, run
#   harness/migrations/NNN-*.ps1 newer than the recorded schema, `node
#   daemon/sync.mjs <bot>` for every bot, release status applied; fail ->
#   `git checkout --detach <from>`, status failed with the smoke tail, then a
#   Ready card (gh_projects.py add "HARNESS UPDATE FAILED <tag>") for every bot
#   whose board module is on, else a HUMAN: line in <BotHome>/memory/metrics/alerts.log.
#   The cockpit is restarted onto the new code and /healthz is polled before the
#   apply counts as a success. The tick (Invoke-UpdateApply) only calls this
#   for a release with status apply_requested AND when every bot is at a safe
#   point; afterwards the bots restart through the normal restart path.
# Exit 0 = nothing to do / applied / recorded; 1 = check or apply failed.

param(
    [switch]$Check,
    [switch]$Apply,
    [switch]$Request,
    [switch]$Skip,
    [string]$Tag,
    [string]$ParseChangelog,
    [string]$Bot   # kept for compatibility with older callers; the failure report goes to every bot
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot '_common.ps1')

$updatesFile = Join-Path $StateDir 'updates.json'
$harnessFile = Join-Path $StateDir 'harness.json'
$gitDir = Join-Path $BotCorp '.git'
$gitEnv = @{ GIT_TERMINAL_PROMPT = '0'; GCM_INTERACTIVE = 'never' }
$git = (Get-Command git.exe -ErrorAction SilentlyContinue).Source
if (-not $git) { $c = Join-Path $env:ProgramFiles 'Git\cmd\git.exe'; if (Test-Path $c) { $git = $c } else { $git = 'git' } }

function Log { param([string]$M) Write-DaemonLog "update: $M" }
function Invoke-Git { param([string[]]$GitArgs, [int]$TimeoutSec = 45)
    $r = Invoke-Bounded -Exe $git -Arguments (@('-C', $BotCorp, '-c', 'credential.interactive=never', '-c', 'core.askPass=') + $GitArgs) -TimeoutSec $TimeoutSec -Label "git $($GitArgs[0])" -Capture -Env $gitEnv -WorkingDirectory $BotCorp
    return @{ code = $r.ExitCode; out = "$($r.Output)".Trim(); killed = $r.Killed }
}
function ConvertTo-Version { param([string]$T) try { return [version]($T -replace '^v', '' -replace '[^0-9.].*$', '') } catch { return [version]'0.0' } }
function Get-HeadDescribe {
    $r = Invoke-Git @('describe', '--tags', '--exact-match', 'HEAD') 20
    if ($r.code -eq 0 -and $r.out) { return $r.out }
    $r = Invoke-Git @('rev-parse', '--short', 'HEAD') 20
    if ($r.code -eq 0 -and $r.out) { return $r.out }
    return 'unknown'
}

function Get-ChangelogNotes {
    # CHANGELOG.md -> @{ what; why; value } (string arrays) for one tag.
    # Section = from the `## <tag>` heading to the next `## `. Inside it a
    # heading (### / ####, or a bold line) whose text starts with What / Why /
    # Value collects the bullets below it. No such headings -> the first three
    # bullets of the section are What; why and value read "see changelog".
    param([string]$Path, [string]$ForTag)
    $n = @{ what = @(); why = @(); value = @() }
    try {
        if (-not (Test-Path $Path)) { return $n }
        $lines = @(Get-Content $Path -ErrorAction Stop)
        $start = -1
        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($lines[$i] -match ('^##\s+\[?' + [regex]::Escape($ForTag) + '\]?(\s|$)')) { $start = $i + 1; break }
        }
        if ($start -lt 0) { return $n }
        $section = @()
        for ($i = $start; $i -lt $lines.Count; $i++) { if ($lines[$i] -match '^##\s') { break }; $section += $lines[$i] }
        $bucket = $null; $bullets = @(); $seenHeading = $false
        foreach ($ln in $section) {
            $t = "$ln".Trim()
            if (-not $t) { continue }
            $h = $null
            if ($t -match '^#{3,6}\s*(.+)$') { $h = $matches[1] }
            elseif ($t -match '^\*\*([^*]+)\*\*:?\s*$') { $h = $matches[1] }
            if ($h) {
                $hl = $h.Trim().ToLowerInvariant()
                $bucket = $(if ($hl -match '^what') { 'what' } elseif ($hl -match '^why') { 'why' } elseif ($hl -match '^value') { 'value' } else { $null })
                if ($bucket) { $seenHeading = $true }
                continue
            }
            if ($t -match '^[-*+]\s+(.+)$') {
                $b = ($matches[1] -replace '\*\*', '').Trim()
                $bullets += $b
                if ($bucket) { $n[$bucket] += $b }
            }
        }
        if (-not $seenHeading) {
            $n.what = @($bullets | Select-Object -First 3)
            $n.why = @('see changelog'); $n.value = @('see changelog')
        } else {
            if ($n.what.Count -eq 0) { $n.what = @($bullets | Select-Object -First 3) }
            if ($n.why.Count -eq 0) { $n.why = @('see changelog') }
            if ($n.value.Count -eq 0) { $n.value = @('see changelog') }
        }
    } catch {}
    return $n
}

function Read-Updates {
    $u = Read-JsonFile -Path $updatesFile
    $h = [ordered]@{ checked_at = $null; head = $null; head_sha = $null; releases = @() }
    if ($u) {
        foreach ($k in @('checked_at', 'head', 'head_sha')) { try { if ($u.PSObject.Properties.Name -contains $k) { $h[$k] = $u.$k } } catch {} }
        try { if ($u.releases) { $h.releases = @($u.releases | ForEach-Object { ConvertTo-Hashtable $_ }) } } catch {}
    }
    return $h
}
function Save-Updates { param($U) return (Write-JsonFile -Path $updatesFile -Object $U -Depth 6) }
function Set-ReleaseStatus {
    param([string]$ForTag, [string]$Status, [hashtable]$Extra)
    $u = Read-Updates
    $hit = $false
    foreach ($r in $u.releases) {
        if ("$($r.tag)" -ne $ForTag) { continue }
        $r['status'] = $Status; $r['status_at'] = (Get-Date).ToString('o')
        if ($Extra) { foreach ($k in $Extra.Keys) { $r[$k] = $Extra[$k] } }
        $hit = $true
    }
    if ($hit) { [void](Save-Updates $u) }
    return $hit
}

# --- test seam ---------------------------------------------------------------------------
if ($ParseChangelog) {
    if (-not $Tag) { Write-Host 'usage: update.ps1 -ParseChangelog <file> -Tag <tag>'; exit 1 }
    $notes = Get-ChangelogNotes -Path $ParseChangelog -ForTag $Tag
    Write-Host (([ordered]@{ tag = $Tag; what = @($notes.what); why = @($notes.why); value = @($notes.value) }) | ConvertTo-Json -Depth 4)
    exit 0
}

# --- Check ------------------------------------------------------------------------------
if ($Check) {
    if (-not (Test-Path $gitDir)) { Log 'not a git checkout - update check skipped'; exit 0 }
    $f = Invoke-Git @('fetch', '--tags', '--quiet', 'origin') 45
    if ($f.code -ne 0) { Log "git fetch failed/timed out (code=$($f.code) killed=$($f.killed)) - check skipped: $(($f.out -split "`n" | Select-Object -Last 1))"; exit 1 }
    $headSha = (Invoke-Git @('rev-parse', 'HEAD') 20).out
    $from = Get-HeadDescribe
    $headVer = ConvertTo-Version $(if ($from -match '^v\d') { $from } else { 'v0.0' })
    $tagsR = Invoke-Git @('tag', '--list', 'v*', '--merged', 'origin/main') 30
    $tags = @()
    if ($tagsR.code -eq 0) { $tags = @($tagsR.out -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^v\d+(\.\d+)*' }) }
    $u = Read-Updates
    $u.checked_at = (Get-Date).ToString('o'); $u.head = $from; $u.head_sha = $headSha
    $known = @{}; foreach ($r in $u.releases) { $known["$($r.tag)"] = $r }
    $newer = 0
    foreach ($t in ($tags | Sort-Object { ConvertTo-Version $_ })) {
        $sha = (Invoke-Git @('rev-parse', "$t^{commit}") 20).out
        if (-not $sha) { continue }
        $isHead = ($sha -eq $headSha)
        $isNewer = ((ConvertTo-Version $t) -gt $headVer) -and -not $isHead
        if ($known.ContainsKey($t)) {
            $r = $known[$t]
            if ($isHead -and ("$($r.status)" -ne 'applied')) { $r['status'] = 'applied'; $r['status_at'] = (Get-Date).ToString('o') }
            if ($isNewer -and ("$($r.status)" -in @('pending', 'apply_requested'))) { $newer++ }
            continue
        }
        if (-not $isNewer) { continue }
        # `git show -s` on the tag object (annotated) or its commit: the date only.
        $date = (Invoke-Git @('log', '-1', '--format=%cI', $sha) 20).out
        # Notes from the release's OWN changelog (the tag's CHANGELOG.md), so a
        # release describes itself even when HEAD is far behind.
        $clText = (Invoke-Git @('show', "${t}:CHANGELOG.md") 20)
        $tmp = $null
        if ($clText.code -eq 0 -and $clText.out) {
            $tmp = Join-Path $StateDir ("changelog-$t.tmp.md")
            try { [System.IO.File]::WriteAllText($tmp, $clText.out) } catch { $tmp = $null }
        }
        $notes = Get-ChangelogNotes -Path $(if ($tmp) { $tmp } else { Join-Path $BotCorp 'CHANGELOG.md' }) -ForTag $t
        if ($tmp) { try { Remove-Item $tmp -Force -ErrorAction SilentlyContinue } catch {} }
        $u.releases += [ordered]@{ tag = $t; sha = $sha; date = $date; what = @($notes.what); why = @($notes.why); value = @($notes.value); status = 'pending'; seen_at = (Get-Date).ToString('o') }
        $newer++
        Log "release recorded: $t ($($notes.what.Count) note line(s); status pending - apply is an admin action)"
    }
    [void](Save-Updates $u)
    if ($newer -eq 0) { Log "up to date ($from)" } else { Log "$newer release(s) newer than $from recorded in updates.json (none applied)" }
    exit 0
}

# --- Request / Skip -------------------------------------------------------------------------
if ($Request -or $Skip) {
    if (-not $Tag) { Log 'request/skip needs -Tag'; exit 1 }
    $status = $(if ($Skip) { 'skipped' } else { 'apply_requested' })
    if (Set-ReleaseStatus -ForTag $Tag -Status $status) { Log "$Tag -> $status"; exit 0 }
    Log "$Tag is not a recorded release (run -Check first)"; exit 1
}

# --- Apply --------------------------------------------------------------------------------
if (-not $Apply) { Write-Host 'usage: update.ps1 -Check | -Request -Tag <tag> | -Skip -Tag <tag> | -Apply -Tag <tag> | -ParseChangelog <file> -Tag <tag>'; exit 0 }
if (-not $Tag) { Log 'apply needs -Tag'; exit 1 }
$deadline = (Get-Date).AddMinutes(3)
function Remaining { param([int]$Floor = 10) return [Math]::Max($Floor, [int](($deadline - (Get-Date)).TotalSeconds)) }
$u0 = Read-Updates
$rel = @($u0.releases | Where-Object { "$($_.tag)" -eq $Tag }) | Select-Object -First 1
if (-not $rel) { Log "apply: $Tag is not a recorded release (run -Check first)"; exit 1 }
if ("$($rel.status)" -eq 'applied') { Log "apply: $Tag already applied"; exit 0 }
if (-not (Test-Path $gitDir)) { Log 'apply: not a git checkout - cannot apply'; exit 1 }
$to = $Tag; $from = Get-HeadDescribe

function Write-Failed {
    param([string]$Reason, [string]$Detail)
    [void](Set-ReleaseStatus -ForTag $to -Status 'failed' -Extra @{ fail_reason = $Reason; fail_detail = $Detail; failed_at = (Get-Date).ToString('o') })
    Log "APPLY FAILED ($Reason): $to"
    # Tell a human once per bot, through each bot's own channel of record.
    foreach ($b in (Get-BotList)) {
        try {
            $P = Get-BotPaths -Bot $b
            $cfg = Get-BotConfig -Bot $b
            $carded = $false
            if ($cfg -and (Test-BotModule $cfg 'board')) {
                $gh = Join-Path $Harness 'tools\v2\gh_projects.py'
                if (Test-Path $gh) {
                    $bodyFile = Join-Path $StateDir "update_failed_card.md"
                    [System.IO.File]::WriteAllText($bodyFile, "Harness update $from -> $to failed on this machine.`n`nReason: $Reason`n`n$Detail`n`nThe checkout was rolled back to $from; bots keep running the old harness. Fix and re-tag, then request the apply again (the release is marked failed in updates.json).`n")
                    $r = Invoke-Bounded -Exe (Resolve-Python) -Arguments @($gh, 'add', "HARNESS UPDATE FAILED $to", '--body-file', $bodyFile) -TimeoutSec 60 -Label 'board card' -Capture -Env (Get-BotEnv -Bot $b -Cfg $cfg -Paths $P) -WorkingDirectory $P.BotHome -Bot $b
                    $carded = ($r.ExitCode -eq 0)
                    Log "board card 'HARNESS UPDATE FAILED $to' for ${b}: exit=$($r.ExitCode)"
                }
            }
            if (-not $carded) {
                $al = Join-Path (Join-Path $P.BotHome 'memory\metrics') 'alerts.log'
                $ad = Split-Path $al -Parent
                if (-not (Test-Path $ad)) { New-Item -ItemType Directory -Force -Path $ad | Out-Null }
                "$((Get-Date).ToString('s'))  HUMAN: harness update $from -> $to FAILED ($Reason); rolled back to $from. See $updatesFile" | Out-File -FilePath $al -Append -Encoding utf8
                Log "HUMAN: line appended to $b memory/metrics/alerts.log"
            }
        } catch { Log "could not report the failure to $b (fail-open): $($_.Exception.Message)" }
    }
}

# 1. dirty tree = someone edited core in place; never apply over their work.
$st = Invoke-Git @('status', '--porcelain', '--untracked-files=no') 30
if ($st.code -ne 0) { Write-Failed 'git status failed' $st.out; exit 1 }
if ($st.out) { Write-Failed 'dirty tree' ($st.out -split "`n" | Select-Object -First 10 | Out-String); exit 1 }

# 2. checkout the release
$fromSha = (Invoke-Git @('rev-parse', 'HEAD') 20).out
$co = Invoke-Git @('checkout', '--quiet', '--detach', $to) 60
if ($co.code -ne 0) { Write-Failed 'checkout failed' $co.out; exit 1 }
Log "checked out $to (from $from); running smoke"

# 3. smoke, bounded by what is left of the 3 minutes
$smoke = Invoke-Bounded -Exe (Resolve-PwshExe) -Arguments @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'smoke.ps1')) -TimeoutSec (Remaining 30) -Label 'smoke' -Capture -WorkingDirectory $BotCorp
$smokeTail = (($smoke.Output -split "`n") | Where-Object { $_.Trim() } | Select-Object -Last 12) -join "`n"
if ($smoke.ExitCode -ne 0) {
    $back = Invoke-Git @('checkout', '--quiet', '--detach', $(if ($fromSha) { $fromSha } else { $from })) 60
    Log "rolled back to $from (checkout exit=$($back.code))"
    Write-Failed $(if ($smoke.Killed) { 'smoke timed out' } else { 'smoke failed' }) $smokeTail
    exit 1
}

# 4. record, migrate, sync
$toSha = (Invoke-Git @('rev-parse', 'HEAD') 20).out
$schemaNew = 1; try { $bj = Read-JsonFile -Path (Join-Path $BotCorp 'botcorp.json'); if ($bj -and $bj.botYamlSchema) { $schemaNew = [int]$bj.botYamlSchema } } catch {}
$prev = Read-JsonFile -Path $harnessFile
$schemaOld = 0; try { if ($prev -and $null -ne $prev.schema) { $schemaOld = [int]$prev.schema } } catch {}
$ran = @()
try {
    $migDir = Join-Path $Harness 'migrations'
    if (Test-Path $migDir) {
        foreach ($m in (Get-ChildItem $migDir -Filter '*.ps1' -File | Sort-Object Name)) {
            if ($m.Name -notmatch '^(\d+)') { continue }
            $n = [int]$matches[1]
            if ($n -le $schemaOld) { continue }
            $r = Invoke-Bounded -Exe (Resolve-PwshExe) -Arguments @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $m.FullName) -TimeoutSec (Remaining 15) -Label "migration $($m.Name)" -Env @{ BOTCORP_ROOT = $BotCorp; BOTCORP_HOME = $RtHome } -WorkingDirectory $BotCorp
            Log "migration $($m.Name): exit=$($r.ExitCode)"
            $ran += $m.Name
        }
    }
} catch { Log "migrations: swallowed exception (fail-open): $($_.Exception.Message)" }
[void](Write-JsonFile -Path $harnessFile -Object ([ordered]@{ tag = $to; sha = $toSha; channel = 'stable'; applied_at = (Get-Date).ToString('o'); schema = [Math]::Max($schemaOld, $schemaNew); migrations = $ran }))
$node = Resolve-Node
if ($node) {
    foreach ($b in (Get-BotList)) {
        $r = Invoke-Bounded -Exe $node -Arguments @((Join-Path $PSScriptRoot 'sync.mjs'), $b) -TimeoutSec (Remaining 10) -Label "sync $b" -WorkingDirectory $BotCorp -Bot $b
        Log "sync ${b}: exit=$($r.ExitCode)"
    }
}
[void](Set-ReleaseStatus -ForTag $to -Status 'applied' -Extra @{ applied_at = (Get-Date).ToString('o'); from = $from })

# 5. cockpit onto the new code: restart it and verify /healthz before claiming success.
try {
    $c = Read-JsonFile -Path (Join-Path $RtHome 'cockpit.json')
    $enabled = $true; $port = 4477; $bind = '127.0.0.1'
    if ($c) { if (($c.PSObject.Properties.Name -contains 'enabled') -and ($c.enabled -eq $false)) { $enabled = $false }; if ($c.port) { $port = [int]$c.port }; if ($c.bind) { $bind = "$($c.bind)" } }
    if ($bind -notin @('127.0.0.1', 'localhost', '::1') -and -not (Test-Path (Join-Path $RtHome 'access.json'))) { $bind = '127.0.0.1' }
    $srv = Join-Path (Join-Path $BotCorp 'cockpit') 'server.mjs'
    if ($enabled -and $node -and (Test-Path $srv)) {
        $ds = Read-JsonFile -Path (Join-Path $StateDir 'daemon.json')
        $cpid = 0; try { if ($ds -and $ds.cockpit_pid) { $cpid = [int]$ds.cockpit_pid } } catch {}
        if ($cpid -gt 0 -and (Test-ProcAlive $cpid @('node'))) { [void](Stop-BotProcessTree -ProcId $cpid -Why 'cockpit restart onto the new harness') }
        $newPid = Start-Hidden -Exe $node -Arguments @($srv, '--port', "$port", '--bind', $bind) -WorkingDirectory $BotCorp
        $h = ConvertTo-Hashtable $ds; $h['cockpit_pid'] = $newPid; $h['cockpit_started_at'] = (Get-Date).ToString('o')
        [void](Write-JsonFile -Path (Join-Path $StateDir 'daemon.json') -Object $h)
        $ok = $false; $until = (Get-Date).AddSeconds([Math]::Min(25, (Remaining 5)))
        while ((Get-Date) -lt $until) {
            try { $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/healthz" -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop; if ($r.StatusCode -eq 200) { $ok = $true; break } } catch {}
            Start-Sleep -Milliseconds 800
        }
        Log "cockpit restarted (pid $newPid) healthz=$ok"
        if (-not $ok) { Log 'cockpit did not answer /healthz after the update; the daemon tick will keep retrying it' }
    }
} catch { Log "cockpit restart: swallowed exception (fail-open): $($_.Exception.Message)" }

Log "APPLIED $from -> $to ($toSha); the tick restarts the bots onto it"
exit 0
