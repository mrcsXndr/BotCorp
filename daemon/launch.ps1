# launch.ps1 - launch ONE bot's Claude Code session. The choke point every start
# path uses: manual, the daemon's cold-start, restart.ps1, the visible-launch
# task, and the pty-host (which runs this script inside the ConPTY).
#
#   pwsh -NoProfile -File daemon/launch.ps1 -Bot <name> [-Continue|-Fresh] [-Bg] [-Force]
#        [-StartedBy manual|daemon-cold|daemon-restart|pty|visible] [-InPty] [-DryRun] [-- <claude args>]
#
# Two shapes, picked by -Bg (the daemon passes it for `harness.session: bg`,
# the default; `session: pty` bots run inside daemon/pty-host.mjs without it):
#   foreground  execs `claude` in THIS process (a window, a pty, a terminal);
#               resumes with --continue unless fresh.
#   -Bg         runs `claude --bg ...`, which returns as soon as Claude Code's
#               supervisor accepted the session, records bg_id / session_id /
#               claude_pid in <rt>/state/<bot>.json and EXITS. The session runs
#               under the supervisor (session 0), one conversation across
#               restarts: every relaunch passes --resume <session_id> from the
#               state file (`--bg --continue` would start a COPY). No session
#               id yet (first launch, or -Fresh) = a fresh session; its id is
#               taken from what `claude --bg` prints / `claude agents --json`.
#
# What it does, in order (every pre-step bounded, launch always proceeds):
#   1. reads bots/<name>/bot.yaml (via daemon/botyaml.mjs)
#   2. duplicate-launch guard from <rt>/state/<bot>.json (liveness, not stale pids;
#      for a bg bot also `claude agents --json`)
#   3. optional bounded `git pull` of the BOT repo (harness.git_pull)
#   4. fresh-restart marker (.claude/.botcorp_fresh_restart, < 300 s) overrides -Continue
#      (harness updates are NOT applied here any more: the tick applies an
#      admin-requested release, then restarts the bots - see update.ps1)
#   5. usage-limit resume prompt (.claude/.botcorp_resume_prompt, <= 60 min) becomes the first prompt
#   6. Telegram owner-lock in the bot's CONFIG HOME (one poller per token); a live
#      foreign owner => launch WITHOUT --channels
#   7. vault -> env (in-process DPAPI unprotect; never argv, never printed)
#   8. writes the state record, then execs (or backgrounds) claude with
#      --plugin-dir <BotCorp>/harness; `--channels ... --settings <tg-enable>` LAST
#
# -DryRun prints the exact exe + argv and the env with secrets masked (****last4)
# and exits 0. Fail-open everywhere except "no bot.yaml" / "bot.yaml invalid".

param(
    [Parameter(Mandatory)][string]$Bot,
    [switch]$Continue,
    [switch]$Fresh,
    [switch]$Bg,
    [switch]$Force,
    [string]$StartedBy = 'manual',
    [switch]$InPty,
    [switch]$DryRun,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Passthrough
)

$ErrorActionPreference = 'Continue'

if ($Continue -and $Fresh) { Write-Host 'launch: -Continue and -Fresh are mutually exclusive.' -ForegroundColor Red; exit 1 }
if ($Bg -and $InPty) { Write-Host 'launch: -Bg and -InPty are mutually exclusive (a bg session has no pty of ours).' -ForegroundColor Red; exit 1 }
if ($Bot -notmatch '^[a-z0-9][a-z0-9-]{0,31}$') { Write-Host "launch: bad bot name '$Bot'" -ForegroundColor Red; exit 1 }

# _common.ps1 gives the Claude Code specifics (Resolve-ClaudeExe, Get-ClaudeEnv,
# Get-ClaudeArgv), the bg helpers and the paths; it exports BOTCORP_HOME.
. (Join-Path $PSScriptRoot '_common.ps1')

$BotHome   = Join-Path $BotsDir $Bot
$ConfigDir = Join-Path $BotHome ".claude-$Bot"
$StateFile = Join-Path $StateDir "$Bot.json"
$LogDir    = Join-Path $LogsDir $Bot
$LaunchLog = Join-Path $LogDir 'launches.log'

if (-not (Test-Path (Join-Path $BotHome 'bot.yaml'))) { Write-Host "launch: no bot at $BotHome (bot.yaml missing)" -ForegroundColor Red; exit 1 }
foreach ($d in @($StateDir, $LogDir, (Join-Path $ConfigDir 'botcorp'), (Join-Path $BotHome '.claude'))) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
}

function Write-LaunchLog { param([string]$Message)
    try { "$((Get-Date).ToString('o'))  [$Bot] $Message" | Out-File -FilePath $LaunchLog -Append -Encoding utf8 } catch {}
    Write-Host "  $Message" -ForegroundColor DarkGray
}
function Mask { param([string]$V) if (-not $V) { return '' }; return '****' + $V.Substring([Math]::Max(0, $V.Length - 4)) }
function Read-State { return (Read-JsonFile -Path $StateFile) }
function Write-State { param([hashtable]$Updates) Write-BotState -Bot $Bot -Updates $Updates }

# --- 1. bot.yaml ------------------------------------------------------------------
$node = Resolve-Node
if (-not $node) { Write-Host 'launch: node.exe not found (needed to read bot.yaml)' -ForegroundColor Red; exit 1 }
$cfgJson = & $node (Join-Path $PSScriptRoot 'botyaml.mjs') (Join-Path $BotHome 'bot.yaml') 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "launch: bot.yaml unreadable: $cfgJson" -ForegroundColor Red; exit 1 }
$cfg = ($cfgJson | ConvertFrom-Json)
if ($cfg._errors -and $cfg._errors.Count -gt 0) { Write-Host "launch: bot.yaml invalid: $($cfg._errors -join '; ')" -ForegroundColor Red; exit 1 }
$modules  = @($cfg._modules)
$hasTgMod = $modules -contains 'telegram'
$botService = Get-BotSessionKind $cfg
$exe = Resolve-ClaudeExe

# --- 2. duplicate-launch guard --------------------------------------------------
if (-not $Force) {
    $st = Read-State
    if ($st) {
        $shellPid = 0; $cliPid = 0; $bgId = ''
        try { if ($null -ne $st.shell_pid) { $shellPid = [int]$st.shell_pid } } catch {}
        try { if ($null -ne $st.claude_pid) { $cliPid = [int]$st.claude_pid } } catch {}
        try { if ($st.PSObject.Properties.Name -contains 'bg_id') { $bgId = "$($st.bg_id)" } } catch {}
        $shellLive = (Test-ProcAlive $shellPid @('pwsh','powershell')) -and ((Get-ClaudeChildPid $shellPid) -gt 0)
        $cliLive = Test-ProcAlive $cliPid @('claude')
        $bgLive = $false
        if ($bgId -and -not $cliLive) {
            $agents = Get-BgAgents -Bot $Bot -TimeoutSec 20
            $bgLive = Test-BgAgentAlive (Find-BgAgent -Agents $agents -BgId $bgId -SessionId "$($st.session_id)" -BotHome $BotHome)
        }
        if ($shellLive -or $cliLive -or $bgLive) {
            Write-Host "  $Bot already running (shell_pid=$shellPid claude_pid=$cliPid bg_id=$bgId) - refusing a duplicate. Use -Force." -ForegroundColor Yellow
            exit 0
        }
    }
}

# --- 3. bounded pre-step ----------------------------------------------------------
function Invoke-PreStep { param([string]$Exe, [string[]]$Arguments, [int]$TimeoutSec, [string]$Label)
    $r = Invoke-Bounded -Exe $Exe -Arguments $Arguments -TimeoutSec $TimeoutSec -Label $Label -WorkingDirectory $BotHome -Bot $Bot
    if ($r.Killed) { Write-LaunchLog "$Label timed out after ${TimeoutSec}s -> tree killed; launching anyway" }
    else { Write-LaunchLog "$Label exit=$($r.ExitCode)" }
}
# No credential prompts of any kind in a headless context (session 0 has no
# vault and no UI; an unbounded prompt there piled up 160 launchers once).
$prevGitPrompt = $env:GIT_TERMINAL_PROMPT; $prevGcm = $env:GCM_INTERACTIVE
$env:GIT_TERMINAL_PROMPT = '0'; $env:GCM_INTERACTIVE = 'never'
if ($cfg.harness.git_pull -eq $true -and (Test-Path (Join-Path $BotHome '.git')) -and -not $DryRun) {
    Invoke-PreStep -Exe 'git' -Arguments @('-c','credential.interactive=never','-c','core.askPass=','pull','--rebase','--autostash') -TimeoutSec 45 -Label 'git pull (bot repo)'
}
$env:GIT_TERMINAL_PROMPT = $prevGitPrompt; $env:GCM_INTERACTIVE = $prevGcm

# --- 4. continue vs fresh ---------------------------------------------------------
# A marker younger than 300 s can only have been dropped by a declared roll
# seconds ago; it overrides -Continue. One-shot: read + delete. The daemon's own
# restart path never creates one, so a normal restart keeps the long-running
# context (killing it mid-work is the failure this guards against).
$freshMarker = Join-Path $BotHome '.claude\.botcorp_fresh_restart'
$forceFresh = $false
try {
    if (Test-Path $freshMarker) {
        $age = ((Get-Date) - (Get-Item $freshMarker).LastWriteTime).TotalSeconds
        if (-not $DryRun) { Remove-Item $freshMarker -Force -ErrorAction SilentlyContinue }
        if ($age -lt 300) { $forceFresh = $true }
    }
} catch {}
$resume = $true
if ($forceFresh) { $resume = $false; Write-LaunchLog 'fresh marker present -> START FRESH (journal/timeline/recall rebuild context)' }
elseif ($Fresh) { $resume = $false; Write-LaunchLog '-Fresh -> START FRESH' }
elseif ($Continue) { Write-LaunchLog '-Continue -> resuming last session' }
elseif ($Bg -or $InPty -or $DryRun -or -not [Environment]::UserInteractive) { Write-LaunchLog 'non-interactive -> resume (default)' }
else {
    Write-Host "  [1] Continue last session (default)   [2] Start fresh" -ForegroundColor Cyan
    $choice = Read-Host '  Choice (1/2, blank=1)'
    $resume = ($choice -ne '2')
}
# bg: the resume handle is the recorded session id (the SessionStart hook and
# this script both write it). None recorded = a fresh session, by necessity.
$resumeId = ''
if ($Bg -and $resume) {
    try { $st0 = Read-State; if ($st0 -and ($st0.PSObject.Properties.Name -contains 'session_id') -and "$($st0.session_id)" -match '^[0-9a-f-]{16,}$') { $resumeId = "$($st0.session_id)" } } catch {}
    if ($resumeId) { Write-LaunchLog "bg: --resume $resumeId (same conversation)" } else { Write-LaunchLog 'bg: no session id recorded -> fresh background session' }
}

# --- 5. usage-limit resume prompt -------------------------------------------------
$resumeFile = Join-Path $BotHome '.claude\.botcorp_resume_prompt'
try {
    if (Test-Path $resumeFile) {
        $ageMin = ((Get-Date) - (Get-Item $resumeFile).LastWriteTime).TotalMinutes
        $seed = (Get-Content $resumeFile -Raw -ErrorAction Stop).Trim()
        if (-not $DryRun) { Remove-Item $resumeFile -Force -ErrorAction SilentlyContinue }
        if ($ageMin -le 60 -and $seed) { Write-LaunchLog 'auto-resume: seeding the first prompt from usage-limit recovery'; $Passthrough = @($Passthrough | Where-Object { $_ }) + @($seed) }
        else { Write-LaunchLog "auto-resume file stale ($([int]$ageMin)m) - ignored" }
    }
} catch {}

# --- 6. Telegram owner-lock (per config home) -------------------------------------
# The lock names the process that owns the poller: this launcher for a
# foreground launch (it is claude's parent), the claude worker pid for a bg
# launch (rewritten once known; this launcher exits right away).
$lockFile   = Join-Path $ConfigDir 'botcorp\tg_owner.lock'
$botPidFile = Join-Path $ConfigDir 'channels\telegram\bot.pid'
$canOwn = $hasTgMod
if ($hasTgMod -and (Test-Path $lockFile)) {
    $ownerPid = 0
    try { $ownerPid = Get-FirstPid ((Get-Content $lockFile -ErrorAction SilentlyContinue | Select-Object -First 1)) } catch {}
    $botPidAlive = $false
    if (Test-Path $botPidFile) { try { $botPidAlive = Test-ProcAlive (Get-FirstPid ((Get-Content $botPidFile -ErrorAction SilentlyContinue | Select-Object -First 1))) } catch {} }
    if ((Test-ProcAlive $ownerPid) -and $botPidAlive -and ($ownerPid -ne $PID)) {
        $canOwn = $false
        Write-LaunchLog "another process (pid $ownerPid) owns this bot's Telegram poller -> launching WITHOUT --channels"
    } else { Write-LaunchLog "reclaiming stale Telegram owner-lock (owner $ownerPid / bot.pid dead)" }
}
if ($canOwn -and -not $DryRun) {
    try { [System.IO.File]::WriteAllText($lockFile, "$PID`n$((Get-Date).ToString('o'))") } catch { Write-LaunchLog 'could not write owner-lock (non-fatal)' }
}

# --- 7. vault -> env --------------------------------------------------------------
. (Join-Path $PSScriptRoot 'vault.ps1')
$ErrorActionPreference = 'Continue'   # vault.ps1 sets Stop for itself
$secrets = @{}
$vaultNote = @()
try {
    # Vault FIRST. A machine-wide CLAUDE_CODE_OAUTH_TOKEN (HKCU user env) is
    # some other bot's account; inheriting it would bill this bot there. The
    # env is only a fallback for a bot with no vault entry.
    $t = Get-VaultSecret -BotHome $BotHome -Bot $Bot -Key 'oauth_token'
    if ($t) { $secrets['oauth_token'] = $t; $vaultNote += "oauth: vault ok ($(Mask $t))" }
    elseif ($env:CLAUDE_CODE_OAUTH_TOKEN) { $vaultNote += "oauth: no vault entry -> inheriting the environment token ($(Mask $env:CLAUDE_CODE_OAUTH_TOKEN)); set this bot's own with: botcorp secrets set $Bot oauth" }
    else { $vaultNote += 'oauth: no vault entry -> the session will need /login' }
    if ($hasTgMod -and $canOwn) {
        $tt = Get-VaultSecret -BotHome $BotHome -Bot $Bot -Key 'telegram_token'
        if ($tt) {
            $secrets['telegram_token'] = $tt; $vaultNote += "telegram: vault ok ($(Mask $tt))"
            if ($cfg.harness.telegram_token_file -eq $true -and -not $DryRun) {
                # Fallback for a plugin whose MCP server does not inherit the env:
                # the file the plugin reads, ACL'd to the user. Not "encrypted by BotCorp".
                $tgDir = Join-Path $ConfigDir 'channels\telegram'
                if (-not (Test-Path $tgDir)) { New-Item -ItemType Directory -Force -Path $tgDir | Out-Null }
                [System.IO.File]::WriteAllText((Join-Path $tgDir '.env'), "TELEGRAM_BOT_TOKEN=$tt`n")
                & (Join-Path $env:SystemRoot 'System32\icacls.exe') (Join-Path $tgDir '.env') /inheritance:r /grant:r "$env:USERDOMAIN\$env:USERNAME:F" 2>&1 | Out-Null
                $vaultNote += 'telegram: token file written (harness.telegram_token_file)'
            }
        } else { $vaultNote += 'telegram: module on but no vault entry -> launching WITHOUT --channels'; $canOwn = $false }
    }
} catch { $vaultNote += "vault unreadable ($($_.Exception.Message -replace '[A-Za-z0-9_-]{30,}','****')) - re-enter tokens with: botcorp secrets set $Bot oauth" }
foreach ($n in $vaultNote) { Write-LaunchLog $n }

# --- 8. env + argv + state, then exec / background ---------------------------------
$childEnv = Get-ClaudeEnv -ConfigDir $ConfigDir -Secrets $secrets
$childEnv['BOT_HOME']            = $BotHome
$childEnv['BOT_NAME']            = $Bot
$childEnv['BOT_MODULES']         = ($modules -join ',')
$childEnv['BOT_DISABLED_HOOKS']  = (@($cfg.harness.hooks_disable) -join ',')
$childEnv['BOT_HAS_TG']          = $(if ($canOwn) { '1' } else { '0' })
$childEnv['BOT_LAUNCHER_PID']    = "$PID"
$childEnv['BOTCORP_HOME']        = $RtHome
$childEnv['CLAUDE_CODE_ARTIFACT_AUTO_OPEN'] = '0'
$childEnv['PYTHONIOENCODING']    = 'utf-8'
$childEnv['GIT_TERMINAL_PROMPT'] = '0'
$py = Resolve-Python
if (Test-Path $py) { $childEnv['BOT_PYTHON'] = $py }
# OpenTelemetry to the local sink (prompts/tool details stay redacted: no OTEL_LOG_* gates).
$otelState = Join-Path $StateDir 'otel.json'
if (($modules -contains 'telemetry') -and (Test-Path $otelState)) {
    try {
        $o = Get-Content $otelState -Raw | ConvertFrom-Json
        if ($o.port) {
            $childEnv['CLAUDE_CODE_ENABLE_TELEMETRY'] = '1'
            $childEnv['OTEL_LOGS_EXPORTER'] = 'otlp'; $childEnv['OTEL_METRICS_EXPORTER'] = 'otlp'
            $childEnv['OTEL_EXPORTER_OTLP_PROTOCOL'] = 'http/json'
            $childEnv['OTEL_EXPORTER_OTLP_ENDPOINT'] = "http://127.0.0.1:$($o.port)"
            $childEnv['OTEL_RESOURCE_ATTRIBUTES'] = "bot.name=$Bot"
        }
    } catch {}
}

$argv = Get-ClaudeArgv -Bg ([bool]$Bg) -ResumeId $resumeId -Continue $resume -Permissions $cfg.permissions -PluginDir $Harness -Channels $canOwn `
                       -TgSettings (Join-Path $BotHome '.claude\tg-enable.settings.json') -Passthrough $Passthrough
$modeText = if ($Bg) { $(if ($resumeId) { "--bg --resume $resumeId" } else { '--bg FRESH' }) } elseif ($resume) { '--continue' } else { 'FRESH' }

if ($DryRun) {
    Write-Host ''
    Write-Host "  exe : $exe"
    Write-Host "  argv: $($argv -join ' ')"
    Write-Host "  cwd : $BotHome"
    foreach ($k in ($childEnv.Keys | Sort-Object)) {
        $v = $childEnv[$k]
        if ($k -in @('CLAUDE_CODE_OAUTH_TOKEN','TELEGRAM_BOT_TOKEN')) { $v = Mask $v }
        Write-Host "  env : $k=$v"
    }
    Write-Host "  mode: $modeText  service: $botService  poller: $(if ($canOwn) { 'OWNED' } elseif ($hasTgMod) { 'FOREIGN' } else { 'n/a' })"
    exit 0
}

Write-State @{
    bot = $Bot; claude_pid = $null; shell_pid = $(if ($Bg) { $null } else { $PID })
    started_at = (Get-Date).ToString('o'); started_by = $StartedBy; updated_at = (Get-Date).ToString('o')
    poller = $(if ($canOwn) { 'OWNED' } elseif ($hasTgMod) { 'FOREIGN' } else { 'NONE' }); status = 'starting'
    in_pty = [bool]$InPty; resume = $resume; service = $(if ($Bg) { 'bg' } else { 'fg' })
}
if ($Bg -and -not $resumeId) { Write-State @{ session_id = $null; bg_id = $null } }
Write-LaunchLog "launch shell_pid=$PID started_by=$StartedBy mode=$modeText channels=$canOwn"

# Inherited from a parent Claude Code session these make the child run with
# transcript saving OFF (CC 2.1.281 "inherited CLAUDE_CODE_CHILD_SESSION marker").
foreach ($k in 'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT') { Remove-Item -Path "env:$k" -ErrorAction SilentlyContinue }
foreach ($k in $childEnv.Keys) { Set-Item -Path "env:$k" -Value $childEnv[$k] }
Set-Location $BotHome

if ($Bg) {
    # `claude --bg` prints the id `claude attach` takes (plus a `note:` line
    # when it could not continue the session in place) and exits; the session
    # runs under the supervisor. Bounded: a hung client must not hold the tick.
    $code = 1
    try {
        $r = Invoke-Bounded -Exe $exe -Arguments $argv -TimeoutSec 120 -Label 'claude --bg' -Capture -Env $childEnv -WorkingDirectory $BotHome -Bot $Bot
        $code = $(if ($null -eq $r.ExitCode) { 124 } else { $r.ExitCode })
        $outLines = @(("$($r.Output)" -split "`n") | ForEach-Object { $_.Trim() } | Where-Object { $_ })
        foreach ($ln in $outLines) { Write-LaunchLog "bg: $ln" }
        $bgId = ''
        foreach ($ln in $outLines) {
            # the short id is a lone hex token, on its own line or after "id:"/"attach"
            if ($ln -match '(?:^|\s|:)([0-9a-f]{6,12})(?:\s|$)' -and $ln -notmatch '^note:') { $bgId = $matches[1]; if ($ln -match '^[0-9a-f]{6,12}$' -or $ln -match 'attach') { break } }
        }
        # Roster lookup: the authoritative id + pid + full session id. Poll a
        # few seconds - the worker is spawned by the supervisor, not by us, so
        # the CIM child-of-launcher trick does not apply here.
        $found = $null
        $until = (Get-Date).AddSeconds(20)
        while ((Get-Date) -lt $until) {
            $agents = Get-BgAgents -Bot $Bot -TimeoutSec 20
            $found = Find-BgAgent -Agents $agents -BgId $bgId -SessionId $resumeId -BotHome $BotHome
            if ($found -and (($found.PSObject.Properties.Name -contains 'pid') -and $found.pid)) { break }
            Start-Sleep -Milliseconds 1500
        }
        $cpid = 0; $sid = $resumeId
        if ($found) {
            try { if ($found.PSObject.Properties.Name -contains 'id') { $bgId = "$($found.id)" } } catch {}
            try { if (($found.PSObject.Properties.Name -contains 'sessionId') -and $found.sessionId) { $sid = "$($found.sessionId)" } } catch {}
            try { if (($found.PSObject.Properties.Name -contains 'pid') -and $found.pid) { $cpid = [int]$found.pid } } catch {}
        }
        if ($code -eq 0 -and -not $bgId -and -not $found) { Write-LaunchLog 'bg: claude --bg returned 0 but no id could be read (state left as starting; the tick re-checks the roster)' }
        $upd = @{ claude_pid = $(if ($cpid -gt 0) { $cpid } else { $null }); bg_id = $(if ($bgId) { $bgId } else { $null }); status = $(if ($code -eq 0) { 'running' } else { 'exited' }); exit_code = $code; updated_at = (Get-Date).ToString('o') }
        if ($sid) { $upd['session_id'] = $sid }
        Write-State $upd
        if ($canOwn -and $cpid -gt 0) { try { [System.IO.File]::WriteAllText($lockFile, "$cpid`n$((Get-Date).ToString('o'))") } catch {} }
        Write-LaunchLog "bg: id=$bgId session=$sid claude_pid=$cpid exit=$code"
    } catch { Write-LaunchLog "bg launch failed: $($_.Exception.Message)"; Write-State @{ status = 'exited'; exit_code = 1; updated_at = (Get-Date).ToString('o') } }
    finally {
        foreach ($k in @('CLAUDE_CODE_OAUTH_TOKEN','TELEGRAM_BOT_TOKEN')) { if ($secrets.Count -gt 0) { Remove-Item "env:$k" -ErrorAction SilentlyContinue } }
        # The owner-lock is NOT released here: the session is still running.
        # A failed launch leaves our own pid in it, which reads as stale (dead)
        # to the next launcher and is reclaimed.
    }
    exit $code
}

try {
    & $exe @argv
    $code = $LASTEXITCODE
} finally {
    Write-State @{ status = 'exited'; exit_code = $code; updated_at = (Get-Date).ToString('o'); claude_pid = $null }
    # Release our own owner-lock only (SessionEnd does the same from inside;
    # this covers a kill that never fired the hook).
    try {
        if ($canOwn -and (Test-Path $lockFile) -and ((Get-FirstPid ((Get-Content $lockFile | Select-Object -First 1))) -eq $PID)) { Remove-Item $lockFile -Force -ErrorAction SilentlyContinue }
    } catch {}
    foreach ($k in @('CLAUDE_CODE_OAUTH_TOKEN','TELEGRAM_BOT_TOKEN')) { if ($secrets.Count -gt 0) { Remove-Item "env:$k" -ErrorAction SilentlyContinue } }
}
exit $code
