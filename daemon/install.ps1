# install.ps1 - register (or remove) the BotCorp daemon on this machine.
#
#   pwsh -File daemon/install.ps1                      # register both tasks (prompts for the password; self-elevates)
#   pwsh -File daemon/install.ps1 -Password (Read-Host -AsSecureString)
#   pwsh -File daemon/install.ps1 -LogonType S4U       # fallback: no stored password (see docs/host-service.md)
#   pwsh -File daemon/install.ps1 -RunLevel Highest    # elevated daemon token (attach must then be elevated too)
#   pwsh -File daemon/install.ps1 -Unregister          # remove both
#   pwsh -File daemon/install.ps1 -IntervalMinutes 5
#   pwsh -File daemon/install.ps1 -LaunchTaskOnly      # (re)register only BotCorp-Launch (no elevation)
#   pwsh -File daemon/install.ps1 -GitUser <name> -GitEmail <noreply email>
#
# EXACTLY two scheduled tasks per machine - the daemon is BotCorp's single
# inherent service; adding a bot adds a folder, never a task:
#
#   BotCorp-Daemon   The user, LogonType Password ("run whether user is logged
#                    on or not", the password stored by the Task Scheduler
#                    credential store), triggers At Startup + every N minutes,
#                    MultipleInstances IgnoreNew, 5 min time limit. Action =
#                    wscript.exe <rt>/daemon-hidden.vbs (generated from
#                    daemon/hidden-launcher.vbs.template; pwsh resolved at
#                    RUNTIME, never a versioned path). Password logon fires at
#                    the login screen after an unattended reboot AND is a full
#                    logon: the user profile is loaded and user-scope DPAPI (the
#                    vault) works. This is the model the reference host runs
#                    (verified across a reboot: bot up one minute after boot,
#                    nobody logged in). It runs in session 0: no desktop, so a
#                    bot is SEEN through `claude attach` / the cockpit, and a
#                    pty bot's task-initiated launch is hidden (the tick hands
#                    that launch to the second task whenever someone is logged in).
#                    -LogonType S4U keeps the old no-stored-password model as an
#                    explicit fallback (session 0 too, no profile loaded, and a
#                    probe on this project's build box never got a script to
#                    run under it: docs/cc-compat.md vii). -RunLevel Limited
#                    (default) or Highest: the token the daemon AND the bg
#                    supervisor it starts run with; the supervisor pipe answers
#                    only callers with the same elevation, so Highest forces
#                    every `claude attach` to be elevated (docs/host-service.md).
#   BotCorp-Launch   Interactive principal, NO triggers, no time limit. Action =
#                    pwsh -File daemon/launch-visible.ps1. Started by the tick
#                    from session 0, it runs in the user's desktop session:
#                    `claude attach <id>` in a window for a bg bot, a visible
#                    launch for a pty bot.
#
# Also: writes <rt>/state/install.json {user_profile, user, logon_type,
# run_level, registered_at, ...} (the tick pins USERPROFILE/LOCALAPPDATA/PATH
# from it under S4U; launch-visible.ps1 reads run_level), sets the repo-local
# git identity + core.hooksPath in the checkout, and WARNS about any other
# scheduled task named *Bot* (never deletes them).
#
# Registering a Password/S4U task needs elevation; the script detects that and
# re-launches itself with Start-Process -Verb RunAs, then prints the elevated
# run's log. The password never touches argv: the non-elevated run hands it to
# the elevated one through a DPAPI-protected temp file (CurrentUser scope,
# deleted right after it is read). Idempotent: re-running replaces the tasks.

param(
    [switch]$Unregister,
    [int]$IntervalMinutes = 3,
    [switch]$LaunchTaskOnly,
    [ValidateSet('Password', 'S4U')][string]$LogonType = 'Password',
    [ValidateSet('Limited', 'Highest')][string]$RunLevel = 'Limited',
    [System.Security.SecureString]$Password,
    [switch]$PasswordFromStdin,           # one line on stdin (the CLI's hidden prompt); never argv
    [switch]$DryRun,                      # collect the password, print what would be registered, register nothing
    [string]$GitUser = 'botcorp-bot',
    [string]$GitEmail = 'botcorp-bot@users.noreply.github.com',
    # internal: set on the elevated re-launch
    [switch]$Elevated,
    [string]$RtHomeOverride,
    [string]$PasswordFile
)

$ErrorActionPreference = 'Stop'
if ($RtHomeOverride) { $env:BOTCORP_HOME = $RtHomeOverride }
. (Join-Path $PSScriptRoot '_common.ps1')

$daemonTask = 'BotCorp-Daemon'
$launchTask = 'BotCorp-Launch'
$installLog = Join-Path $RtHome 'install.log'
$tickScript = Join-Path $PSScriptRoot 'tick.ps1'
$visibleScript = Join-Path $PSScriptRoot 'launch-visible.ps1'
$vbsPath = Join-Path $RtHome 'daemon-hidden.vbs'

function Say { param([string]$M, [string]$Color = 'Gray')
    Write-Host $M -ForegroundColor $Color
    try { "$((Get-Date).ToString('s'))  $M" | Out-File -FilePath $installLog -Append -Encoding utf8 } catch {}
}

function Test-Admin {
    try { return ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } catch { return $false }
}

function ConvertTo-Plain { param([System.Security.SecureString]$S)
    $b = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($S)
    try { return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

# pwsh for the Launch task action: a known install path first, then the
# version-stable WindowsApps alias (survives PowerShell updates), then
# whatever PATH gives, then the ABSOLUTE Windows PowerShell 5.1 path - never
# a bare 'pwsh.exe' (PATH is unreliable in session 0).
$pwshRt = Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'
if (-not (Test-Path $pwshRt)) {
    $alias = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\pwsh.exe'
    if (Test-Path $alias) { $pwshRt = $alias }
    else {
        $pwshRt = (Get-Command pwsh.exe -ErrorAction SilentlyContinue).Source
        if (-not $pwshRt) { $pwshRt = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe' }
    }
}

function Register-LaunchTask {
    $action = New-ScheduledTaskAction -Execute $pwshRt -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$visibleScript`""
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName $launchTask -Action $action -Principal $principal -Settings $settings -Force | Out-Null
    Say "Registered '$launchTask' (Interactive, no triggers): $pwshRt -File $visibleScript" 'Green'
}

function Register-DaemonTask {
    param([string]$PlainPassword)
    $tpl = Join-Path $PSScriptRoot 'hidden-launcher.vbs.template'
    if (-not (Test-Path $tpl)) { throw "template missing: $tpl" }
    $vbs = (Get-Content $tpl -Raw).Replace('{{TICK_SCRIPT}}', $tickScript).Replace('{{SCRIPT_ARGS}}', '').Replace('{{BOTCORP_HOME}}', $RtHome).Replace('{{LOCALAPPDATA_PWSH}}', (Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\pwsh.exe'))
    Set-Content -Path $vbsPath -Value $vbs -Encoding ASCII
    $action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\wscript.exe') -Argument "`"$vbsPath`" //B //Nologo"
    # At Startup (not At Logon: nobody logs in on a headless host) + repetition.
    $tBoot = New-ScheduledTaskTrigger -AtStartup
    $tRepeat = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
    $user = "$env:USERDOMAIN\$env:USERNAME"
    if ($LogonType -eq 'Password') {
        if (-not $PlainPassword) { throw 'LogonType Password needs the account password (-Password <SecureString>, or answer the prompt).' }
        # -User/-Password registers TASK_LOGON_PASSWORD ("run whether user is
        # logged on or not"); the Task Scheduler keeps the credential, this
        # script never writes it anywhere.
        Register-ScheduledTask -TaskName $daemonTask -Action $action -Trigger $tBoot, $tRepeat -Settings $settings -User $user -Password $PlainPassword -RunLevel $RunLevel -Force | Out-Null
    } else {
        $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel $RunLevel
        Register-ScheduledTask -TaskName $daemonTask -Action $action -Trigger $tBoot, $tRepeat -Principal $principal -Settings $settings -Force | Out-Null
    }
    Say "Registered '$daemonTask' ($LogonType, RunLevel $RunLevel): At Startup + every ${IntervalMinutes}m -> wscript $vbsPath -> pwsh -File $tickScript" 'Green'
    if ($RunLevel -eq 'Highest') { Say "  RunLevel Highest: the bg supervisor runs elevated, so every 'claude attach' must be elevated too (launch-visible.ps1 does this)." 'Yellow' }
}

function Write-InstallState {
    $rec = [ordered]@{
        user_profile  = $env:USERPROFILE
        user          = "$env:USERDOMAIN\$env:USERNAME"
        logon_type    = $LogonType
        run_level     = $RunLevel
        registered_at = (Get-Date).ToString('o')
        botcorp_root  = $BotCorp
        runtime_root  = $RtHome
        interval_min  = $IntervalMinutes
        tasks         = @($daemonTask, $launchTask)
    }
    if (Write-JsonFile -Path (Join-Path $StateDir 'install.json') -Object $rec) { Say "Wrote $(Join-Path $StateDir 'install.json') (profile pin + run level for the tick and the attach window)" 'DarkGray' }
}

function Set-RepoGitIdentity {
    if (-not (Test-Path (Join-Path $BotCorp '.git'))) { Say "git identity: $BotCorp is not a git checkout - skipped" 'DarkGray'; return }
    $ErrorActionPreference = 'Continue'
    try {
        & git -C $BotCorp config user.name $GitUser 2>&1 | Out-Null
        & git -C $BotCorp config user.email $GitEmail 2>&1 | Out-Null
        & git -C $BotCorp config core.hooksPath .githooks 2>&1 | Out-Null
        Say "git identity: user.name=$GitUser user.email=$GitEmail core.hooksPath=.githooks (repo-local)" 'DarkGray'
    } catch { Say "git identity: could not set ($($_.Exception.Message))" 'Yellow' }
}

function Show-OtherBotTasks {
    try {
        $others = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -like '*Bot*' -and $_.TaskName -notlike 'BotCorp-*' } | Select-Object -ExpandProperty TaskName)
        if ($others.Count -gt 0) {
            Say "WARNING: other *Bot* scheduled tasks exist (BotCorp registers exactly two; 'botcorp doctor' flags these): $($others -join ', ')" 'Yellow'
            Say '         They were NOT touched. Remove them yourself once their bots run under this daemon.' 'Yellow'
        }
    } catch {}
}

# --- LaunchTaskOnly: no elevation needed --------------------------------------------
if ($LaunchTaskOnly) {
    Register-LaunchTask
    Show-OtherBotTasks
    exit 0
}

# --- password (collected BEFORE elevating, so the prompt is in this console) --------------
$plain = $null
if (-not $Unregister -and $LogonType -eq 'Password') {
    if ($PasswordFile) {
        # elevated re-launch: DPAPI-protected (CurrentUser) one-shot file
        try {
            $sec = (Get-Content $PasswordFile -Raw -ErrorAction Stop).Trim() | ConvertTo-SecureString -ErrorAction Stop
            $plain = ConvertTo-Plain $sec
        } finally { try { Remove-Item $PasswordFile -Force -ErrorAction SilentlyContinue } catch {} }
    } elseif ($Password) {
        $plain = ConvertTo-Plain $Password
    } elseif ($PasswordFromStdin -or [Console]::IsInputRedirected) {
        # Piped stdin (the CLI, or `$pw | pwsh -File install.ps1`): one line,
        # read in memory, never logged. Nothing to read = fail, never a prompt.
        $plain = "$([Console]::In.ReadLine())".Trim()
        if (-not $plain) { Say 'No password on stdin; nothing registered. Pipe it: $pw | node cli\botcorp.mjs install   (or -LogonType S4U explicitly)' 'Red'; exit 1 }
    } elseif ([Environment]::UserInteractive) {
        Say "LogonType Password: the daemon task runs as $env:USERDOMAIN\$env:USERNAME whether logged on or not; the Task Scheduler stores the password (-LogonType S4U avoids that at the cost of no user profile / DPAPI)." 'Cyan'
        $sec = Read-Host -Prompt "  Password for $env:USERNAME" -AsSecureString
        $plain = ConvertTo-Plain $sec
        if (-not $plain) { Say 'No password given; nothing registered (S4U is never a silent fallback: pass -LogonType S4U).' 'Red'; exit 1 }
    } else {
        # No console to prompt on and nothing piped: a prompt here hung an
        # elevated, non-interactive install on the reference host.
        Say 'No TTY and nothing on stdin: pipe the password ($pw | node cli\botcorp.mjs install) or pass -LogonType S4U explicitly. Nothing registered.' 'Red'; exit 1
    }
}

if ($DryRun) {
    $who = "$env:USERDOMAIN\$env:USERNAME"
    $pwNote = if ($LogonType -eq 'Password') { " (password: $(if ($plain) { "provided, $($plain.Length) chars" } else { 'none' }))" } else { '' }
    Say "DRYRUN: would register '$daemonTask' as $who, LogonType ${LogonType}${pwNote}, RunLevel ${RunLevel}: At Startup + every ${IntervalMinutes}m -> wscript -> pwsh -File $tickScript" 'Cyan'
    Say "DRYRUN: would register '$launchTask' (Interactive, no triggers) -> pwsh -File $visibleScript" 'Cyan'
    Say "DRYRUN: would write $(Join-Path $StateDir 'install.json'), set the repo git identity ($GitUser <$GitEmail>), and elevate via Start-Process -Verb RunAs if not already admin. Nothing registered." 'Cyan'
    $plain = $null
    exit 0
}

# --- elevation ------------------------------------------------------------------------
if (-not (Test-Admin)) {
    if ($Elevated) { Say 'Elevation did not take effect; cannot register the daemon task without admin.' 'Red'; exit 1 }
    Say "Registering the daemon task needs elevation - re-launching myself elevated (Start-Process -Verb RunAs)..." 'Cyan'
    $relaunchArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Elevated', '-IntervalMinutes', "$IntervalMinutes", '-LogonType', $LogonType, '-RunLevel', $RunLevel, '-GitUser', "`"$GitUser`"", '-GitEmail', "`"$GitEmail`"", '-RtHomeOverride', "`"$RtHome`"")
    if ($Unregister) { $relaunchArgs += '-Unregister' }
    $pwFile = $null
    if ($plain) {
        # Same user, elevated token: CurrentUser DPAPI round-trips. Never argv.
        $pwFile = Join-Path $RtHome ('install-pw-' + [guid]::NewGuid().ToString('n') + '.dat')
        ((ConvertTo-SecureString $plain -AsPlainText -Force) | ConvertFrom-SecureString) | Set-Content -Path $pwFile -Encoding ASCII
        $relaunchArgs += @('-PasswordFile', "`"$pwFile`"")
    }
    $mark = $null; try { if (Test-Path $installLog) { $mark = (Get-Item $installLog).Length } else { $mark = 0 } } catch { $mark = 0 }
    $p = Start-Process -FilePath (Resolve-PwshExe) -ArgumentList $relaunchArgs -Verb RunAs -Wait -PassThru
    try { if ($pwFile -and (Test-Path $pwFile)) { Remove-Item $pwFile -Force -ErrorAction SilentlyContinue } } catch {}
    try {
        if (Test-Path $installLog) {
            $fs = [System.IO.File]::Open($installLog, 'Open', 'Read', 'ReadWrite')
            try { $fs.Seek($mark, 'Begin') | Out-Null; $sr = New-Object System.IO.StreamReader($fs); $tail = $sr.ReadToEnd() } finally { $fs.Dispose() }
            if ($tail) { Write-Host $tail.TrimEnd() }
        }
    } catch {}
    exit $p.ExitCode
}

# --- elevated (or already admin) ------------------------------------------------------
if ($Unregister) {
    foreach ($t in @($daemonTask, $launchTask)) {
        try { Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction Stop; Say "Removed scheduled task '$t'." 'Yellow' }
        catch { Say "Task '$t' not found / not removed: $($_.Exception.Message)" 'DarkGray' }
    }
    try { if (Test-Path $vbsPath) { Remove-Item $vbsPath -Force -ErrorAction SilentlyContinue } } catch {}
    exit 0
}

try {
    Register-DaemonTask -PlainPassword $plain
    $plain = $null
    Register-LaunchTask
    Write-InstallState
    Set-RepoGitIdentity
    Show-OtherBotTasks
    Say "Done. Remove with: pwsh -File daemon\install.ps1 -Unregister" 'DarkGray'
    exit 0
} catch {
    Say "INSTALL FAILED: $($_.Exception.Message)" 'Red'
    exit 1
}
