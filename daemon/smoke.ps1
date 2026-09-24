# smoke.ps1 - the harness smoke test: run after a checkout, before a release is
# applied (daemon/update.ps1 -Apply runs it and rolls back on failure), and in CI.
#
#   pwsh -NoProfile -File daemon/smoke.ps1 [-Bot <name>]
#
# Steps (each named; the first failure names itself and the script exits 1):
#   plugin-validate   claude plugin validate harness --strict
#   pytest            python -m pytest harness/tests -q  (must COLLECT > 0 and pass:
#                     "0 tests collected" reads green to the eye and is a suite error)
#   bash-n            bash -n every harness/hooks/*.sh
#   node-check        node --check on statusline.js, pty-host.mjs, cockpit/server.mjs,
#                     daemon/sync.mjs, daemon/botyaml.mjs
#   hook-session-start / hook-session-end
#                     fake-stdin runs of the two lifecycle hooks against a temp BOT_HOME
#   tick-probe        daemon/tick.ps1 -ProbeOnly exits 0
#   bg-agents         `claude agents --json` parses (REPORT ONLY, never fails: the
#                     supervisor pipe answers only callers with its own elevation,
#                     so a non-elevated run may legitimately see nothing)
#   launch-dryrun     daemon/launch.ps1 -Bot <bot> -DryRun (only with -Bot)
# Exit 0 = every step passed. Never sends Telegram (BOT_TG_MUTE=1 on every child).

param([string]$Bot)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot '_common.ps1')

$results = @()
$failed = @()
$py = Resolve-Python
$node = Resolve-Node
$bash = (Get-Command bash.exe -ErrorAction SilentlyContinue).Source
if (-not $bash) { foreach ($c in @("$env:ProgramFiles\Git\bin\bash.exe", "$env:ProgramFiles\Git\usr\bin\bash.exe")) { if (Test-Path $c) { $bash = $c; break } } }
$claude = Resolve-ClaudeExe
if (-not (Test-Path $claude)) { $claude = $null }

function Step {
    param([string]$Name, [scriptblock]$Body)
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $ok = $false; $detail = ''
    try { $r = & $Body; $ok = [bool]$r.ok; $detail = "$($r.detail)" } catch { $ok = $false; $detail = "exception: $($_.Exception.Message)" }
    $sw.Stop()
    $line = "SMOKE: $Name $(if ($ok) { 'OK' } else { 'FAIL' }) ($([int]$sw.Elapsed.TotalSeconds)s) $detail"
    Write-Host $line -ForegroundColor $(if ($ok) { 'Green' } else { 'Red' })
    $script:results += $line
    if (-not $ok) { $script:failed += $Name }
}

function Run {
    # bounded child, output captured; returns @{ code; out }
    param([string]$Exe, [string[]]$Arguments, [int]$TimeoutSec = 300, [string]$Cwd = $BotCorp, [hashtable]$Env)
    $e = @{ BOT_TG_MUTE = '1'; PYTHONIOENCODING = 'utf-8'; GIT_TERMINAL_PROMPT = '0' }
    if ($Env) { foreach ($k in $Env.Keys) { $e[$k] = $Env[$k] } }
    $r = Invoke-Bounded -Exe $Exe -Arguments $Arguments -TimeoutSec $TimeoutSec -Label "smoke:$([System.IO.Path]::GetFileName($Exe))" -Capture -WorkingDirectory $Cwd -Env $e
    return @{ code = $r.ExitCode; out = "$($r.Output)"; killed = $r.Killed }
}

function Tail { param([string]$Text, [int]$N = 3) return ((($Text -split "`n") | Where-Object { $_.Trim() } | Select-Object -Last $N) -join ' | ') }

Step 'plugin-validate' {
    if (-not $claude) { return @{ ok = $false; detail = 'claude CLI not found' } }
    $r = Run -Exe $claude -Arguments @('plugin', 'validate', $Harness, '--strict') -TimeoutSec 120
    return @{ ok = ($r.code -eq 0 -and $r.out -match 'passed|valid'); detail = (Tail $r.out 2) }
}

Step 'pytest' {
    $r = Run -Exe $py -Arguments @('-m', 'pytest', (Join-Path $Harness 'tests'), '-q', '-p', 'no:cacheprovider') -TimeoutSec 600
    $passed = 0
    if ($r.out -match '(\d+) passed') { $passed = [int]$matches[1] }
    $ok = ($r.code -eq 0 -and $passed -gt 0)
    return @{ ok = $ok; detail = "$passed passed, exit=$($r.code) :: $(Tail $r.out 1)" }
}

Step 'bash-n' {
    if (-not $bash) { return @{ ok = $false; detail = 'bash not found' } }
    $bad = @(); $n = 0
    foreach ($h in (Get-ChildItem (Join-Path $Harness 'hooks') -Filter '*.sh' -File -ErrorAction SilentlyContinue)) {
        $n++
        $r = Run -Exe $bash -Arguments @('-n', $h.FullName) -TimeoutSec 30
        if ($r.code -ne 0) { $bad += "$($h.Name): $(Tail $r.out 1)" }
    }
    return @{ ok = ($n -gt 0 -and $bad.Count -eq 0); detail = "$n hooks$(if ($bad) { '; ' + ($bad -join '; ') })" }
}

Step 'node-check' {
    if (-not $node) { return @{ ok = $false; detail = 'node not found' } }
    $files = @((Join-Path $Harness 'tools\infra\statusline.js'), (Join-Path $PSScriptRoot 'pty-host.mjs'), (Join-Path $BotCorp 'cockpit\server.mjs'), (Join-Path $PSScriptRoot 'sync.mjs'), (Join-Path $PSScriptRoot 'botyaml.mjs'))
    $bad = @()
    foreach ($f in $files) {
        if (-not (Test-Path $f)) { $bad += "$([System.IO.Path]::GetFileName($f)): missing"; continue }
        $r = Run -Exe $node -Arguments @('--check', $f) -TimeoutSec 60
        if ($r.code -ne 0) { $bad += "$([System.IO.Path]::GetFileName($f)): $(Tail $r.out 1)" }
    }
    return @{ ok = ($bad.Count -eq 0); detail = "$($files.Count) files$(if ($bad) { '; ' + ($bad -join '; ') })" }
}

# fake-stdin hook runs against a throwaway BOT_HOME (never a real bot's memory/)
$tmp = Join-Path $env:TEMP ("botcorp-smoke-" + [guid]::NewGuid().ToString('n').Substring(0, 8))
$tmpHome = Join-Path $tmp 'smokebot'
try { New-Item -ItemType Directory -Force -Path (Join-Path $tmpHome 'memory') | Out-Null; New-Item -ItemType Directory -Force -Path (Join-Path $tmpHome '.claude') | Out-Null } catch {}
$hookEnv = @{
    CLAUDE_PLUGIN_ROOT = $Harness; BOT_HOME = $tmpHome; BOT_NAME = 'smokebot'
    BOTCORP_HOME = (Join-Path $tmp 'rt'); CLAUDE_CONFIG_DIR = (Join-Path $tmp 'cfg'); BOT_MODULES = ''
}
function Invoke-HookFakeStdin {
    param([string]$Hook, [string]$Payload)
    if (-not $bash) { return @{ code = -1; out = 'bash not found' } }
    $p = $null
    try {
        $psi = [System.Diagnostics.ProcessStartInfo]::new()
        $psi.FileName = $bash; [void]$psi.ArgumentList.Add((Join-Path $Harness "hooks\$Hook"))
        $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true; $psi.WorkingDirectory = $tmpHome
        $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
        foreach ($k in $hookEnv.Keys) { $psi.Environment[[string]$k] = [string]$hookEnv[$k] }
        $psi.Environment['BOT_TG_MUTE'] = '1'; $psi.Environment['PYTHONIOENCODING'] = 'utf-8'
        $p = [System.Diagnostics.Process]::Start($psi)
        $p.StandardInput.Write($Payload); $p.StandardInput.Close()
        $o = $p.StandardOutput.ReadToEndAsync(); $e = $p.StandardError.ReadToEndAsync()
        if (-not $p.WaitForExit(60000)) { try { $p.Kill($true) } catch {}; return @{ code = -1; out = 'timeout' } }
        return @{ code = $p.ExitCode; out = ($o.Result + "`n" + $e.Result) }
    } catch { return @{ code = -1; out = $_.Exception.Message } }
    finally { if ($p) { $p.Dispose() } }
}

Step 'hook-session-start' {
    $r = Invoke-HookFakeStdin -Hook 'session-start.sh' -Payload '{"session_id":"smoke1"}'
    $ok = ($r.code -eq 0 -and $r.out -match 'hookSpecificOutput' -and (Test-Path (Join-Path $tmpHome 'memory\sessions\smoke1\journal.md')))
    return @{ ok = $ok; detail = "exit=$($r.code) journal=$(Test-Path (Join-Path $tmpHome 'memory\sessions\smoke1\journal.md'))" }
}

Step 'hook-session-end' {
    $r = Invoke-HookFakeStdin -Hook 'session-end.sh' -Payload '{"session_id":"smoke1","reason":"clear"}'
    return @{ ok = ($r.code -eq 0 -and $r.out -match 'session-end: reason=clear'); detail = "exit=$($r.code) $(Tail $r.out 1)" }
}
try { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue } catch {}

Step 'tick-probe' {
    $r = Run -Exe (Resolve-PwshExe) -Arguments @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'tick.ps1'), '-ProbeOnly') -TimeoutSec 240
    return @{ ok = ($r.code -eq 0); detail = "exit=$($r.code) $(Tail $r.out 1)" }
}

Step 'bg-agents' {
    # Report, never fail: [] (or nothing) from a non-elevated shell against an
    # elevated supervisor is expected; a parse error or a missing CLI is noted.
    if (-not $claude) { return @{ ok = $true; detail = 'claude CLI not found (reported, not failed)' } }
    $r = Run -Exe $claude -Arguments @('agents', '--json') -TimeoutSec 60
    $n = -1
    try { $t = "$($r.out)".Trim(); $i = $t.IndexOf('['); $j = $t.LastIndexOf(']'); if ($i -ge 0 -and $j -gt $i) { $n = @(($t.Substring($i, $j - $i + 1)) | ConvertFrom-Json).Count } } catch { $n = -1 }
    $elev = $false; try { $elev = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } catch {}
    $note = if ($n -lt 0) { "exit=$($r.code), no JSON array in the output (reported, not failed)" } elseif ($n -eq 0) { "exit=$($r.code), 0 sessions listed (elevated=$elev; an elevated supervisor is invisible to a non-elevated caller)" } else { "exit=$($r.code), $n session(s) listed (elevated=$elev)" }
    return @{ ok = $true; detail = $note }
}

if ($Bot) {
    Step 'launch-dryrun' {
        $r = Run -Exe (Resolve-PwshExe) -Arguments @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'launch.ps1'), '-Bot', $Bot, '-DryRun') -TimeoutSec 120
        return @{ ok = ($r.code -eq 0 -and $r.out -match 'argv:'); detail = "exit=$($r.code) $(Tail $r.out 1)" }
    }
}

if ($failed.Count -gt 0) { Write-Host "SMOKE FAILED: $($failed -join ', ')" -ForegroundColor Red; exit 1 }
Write-Host "SMOKE PASSED ($($results.Count) steps)" -ForegroundColor Green
exit 0
