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
#      releases: [{tag, sha, date, summary, notes: [{title, text}], notes_tail,
#                  status: pending|apply_requested|applied|included|skipped|failed, ...}]}
#   where the notes come from the release's own CHANGELOG.md section, read by
#   core/changelog.mjs (summary = the lead paragraph, notes = the bullets,
#   notes_tail = the upgrade note). An entry recorded before v0.8.2 (what / why
#   / value, no summary) gets its notes read again once. An existing entry
#   keeps its status; a tag that HEAD has reached is marked applied. No
#   Telegram, no apply: the operator
#   sees pending releases (with the notes) in the cockpit and the weekly digest
#   and presses Apply / Skip there. Not a git checkout -> "not a git checkout",
#   exit 0.
#
# -Apply -Tag (bounded 3 min total): refuse on a dirty tree (someone edited
#   core in place; the release is marked failed with reason 'dirty tree');
#   `git checkout --detach <tag>`; daemon/smoke.ps1; pass -> <rt>/state/harness.json
#   {tag, sha, channel, applied_at, schema, migrations}, run
#   harness/migrations/NNN-*.ps1 newer than the recorded schema, `node
#   daemon/sync.mjs <bot>` for every bot, release status applied, and the
#   other releases between the two versions updated (releases are cumulative:
#   an upgrade marks the ones it skipped over `included`, a roll back to an
#   older tag marks the ones it left `pending` again; migrations are never
#   undone); fail ->
#   `git checkout --detach <from>`, status failed with the smoke tail, then a
#   Ready card (gh_projects.py add "HARNESS UPDATE FAILED <tag>") for every bot
#   whose board module is on, else a HUMAN: line in <BotHome>/memory/metrics/alerts.log.
#   Then the cockpit is restarted onto the new code and /healthz polled for up
#   to 25 s; a failed poll is only logged and never undoes the apply (the
#   release is already marked applied). The tick (Invoke-UpdateApply) only calls this
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
    # One release's notes -> @{ summary; notes = @(@{title; text}); tail }, by
    # core/changelog.mjs (the one extractor; the cockpit reads the same shape):
    # summary = the section's lead paragraph, notes = its bullets, tail = the
    # upgrade note after them. -FromTag reads that tag's OWN CHANGELOG.md from
    # git (a release describes itself even when HEAD is far behind); -Path
    # reads a file. Nothing found -> empty strings and no notes, never filler.
    param([string]$Path, [string]$ForTag, [switch]$FromTag)
    $n = @{ summary = ''; notes = @(); tail = '' }
    try {
        $node = Resolve-Node
        if (-not $node) { return $n }
        $cl = Join-Path $BotCorp 'core\changelog.mjs'
        $a = $(if ($FromTag) { @($cl, '--git', $BotCorp, $ForTag, '--git-exe', $git) } else { @($cl, $Path, $ForTag) })
        $r = Invoke-Bounded -Exe $node -Arguments $a -TimeoutSec 30 -Label "changelog notes $ForTag" -Capture -Env $gitEnv -WorkingDirectory $BotCorp
        if ($r.ExitCode -ne 0) { return $n }
        $line = "$($r.Output)" -split "`n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1
        if (-not $line) { return $n }
        $j = $line | ConvertFrom-Json
        if (-not $j.found) { return $n }
        $n.summary = "$($j.summary)"; $n.tail = "$($j.tail)"
        $n.notes = @($j.notes | ForEach-Object { [ordered]@{ title = "$($_.title)"; text = "$($_.text)" } })
    } catch {}
    return $n
}
function Set-Notes {
    # Write the notes onto a release entry (ordered hashtable), dropping the
    # pre-v0.8.2 what/why/value arrays: they held the first line of up to three
    # bullets and "see changelog", which the cockpit showed as "(none given)".
    param($R, $Notes)
    $R['summary'] = $Notes.summary; $R['notes'] = @($Notes.notes); $R['notes_tail'] = $Notes.tail
    foreach ($k in @('what', 'why', 'value')) { if ($R.Contains($k)) { $R.Remove($k) } }
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
    Write-Host (([ordered]@{ tag = $Tag; summary = $notes.summary; notes = @($notes.notes); tail = $notes.tail }) | ConvertTo-Json -Depth 5)
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
            # recorded before v0.8.2 (what/why/value, no summary): read its notes again, once
            if (-not $r.Contains('summary')) { Set-Notes $r (Get-ChangelogNotes -ForTag $t -FromTag); Log "release notes refreshed: $t" }
            continue
        }
        if (-not $isNewer) { continue }
        # `git show -s` on the tag object (annotated) or its commit: the date only.
        $date = (Invoke-Git @('log', '-1', '--format=%cI', $sha) 20).out
        $rec = [ordered]@{ tag = $t; sha = $sha; date = $date; status = 'pending'; seen_at = (Get-Date).ToString('o') }
        $notes = Get-ChangelogNotes -ForTag $t -FromTag
        Set-Notes $rec $notes
        $u.releases += $rec
        $newer++
        Log "release recorded: $t ($($notes.notes.Count) note(s); status pending - apply is an admin action)"
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
if (-not (Test-Path $gitDir)) { Log 'apply: not a git checkout - cannot apply'; exit 1 }
# Already checked out (not "was applied once": a roll back re-applies an older release)
$tagSha = (Invoke-Git @('rev-parse', "$Tag^{commit}") 20).out
if ($tagSha -and $tagSha -eq (Invoke-Git @('rev-parse', 'HEAD') 20).out) { [void](Set-ReleaseStatus -ForTag $Tag -Status 'applied'); Log "apply: $Tag is already checked out"; exit 0 }
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
$ran = @(); $migFail = ''
try {
    $migDir = Join-Path $Harness 'migrations'
    if (Test-Path $migDir) {
        foreach ($m in (Get-ChildItem $migDir -Filter '*.ps1' -File | Sort-Object Name)) {
            if ($m.Name -notmatch '^(\d+)') { continue }
            $n = [int]$matches[1]
            if ($n -le $schemaOld) { continue }
            $r = Invoke-Bounded -Exe (Resolve-PwshExe) -Arguments @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $m.FullName) -TimeoutSec (Remaining 15) -Label "migration $($m.Name)" -Capture -Env @{ BOTCORP_ROOT = $BotCorp; BOTCORP_HOME = $RtHome } -WorkingDirectory $BotCorp
            Log "migration $($m.Name): exit=$($r.ExitCode)"
            if ($r.ExitCode -ne 0) {
                $migFail = "$($m.Name): $(if ($r.Killed) { 'timed out' } else { "exit=$($r.ExitCode)" })`n" + ((($r.Output -split "`n") | Where-Object { $_.Trim() } | Select-Object -Last 12) -join "`n")
                break
            }
            $ran += $m.Name
        }
    }
} catch { $migFail = "migrations threw: $($_.Exception.Message)" }
# A failed migration fails the apply: back to <from>, schema not stamped, so
# the next apply runs it again (migrations are idempotent; the ones that
# passed are not undone).
if ($migFail) {
    $back = Invoke-Git @('checkout', '--quiet', '--detach', $(if ($fromSha) { $fromSha } else { $from })) 60
    Log "rolled back to $from after a failed migration (checkout exit=$($back.code))"
    Write-Failed 'migration failed' $migFail
    exit 1
}
[void](Write-JsonFile -Path $harnessFile -Object ([ordered]@{ tag = $to; sha = $toSha; channel = 'stable'; applied_at = (Get-Date).ToString('o'); schema = [Math]::Max($schemaOld, $schemaNew); migrations = $ran }))
$node = Resolve-Node
if ($node) {
    foreach ($b in (Get-BotList)) {
        $r = Invoke-Bounded -Exe $node -Arguments @((Join-Path $PSScriptRoot 'sync.mjs'), $b) -TimeoutSec (Remaining 10) -Label "sync $b" -WorkingDirectory $BotCorp -Bot $b
        Log "sync ${b}: exit=$($r.ExitCode)"
    }
}
[void](Set-ReleaseStatus -ForTag $to -Status 'applied' -Extra @{ applied_at = (Get-Date).ToString('o'); from = $from })
# a card body left by an older failed apply (Write-Failed) is stale now
Remove-Item -LiteralPath (Join-Path $StateDir 'update_failed_card.md') -Force -ErrorAction SilentlyContinue

# Releases are cumulative: a checkout of <to> carries every older tag with it.
#   upgrade:  a release between <from> and <to> still pending, requested, failed
#             or skipped is now `included` (included_in: <to>), never applied
#             again on its own;
#   roll back: a release above <to> up to <from> that was applied or included
#             is `pending` again, so it can be applied again later.
# The version we left gets an entry when it has none, so it can be rolled back to.
try {
    $now = (Get-Date).ToString('o')
    $toV = ConvertTo-Version $to
    $fromV = ConvertTo-Version $(if ($from -match '^v\d') { $from } else { 'v0.0' })
    $u = Read-Updates
    if ($from -match '^v\d' -and -not @($u.releases | Where-Object { "$($_.tag)" -eq $from })) {
        $rec = [ordered]@{ tag = $from; sha = $fromSha; date = (Invoke-Git @('log', '-1', '--format=%cI', $fromSha) 20).out; status = 'applied'; seen_at = $now }
        Set-Notes $rec (Get-ChangelogNotes -ForTag $from -FromTag)
        $u.releases += $rec
    }
    foreach ($r in $u.releases) {
        $t = "$($r.tag)"; if ($t -eq $to) { continue }
        $v = ConvertTo-Version $t; $s = "$($r.status)"
        if ($toV -gt $fromV -and $v -gt $fromV -and $v -lt $toV -and $s -in @('pending', 'apply_requested', 'failed', 'skipped')) {
            $r['status'] = 'included'; $r['included_in'] = $to; $r['status_at'] = $now
        } elseif ($toV -lt $fromV -and $v -gt $toV -and $v -le $fromV -and $s -in @('applied', 'included')) {
            $r['status'] = 'pending'; $r['rolled_back_to'] = $to; $r['status_at'] = $now
        } elseif ($s -eq 'apply_requested') {
            $r['status'] = 'pending'; $r['status_at'] = $now   # one request at a time: the one just applied answered it
        }
    }
    [void](Save-Updates $u)
    Log "$(if ($toV -lt $fromV) { 'ROLLED BACK' } else { 'upgraded' }) $from -> ${to}: release statuses updated"
} catch { Log "release bookkeeping: swallowed exception (fail-open): $($_.Exception.Message)" }

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
