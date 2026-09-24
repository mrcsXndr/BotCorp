# chat.ps1 - the New-chat launcher: an interactive `claude` for a chosen
# ACCOUNT (daemon/accounts.ps1) in a chosen WORKSPACE, in its own Windows
# Terminal tab. Not a bot session: no plugin, no Telegram bridge, no
# supervisor, no state file. `botcorp chat`, the tray and the cockpit all end
# here.
#
#   chat.ps1 -Account <id> -Cwd <folder>        # codebase mode: claude in that folder
#   chat.ps1 -Account <id> -Generic             # generic mode: the operator's plain Claude, cwd = the account's home
#   chat.ps1 -Account <id> ... -DryRun          # print the window command + env (token masked), launch nothing
#   chat.ps1 -Account <id> ... -InTab           # INSIDE the tab: vault -> env, then `claude` (what the tab runs)
#
# Isolation: CLAUDE_CONFIG_DIR = <BOTCORP_HOME>/accounts/<id>/claude (per account,
# so logins and histories never mix, and never the real ~/.claude), seeded on
# first use with the operator's ~/.claude/settings.json (generic mode) and a
# .claude.json that skips onboarding and trusts the workspace. The token is
# read from the account vault IN THE TAB PROCESS (same user, DPAPI CurrentUser)
# and put in that process's env only - never argv, never a file, never
# inherited from the HKCU CLAUDE_CODE_OAUTH_TOKEN of whichever bot set it.
# Recent workspaces: <BOTCORP_HOME>/state/chat-recent.json (last 12).

param(
    [Parameter(Mandatory)][string]$Account,
    [string]$Cwd,
    [switch]$Generic,
    [switch]$InTab,
    [switch]$DryRun,
    [string]$Title
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'vault.ps1')

$rtHome = if ($env:BOTCORP_HOME) { $env:BOTCORP_HOME } else { Join-Path $env:USERPROFILE '.botcorp' }
$stateDir = Join-Path $rtHome 'state'
if ($Account -notmatch '^[a-z0-9][a-z0-9-]{0,31}$') { Write-Error "chat: bad account id '$Account'"; exit 1 }
$accHome = Join-Path (Join-Path $rtHome 'accounts') $Account
if (-not (Test-Path (Join-Path $accHome 'account.json'))) { Write-Error "chat: no account '$Account' (botcorp accounts list)"; exit 2 }
$configDir = Join-Path $accHome 'claude'
$realHome = Join-Path $env:USERPROFILE '.claude'
if ([System.IO.Path]::GetFullPath($configDir).TrimEnd('\') -ieq [System.IO.Path]::GetFullPath($realHome).TrimEnd('\')) { Write-Error 'chat: refusing the real ~/.claude as a config dir'; exit 1 }

if ($Generic -and $Cwd) { Write-Error 'chat: -Generic or -Cwd, not both'; exit 1 }
if (-not $Generic -and -not $Cwd) { Write-Error 'chat: -Cwd <folder> or -Generic required'; exit 1 }
$workDir = if ($Generic) { $accHome } else { [System.IO.Path]::GetFullPath($Cwd) }
if (-not (Test-Path $workDir -PathType Container)) { Write-Error "chat: workspace folder not found: $workDir"; exit 1 }

function Resolve-ClaudeExe {
    $native = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
    if (Test-Path $native) { return $native }
    $onPath = (Get-Command claude -ErrorAction SilentlyContinue).Source
    if ($onPath) { return $onPath }
    return $native
}
function Resolve-PwshExe {
    $p = (Get-Command pwsh.exe -ErrorAction SilentlyContinue).Source
    if (-not $p) { $alias = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\pwsh.exe'; $p = if (Test-Path $alias) { $alias } else { 'powershell.exe' } }
    return $p
}
function Mask { param([string]$V) if (-not $V) { return '' }; return '****' + $V.Substring([Math]::Max(0, $V.Length - 4)) }

function Initialize-AccountConfigDir {
    # First use: the operator's own user settings (theme, keybindings, model
    # prefs) so generic mode feels like plain Claude; onboarding + workspace
    # trust pre-answered so the tab opens straight into the prompt. Never
    # copies credentials or plugin enablement.
    if (-not (Test-Path $configDir)) { New-Item -ItemType Directory -Force -Path $configDir | Out-Null }
    $seeded = @()
    $userSettings = Join-Path $realHome 'settings.json'
    $accSettings = Join-Path $configDir 'settings.json'
    if ((Test-Path $userSettings) -and -not (Test-Path $accSettings)) {
        try {
            $j = Get-Content $userSettings -Raw | ConvertFrom-Json
            foreach ($k in @('enabledPlugins', 'apiKeyHelper', 'env', 'hooks')) { if ($j.PSObject.Properties.Name -contains $k) { $j.PSObject.Properties.Remove($k) } }
            [System.IO.File]::WriteAllText($accSettings, (($j | ConvertTo-Json -Depth 20) + "`n"))
            $seeded += 'settings.json (from ~/.claude, minus plugins/hooks/env)'
        } catch { $seeded += "settings.json NOT seeded ($($_.Exception.Message))" }
    }
    $cj = Join-Path $configDir '.claude.json'
    $key = $workDir.Replace('\', '/')
    $obj = $null
    if (Test-Path $cj) { try { $obj = Get-Content $cj -Raw | ConvertFrom-Json } catch { $obj = $null } }
    if (-not $obj) { $obj = [pscustomobject]@{ hasCompletedOnboarding = $true; theme = 'dark'; projects = [pscustomobject]@{} } }
    if (-not ($obj.PSObject.Properties.Name -contains 'projects') -or -not $obj.projects) { $obj | Add-Member -Force -NotePropertyName projects -NotePropertyValue ([pscustomobject]@{}) }
    if (-not ($obj.projects.PSObject.Properties.Name -contains $key)) {
        $obj.projects | Add-Member -NotePropertyName $key -NotePropertyValue ([pscustomobject]@{ allowedTools = @(); hasTrustDialogAccepted = $true; hasCompletedProjectOnboarding = $true })
        [System.IO.File]::WriteAllText($cj, (($obj | ConvertTo-Json -Depth 20) + "`n"))
        $seeded += ".claude.json (trusted $key)"
    }
    return $seeded
}

function Update-Recent {
    if ($Generic) { return }
    try {
        if (-not (Test-Path $stateDir)) { New-Item -ItemType Directory -Force -Path $stateDir | Out-Null }
        $f = Join-Path $stateDir 'chat-recent.json'
        $list = @()
        if (Test-Path $f) { try { $j = Get-Content $f -Raw | ConvertFrom-Json; if ($j.recent) { $list = @($j.recent) } } catch {} }
        $now = (Get-Date).ToString('o')
        $list = @([pscustomobject]@{ cwd = $workDir; last_used = $now; account = $Account }) + @($list | Where-Object { "$($_.cwd)" -ine $workDir })
        $list = @($list | Select-Object -First 12)
        [System.IO.File]::WriteAllText("$f.tmp", ((@{ recent = $list } | ConvertTo-Json -Depth 4) + "`n"))
        Move-Item -Force "$f.tmp" $f
    } catch {}
}

$exe = Resolve-ClaudeExe
$tabTitle = if ($Title) { $Title } elseif ($Generic) { "claude ($Account)" } else { "claude ($Account) $(Split-Path $workDir -Leaf)" }

if ($InTab) {
    # --- inside the tab: vault -> env, then claude (this process becomes the shell claude runs in)
    foreach ($k in 'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'TELEGRAM_BOT_TOKEN', 'BOT_HOME', 'BOT_NAME', 'BOT_MODULES', 'BOT_DISABLED_HOOKS', 'CLAUDE_PLUGIN_ROOT') {
        [Environment]::SetEnvironmentVariable($k, $null, 'Process')
    }
    $tok = Get-VaultSecret -BotHome $accHome -Bot "account:$Account" -Key 'oauth_token'
    if (-not $tok) { Write-Host "chat: account '$Account' has no token in its vault (botcorp accounts add $Account)" -ForegroundColor Red; exit 2 }
    $env:CLAUDE_CODE_OAUTH_TOKEN = $tok
    $tok = $null
    $env:CLAUDE_CONFIG_DIR = $configDir
    $seeded = Initialize-AccountConfigDir
    Update-Recent
    $host.UI.RawUI.WindowTitle = $tabTitle
    Write-Host "botcorp chat: account $Account  token $(Mask $env:CLAUDE_CODE_OAUTH_TOKEN)  config $configDir$(if ($seeded.Count) { "  seeded: $($seeded -join '; ')" })" -ForegroundColor DarkGray
    Set-Location $workDir
    & $exe
    exit $LASTEXITCODE
}

# --- the launcher: open a Windows Terminal tab (or a pwsh window) that runs this script -InTab
$pwsh = Resolve-PwshExe
$tabArgs = @('-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-Account', $Account, '-InTab')
if ($Generic) { $tabArgs += '-Generic' } else { $tabArgs += @('-Cwd', $workDir) }
if ($Title) { $tabArgs += @('-Title', $Title) }
$wtCmd = Get-Command wt.exe -ErrorAction SilentlyContinue
$wtAlias = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\wt.exe'
$wt = if ($wtCmd) { $wtCmd.Source } elseif (Test-Path $wtAlias) { $wtAlias } else { $null }

$q = { param($s) if ($s -match '[\s"]') { '"' + ($s -replace '"', '\"') + '"' } else { $s } }
if ($wt) {
    # -w 0 = a new tab in the most recent WT window (a new window if none).
    $wtArgs = @('-w', '0', 'new-tab', '--title', (& $q $tabTitle), '-d', (& $q $workDir), (& $q $pwsh)) + @($tabArgs | ForEach-Object { & $q $_ })
    $cmdLine = "wt.exe $($wtArgs -join ' ')"
} else {
    $cmdLine = "$pwsh $(($tabArgs | ForEach-Object { & $q $_ }) -join ' ')"
}
if ($DryRun) {
    Write-Output "chat dry-run: $cmdLine"
    Write-Output "chat dry-run: env in the tab = CLAUDE_CONFIG_DIR=$configDir CLAUDE_CODE_OAUTH_TOKEN=<from account vault, never printed> cwd=$workDir claude=$exe"
    exit 0
}
if ($wt) { Start-Process -FilePath $wt -ArgumentList $wtArgs | Out-Null }
else { Start-Process -FilePath $pwsh -ArgumentList $tabArgs -WorkingDirectory $workDir | Out-Null }
Write-Output "chat: opened '$tabTitle' (account $Account, $(if ($Generic) { 'generic' } else { $workDir }))"
exit 0
