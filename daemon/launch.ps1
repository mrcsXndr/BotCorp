# launch.ps1 - launch ONE bot's Claude Code session. The choke point every start
# path uses: manual, the daemon's cold-start, restart.ps1, the visible-launch
# task, and the pty-host (which runs this script inside the ConPTY).
#
#   pwsh -NoProfile -File daemon/launch.ps1 -Bot <name> [-Continue|-Fresh] [-Bg] [-Force]
#        [-StartedBy manual|daemon-cold|daemon-restart|pty|visible] [-InPty] [-DebugLog] [-DryRun] [-- <claude args>]
#   -DebugLog  this launch writes a Claude Code debug log to <config>/debug/ (bot.yaml harness.debug: every launch)
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
#      --plugin-dir <BotCorp>/harness; `--channels ... --settings <tg-enable>` LAST.
#      -Bg first stops the config home's Claude Code daemon when it has no live
#      session: a bg session runs with the env of whoever STARTED that daemon,
#      so an older daemon would hand it no Telegram token (Get-BgDaemon). After
#      the launch, the poller is checked (bot.pid alive under this claude) and
#      the state records poller OWNED / DEAD.
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
    [switch]$DebugLog,
    [switch]$DryRun,
    [string]$LaunchNonce,                 # attestation (else env BOTCORP_LAUNCH_NONCE); without a valid one: NO secrets
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Passthrough
)

$ErrorActionPreference = 'Continue'

if ($Continue -and $Fresh) { Write-Host 'launch: -Continue and -Fresh are mutually exclusive.' -ForegroundColor Red; exit 1 }
if ($Bg -and $InPty) { Write-Host 'launch: -Bg and -InPty are mutually exclusive (a bg session has no pty of ours).' -ForegroundColor Red; exit 1 }
if ($Bot -notmatch '^[a-z0-9][a-z0-9-]{0,31}$') { Write-Host "launch: bad bot name '$Bot'" -ForegroundColor Red; exit 1 }

# _common.ps1 gives the Claude Code specifics (Resolve-ClaudeExe, Get-ClaudeEnv,
# Get-ClaudeArgv), the bg helpers and the paths; it exports BOTCORP_HOME.
. (Join-Path $PSScriptRoot '_common.ps1')

# The raw nonce arrives in the environment (never on disk); take it out of the
# environment at once so nothing we spawn inherits it.
if (-not $LaunchNonce -and $env:BOTCORP_LAUNCH_NONCE) { $LaunchNonce = $env:BOTCORP_LAUNCH_NONCE }
Remove-Item Env:BOTCORP_LAUNCH_NONCE -ErrorAction SilentlyContinue

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

# --- 1b. attestation ---------------------------------------------------------------
# A trusted start path (daemon tick, restart.ps1, launch-visible.ps1, botcorp
# start) minted a nonce whose hash is in state/<bot>.json. No valid nonce =
# this launch was started some other way: it still runs, WITHOUT secrets (and
# so without the Telegram poller), and says so.
$attested = $false
if ($LaunchNonce) { try { $attested = [bool](Test-LaunchNonce -Bot $Bot -Nonce $LaunchNonce) } catch { $attested = $false } }
if (-not $attested) { Write-LaunchLog "unattested launch: no secrets injected (use botcorp start $Bot)" }

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
$canOwn = $hasTgMod -and $attested
if ($hasTgMod -and -not $attested) { Write-LaunchLog 'telegram: unattested launch has no token -> launching WITHOUT --channels' }
if ($canOwn -and (Test-Path $lockFile)) {
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

# --- 7. vault -> env (ONLY the keys bot.yaml declares under `secrets:`) -----------
# (vault.ps1 comes in through _common.ps1.) Every decrypt carries the launch
# nonce: Get-VaultSecret -Reason launch refuses without a valid one, so an
# unattested launch skips the block entirely.
$secrets = @{}
$vaultNote = @()
$tokenFile = ''
$declared = @(); try { $declared = @($cfg.secrets | Where-Object { $_ }) } catch {}
if (-not $attested) { $vaultNote += 'vault: skipped (unattested launch)' }
else { try {
    # Vault FIRST. A machine-wide CLAUDE_CODE_OAUTH_TOKEN (HKCU user env) is
    # some other bot's account; inheriting it would bill this bot there. The
    # env is only a fallback for a bot with no vault entry.
    $t = $null
    if ($declared -contains 'oauth_token') { $t = Get-VaultSecret -BotHome $BotHome -Bot $Bot -Key 'oauth_token' -Reason 'launch' -Nonce $LaunchNonce }
    else { $vaultNote += 'oauth: oauth_token not in bot.yaml secrets: -> not injected' }
    if ($t) { $secrets['oauth_token'] = $t; $vaultNote += "oauth: vault ok ($(Mask $t))" }
    elseif ($env:CLAUDE_CODE_OAUTH_TOKEN) { $vaultNote += "oauth: no vault entry -> inheriting the environment token ($(Mask $env:CLAUDE_CODE_OAUTH_TOKEN)); set this bot's own with: botcorp secrets set $Bot oauth" }
    else { $vaultNote += 'oauth: no vault entry -> the session will need /login' }
    if ($hasTgMod -and $canOwn) {
        $tt = $null
        if ($declared -contains 'telegram_token') { $tt = Get-VaultSecret -BotHome $BotHome -Bot $Bot -Key 'telegram_token' -Reason 'launch' -Nonce $LaunchNonce }
        else { $vaultNote += 'telegram: telegram_token not in bot.yaml secrets: -> launching WITHOUT --channels'; $canOwn = $false }
        if ($tt) {
            $secrets['telegram_token'] = $tt; $vaultNote += "telegram: vault ok ($(Mask $tt))"
            if ($cfg.harness.telegram_token_file -eq $true -and -not $DryRun) {
                # Fallback for a plugin whose MCP server does not inherit the env:
                # the file the plugin reads, ACL'd to the user. Not "encrypted by
                # BotCorp", so it is transient: deleted as soon as the plugin has
                # read it (bot.pid under this session's claude) or the wait ran
                # out (Complete-TgTokenFile), and on every failure path.
                $tgDir = Join-Path $ConfigDir 'channels\telegram'
                if (-not (Test-Path $tgDir)) { New-Item -ItemType Directory -Force -Path $tgDir | Out-Null }
                $tokenFile = Join-Path $tgDir '.env'
                [System.IO.File]::WriteAllText($tokenFile, '')
                # "${env:USERNAME}:F", braced: "$env:USERNAME:F" expands to an empty name
                & (Join-Path $env:SystemRoot 'System32\icacls.exe') $tokenFile /inheritance:r /grant:r "${env:USERDOMAIN}\${env:USERNAME}:F" 2>&1 | Out-Null
                [System.IO.File]::WriteAllText($tokenFile, "TELEGRAM_BOT_TOKEN=$tt`n")
                $vaultNote += 'telegram: transient token file written (harness.telegram_token_file; removed once the plugin has read it)'
            }
        } elseif ($declared -contains 'telegram_token') { $vaultNote += 'telegram: module on but no vault entry -> launching WITHOUT --channels'; $canOwn = $false }
    }
    # Every other declared key reaches the session under its UPPERCASE name.
    foreach ($k in @($declared | Where-Object { $_ -notin @('oauth_token', 'telegram_token') })) {
        $v = $null
        try { $v = Get-VaultSecret -BotHome $BotHome -Bot $Bot -Key "$k" -Reason 'launch' -Nonce $LaunchNonce } catch { $vaultNote += "${k}: unreadable - re-enter it with: botcorp secrets set $Bot $k" }
        if ($v) { $secrets["$k"] = $v; $vaultNote += "${k}: vault ok ($(Mask $v))" } else { $vaultNote += "${k}: declared in secrets: but no vault entry" }
    }
    # Present-but-undeclared keys are named, never decrypted.
    try {
        $undeclared = @((Read-VaultStore $BotHome).Keys | Where-Object { $_ -notin $declared })
        if ($undeclared.Count -gt 0) { $vaultNote += "undeclared vault key(s) NOT injected: $($undeclared -join ', ') (add to bot.yaml secrets: to inject)" }
    } catch {}
} catch {
    $m = "$($_.Exception.Message)" -replace '[A-Za-z0-9_-]{30,}', '****'
    if ($m -match 'is locked') { $vaultNote += "vault LOCKED - no secrets injected ($m)"; if ($canOwn) { $canOwn = $false; $vaultNote += 'telegram: no token while locked -> launching WITHOUT --channels' } }
    else { $vaultNote += "vault unreadable ($m) - re-enter tokens with: botcorp secrets set $Bot oauth" }
} }
foreach ($n in $vaultNote) { Write-LaunchLog $n }

# --- 8. env + argv + state, then exec / background ---------------------------------
$childEnv = Get-ClaudeEnv -ConfigDir $ConfigDir -Secrets $secrets
$secretEnvNames = @($secrets.Keys | ForEach-Object { Get-SecretEnvName $_ })
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

# Opt-in Claude Code debug log (bot.yaml harness.debug, or -DebugLog for one
# launch): the session's own log, with the MCP servers' stderr, in the config
# home (gitignored, user-only), so a poller that never came up says why. The
# newest 10 are kept.
$debugFile = Get-DebugLogPath -ConfigDir $ConfigDir -Enabled ([bool]$DebugLog -or $cfg.harness.debug -eq $true) -Stamp (Get-Date -Format 'yyyyMMdd-HHmmss')
if ($debugFile) {
    if (-not $DryRun) {
        try {
            New-Item -ItemType Directory -Force -Path (Split-Path $debugFile -Parent) | Out-Null
            Get-ChildItem (Split-Path $debugFile -Parent) -Filter '*.txt' -File | Sort-Object LastWriteTime -Descending | Select-Object -Skip 9 | Remove-Item -Force -ErrorAction SilentlyContinue
        } catch {}
    }
    $Passthrough = @('--debug-file', $debugFile) + @($Passthrough | Where-Object { $_ })
    Write-LaunchLog "debug: --debug-file $debugFile ($(if ($DebugLog) { '-DebugLog' } else { 'harness.debug' }))"
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
        if ($k -in $secretEnvNames) { $v = Mask $v }
        Write-Host "  env : $k=$v"
    }
    Write-Host "  mode: $modeText  service: $botService  poller: $(if ($canOwn) { 'OWNED' } elseif ($hasTgMod) { 'FOREIGN' } else { 'n/a' })  attested: $(if ($attested) { 'yes' } else { 'NO (no secrets would be injected)' })"
    if ($Bg) {
        $dmn = Get-BgDaemon -ConfigDir $ConfigDir
        $live = 0
        if ($dmn.Alive) { $agents = Get-BgAgents -Bot $Bot -TimeoutSec 20; $live = $(if ($null -eq $agents) { -1 } else { @(@($agents) | Where-Object { Test-BgAgentAlive $_ }).Count }) }
        Write-Host "  daemon: $(Get-BgDaemonAction -DaemonAlive $dmn.Alive -LiveWorkers $live) (pid $($dmn.Pid) alive=$($dmn.Alive) live sessions=$live)"
    }
    exit 0
}

Write-State @{
    bot = $Bot; claude_pid = $null; shell_pid = $(if ($Bg) { $null } else { $PID })
    started_at = (Get-Date).ToString('o'); started_by = $StartedBy; updated_at = (Get-Date).ToString('o')
    poller = $(if ($canOwn) { 'OWNED' } elseif ($hasTgMod) { 'FOREIGN' } else { 'NONE' }); status = 'starting'
    in_pty = [bool]$InPty; resume = $resume; service = $(if ($Bg) { 'bg' } else { 'fg' })
    env_launcher_pid = $PID; session_env = $null   # not launcher_pid: the tick's hung-launcher tracking owns that key
}
if ($Bg -and -not $resumeId) { Write-State @{ session_id = $null; bg_id = $null } }
Write-LaunchLog "launch shell_pid=$PID started_by=$StartedBy mode=$modeText channels=$canOwn"
# What this launch puts in the session's env, last 4 only: the session's
# BOT_LAUNCHER_PID points back here (Add-LaunchEnvRecord, Get-SessionEnvCheck).
$oauthSrc = $(if ($secrets.ContainsKey('oauth_token')) { 'vault' } elseif ($env:CLAUDE_CODE_OAUTH_TOKEN) { 'inherited' } else { 'none' })
$oauthVal = $(if ($oauthSrc -eq 'vault') { $secrets['oauth_token'] } elseif ($oauthSrc -eq 'inherited') { $env:CLAUDE_CODE_OAUTH_TOKEN } else { '' })
[void](Add-LaunchEnvRecord -ConfigDir $ConfigDir -LauncherPid $PID -OauthLast4 ((Mask $oauthVal) -replace '^\*+') -OauthSource $oauthSrc `
                           -TelegramLast4 ((Mask "$($secrets['telegram_token'])") -replace '^\*+') -At ((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')))
$launchT0 = (Get-Date).AddSeconds(-2)

# Inherited from a parent Claude Code session these make the child run with
# transcript saving OFF (CC 2.1.281 "inherited CLAUDE_CODE_CHILD_SESSION marker").
foreach ($k in 'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'BOTCORP_LAUNCH_NONCE') { Remove-Item -Path "env:$k" -ErrorAction SilentlyContinue }
foreach ($k in $childEnv.Keys) { Set-Item -Path "env:$k" -Value $childEnv[$k] }
Set-Location $BotHome

if ($Bg) {
    # `claude --bg` prints the id `claude attach` takes (plus a `note:` line
    # when it could not continue the session in place) and exits; the session
    # runs under the supervisor. Bounded: a hung client must not hold the tick.
    $code = 1
    try {
        # The session gets the env of whoever started the config home's daemon,
        # not ours (Get-BgDaemon). A daemon with no live session is stopped so
        # the one `claude --bg` starts now carries this launch's env; a worker
        # `claude stop` just ended is given a few seconds to settle first.
        $paths = Get-BotPaths -Bot $Bot
        $until = (Get-Date).AddSeconds(10)
        while ($true) {
            $dmn = Get-BgDaemon -ConfigDir $ConfigDir
            $live = 0
            if ($dmn.Alive) {
                $agents = Get-BgAgents -Bot $Bot -Paths $paths -TimeoutSec 20
                $live = $(if ($null -eq $agents) { -1 } else { @(@($agents) | Where-Object { Test-BgAgentAlive $_ }).Count })
            }
            $dmnAction = Get-BgDaemonAction -DaemonAlive $dmn.Alive -LiveWorkers $live
            if ($dmnAction -ne 'inherit' -or (Get-Date) -ge $until) { break }
            Start-Sleep -Milliseconds 1500
        }
        if ($dmnAction -eq 'recycle') {
            $gone = Stop-BgDaemon -Bot $Bot -Paths $paths -DaemonPid $dmn.Pid
            if ($gone) { Write-LaunchLog "bg: daemon pid $($dmn.Pid) (up since $($dmn.StartedAt), started by pid $($dmn.SpawnedByPid)) had no live session -> stopped, so the new one carries this launch's env" }
            else { Write-LaunchLog "bg: WARN daemon pid $($dmn.Pid) did not stop -> the session inherits ITS env (Telegram token / OAuth from the vault may not reach it)" }
        } elseif ($dmnAction -eq 'inherit') {
            Write-LaunchLog "bg: WARN daemon pid $($dmn.Pid) (up since $($dmn.StartedAt)) still has $(if ($live -lt 0) { 'an unreadable roster' } else { "$live live session(s)" }) -> not stopped; the new session inherits the DAEMON's env, not this launch's (stop them first: botcorp stop $Bot)"
        } else { Write-LaunchLog 'bg: no daemon running -> claude --bg starts one with this launch''s env' }

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
        # The poller is up only when the plugin's bot.pid is alive UNDER this
        # claude (it is written after the token check); the state says so.
        if ($canOwn -and $code -eq 0) {
            if ($tokenFile) {
                $tp = Complete-TgTokenFile -TokenFile $tokenFile -BotPidFile $botPidFile -ClaudePid $cpid -TimeoutSec 30
                Write-LaunchLog "telegram: token file $(if ($tp.Deleted) { 'deleted' } else { 'NOT deleted (remove it by hand)' }) after $(if ($tp.Up) { "the plugin read it (bot.pid $($tp.BotPid))" } else { 'the wait ran out' }): $tokenFile"
                if ($tp.Deleted) { $tokenFile = '' }
            } else { $tp = Wait-TgPoller -BotPidFile $botPidFile -ClaudePid $cpid -TimeoutSec 30 }
            if ($tp.Up) { Write-LaunchLog "telegram: poller up (bot.pid $($tp.BotPid) under claude $cpid)" }
            else { Write-LaunchLog "telegram: poller NOT up after 30 s (bot.pid $(if ($tp.BotPid) { "$($tp.BotPid), not under claude $cpid" } else { 'absent' })) - the plugin log is under %LOCALAPPDATA%\claude-cli-nodejs\Cache\<bot home slug>\mcp-logs-plugin-telegram-telegram" }
            Write-State @{ poller = $(if ($tp.Up) { 'OWNED' } else { 'DEAD' }); updated_at = (Get-Date).ToString('o') }
        }
        # Which launch's env the session actually got (its SessionStart hook
        # records BOT_LAUNCHER_PID): anything but OK means the config home's
        # daemon predates this launch, so the vault tokens did not reach it.
        if ($code -eq 0) {
            $until = (Get-Date).AddSeconds(20)
            while ($true) {
                $se = Get-SessionEnvRecord -ConfigDir $ConfigDir -SessionId $sid -Since $launchT0
                if ($se -or (Get-Date) -ge $until) { break }
                Start-Sleep -Milliseconds 1000
            }
            $chk = Get-SessionEnvCheck -Record $se -LauncherPid $PID
            Write-LaunchLog "env: $($chk.Verdict) - $($chk.Text)$(if ($chk.Verdict -eq 'OK') { " and oauth $(if ($oauthVal) { "$(Mask $oauthVal) ($oauthSrc)" } else { 'none (the config home''s own login)' })" } elseif ($chk.Verdict -ne 'UNKNOWN') { ". Fix: botcorp stop $Bot; botcorp start $Bot" })"
            Write-State @{ session_env = $chk.Verdict; updated_at = (Get-Date).ToString('o') }
        }
    } catch { Write-LaunchLog "bg launch failed: $($_.Exception.Message)"; Write-State @{ status = 'exited'; exit_code = 1; updated_at = (Get-Date).ToString('o') } }
    finally {
        foreach ($k in $secretEnvNames) { Remove-Item "env:$k" -ErrorAction SilentlyContinue }
        if ($attested) { Confirm-LaunchNonce -Bot $Bot }   # consumed: the child is up (or failed); never reusable
        # every failure path: the transient token file never outlives the launcher
        if ($tokenFile -and (Test-Path $tokenFile)) {
            Remove-Item -LiteralPath $tokenFile -Force -ErrorAction SilentlyContinue
            Write-LaunchLog "telegram: token file $(if (Test-Path $tokenFile) { 'NOT deleted (remove it by hand)' } else { 'deleted' }) (launch did not complete): $tokenFile"
        }
        # The owner-lock is NOT released here: the session is still running.
        # A failed launch leaves our own pid in it, which reads as stale (dead)
        # to the next launcher and is reclaimed.
    }
    exit $code
}

if ($attested) { Confirm-LaunchNonce -Bot $Bot }   # consumed: every decrypt is done, the child execs now
# Foreground: claude is OUR child and blocks this thread, so the transient
# token file is removed from a background job once the plugin under this launcher
# has read it (and in the finally below, whatever happened).
$tokenJob = $null
if ($tokenFile) {
    try {
        # Windows PowerShell 5.1 (the pty shell) may lack the ThreadJob module: a process job then
        $jobCmd = $(if (Get-Command Start-ThreadJob -ErrorAction SilentlyContinue) { 'Start-ThreadJob' } else { 'Start-Job' })
        $tokenJob = & $jobCmd -ArgumentList $PSScriptRoot, $tokenFile, $botPidFile, $PID, $LaunchLog, $Bot -ScriptBlock {
            param($Dir, $TokenFile, $BotPidFile, $LauncherPid, $Log, $BotName)
            . (Join-Path $Dir '_common.ps1')
            $tp = Complete-TgTokenFile -TokenFile $TokenFile -BotPidFile $BotPidFile -ClaudePid $LauncherPid -TimeoutSec 60
            "$((Get-Date).ToString('o'))  [$BotName] telegram: token file $(if ($tp.Deleted) { 'deleted' } else { 'NOT deleted (remove it by hand)' }) after $(if ($tp.Up) { "the plugin read it (bot.pid $($tp.BotPid))" } else { 'the wait ran out' }): $TokenFile" | Out-File -FilePath $Log -Append -Encoding utf8
        }
    } catch { Write-LaunchLog "telegram: token-file cleanup job did not start ($($_.Exception.Message)); it is removed when the session exits" }
}
try {
    & $exe @argv
    $code = $LASTEXITCODE
} finally {
    if ($tokenFile -and (Test-Path $tokenFile)) {
        Remove-Item -LiteralPath $tokenFile -Force -ErrorAction SilentlyContinue
        Write-LaunchLog "telegram: token file $(if (Test-Path $tokenFile) { 'NOT deleted (remove it by hand)' } else { 'deleted' }) at session exit: $tokenFile"
    }
    if ($tokenJob) { Remove-Job -Job $tokenJob -Force -ErrorAction SilentlyContinue }
    Write-State @{ status = 'exited'; exit_code = $code; updated_at = (Get-Date).ToString('o'); claude_pid = $null }
    # Release our own owner-lock only (SessionEnd does the same from inside;
    # this covers a kill that never fired the hook).
    try {
        if ($canOwn -and (Test-Path $lockFile) -and ((Get-FirstPid ((Get-Content $lockFile | Select-Object -First 1))) -eq $PID)) { Remove-Item $lockFile -Force -ErrorAction SilentlyContinue }
    } catch {}
    foreach ($k in $secretEnvNames) { Remove-Item "env:$k" -ErrorAction SilentlyContinue }
}
exit $code
