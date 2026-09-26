# tray.ps1 - a per-bot Windows tray icon: at-a-glance status (running/stopped,
# context %, last-tick age) and quick actions (attach, restart, stop, open
# cockpit, new chat). Placeholder icon for now; a real one lands with the
# reference port. HKCU Run starts one of these per bot via tray-register.ps1,
# hidden and non-interactive, so this script never assumes a console beyond
# the -Probe/-DryRun lines.
#
#   tray.ps1 -Bot <name> [-Probe] [-DryRun]
#
# Single instance per bot via a named mutex; a second launch for the same bot
# prints and exits 0 rather than fighting over the icon. Fail-open around
# every menu action (Write-DaemonLog, never a crash into the run loop).

param(
    [Parameter(Mandatory)][string]$Bot,
    [switch]$Probe,
    [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot '_common.ps1')

if ($Bot -notmatch '^[a-z0-9][a-z0-9-]{0,31}$') { Write-Output "tray: bad bot name '$Bot'"; exit 0 }

function Get-HumanAge {
    # e.g. "3m", "2h", "1d". "?" when there is nothing to measure.
    param([Nullable[datetime]]$Since)
    if (-not $Since) { return '?' }
    $span = (Get-Date) - $Since
    if ($span.TotalSeconds -lt 0) { return '0m' }
    if ($span.TotalMinutes -lt 60) { return "$([int]$span.TotalMinutes)m" }
    if ($span.TotalHours -lt 24) { return "$([int]$span.TotalHours)h" }
    return "$([int]$span.TotalDays)d"
}

function Get-TrayInfo {
    # @{ Status; CtxPct; AgeText; Tooltip }. Status is the phase the last tick
    # observed (core/state.mjs phase(), persisted as observed.phase). Every read
    # is fail-open: a missing state/status file reads as 'stopped' / '?', a state
    # file the tick has not observed yet as 'unknown', never a throw.
    param([Parameter(Mandatory)][string]$Bot)
    $status = 'stopped'
    $updatedAt = $null
    try {
        $st = Read-BotState -Bot $Bot
        if ($st) {
            $status = 'unknown'
            try { if ($st.observed -and $st.observed.phase) { $status = "$($st.observed.phase)" } } catch {}
            try { if ($st.updated_at) { $updatedAt = [datetime]::Parse("$($st.updated_at)", [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind) } } catch {}
        }
        if (-not $updatedAt) {
            $sf = (Get-BotPaths -Bot $Bot).StateFile
            if (Test-Path $sf) { try { $updatedAt = (Get-Item $sf).LastWriteTime } catch {} }
        }
    } catch {}

    $ctxPct = '?'
    try {
        $cfgDir = (Get-BotPaths -Bot $Bot).ConfigDir
        $sj = Read-JsonFile -Path (Join-Path (Join-Path $cfgDir 'botcorp') 'status.json')
        if ($sj -and $sj.context_window -and ($null -ne $sj.context_window.remaining_percentage)) {
            $ctxPct = [string][int][Math]::Round([double]$sj.context_window.remaining_percentage)
        }
    } catch {}

    $ageText = Get-HumanAge -Since $updatedAt
    # Same wording as the reference host's tray: a down bot is not an alarm,
    # the daemon tick brings it back.
    $statusText = if ($status -eq 'down') { 'down (daemon restarts it)' } else { $status }
    $tooltip = "${Bot}: $statusText | ctx ${ctxPct}% | tick $ageText"
    if ($tooltip.Length -gt 63) { $tooltip = $tooltip.Substring(0, 63) }
    return @{ Status = $status; CtxPct = $ctxPct; AgeText = $ageText; Tooltip = $tooltip }
}

function Get-CockpitPort {
    if ($env:COCKPIT_PORT) { return $env:COCKPIT_PORT }
    return '4477'
}

if ($Probe) {
    $info = Get-TrayInfo -Bot $Bot
    Write-Output "tray probe: $($info.Tooltip)"
    exit 0
}

if ($DryRun) {
    $port = Get-CockpitPort
    $pwsh = Resolve-PwshExe
    Write-Output "tray dry-run: Attach       -> $pwsh -NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $PSScriptRoot 'attach.ps1')`" -Bot $Bot"
    Write-Output "tray dry-run: Restart      -> node cli/botcorp.mjs restart $Bot"
    Write-Output "tray dry-run: Stop         -> node cli/botcorp.mjs stop $Bot  (confirm first)"
    Write-Output "tray dry-run: Open cockpit -> http://127.0.0.1:$port/#$Bot"
    Write-Output "tray dry-run: New chat...  -> $pwsh -NoExit -NoProfile -Command `"node '$(Join-Path $script:BotCorp 'cli\botcorp.mjs')' chat`""
    Write-Output "tray dry-run: Exit tray    -> stop the run loop, dispose icon, release mutex"
    exit 0
}

# --- real GUI path from here on -------------------------------------------------
$mutexName = "Global\BotCorpTray-$Bot"
$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, $mutexName, [ref]$createdNew)
if (-not $createdNew) {
    Write-Output "tray: already running for $Bot"
    exit 0
}

try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing

    $icon = New-Object System.Windows.Forms.NotifyIcon
    $icon.Icon = [System.Drawing.SystemIcons]::Application
    $icon.Visible = $true

    function Update-TrayIcon {
        try {
            $info = Get-TrayInfo -Bot $Bot
            $icon.Text = $info.Tooltip
        } catch { Write-DaemonLog "tray: refresh failed (fail-open): $($_.Exception.Message)" -Bot $Bot }
    }
    Update-TrayIcon

    $menu = New-Object System.Windows.Forms.ContextMenuStrip

    $itemAttach = New-Object System.Windows.Forms.ToolStripMenuItem 'Attach'
    $itemAttach.Font = New-Object System.Drawing.Font($itemAttach.Font, [System.Drawing.FontStyle]::Bold)
    $attachAction = {
        try {
            Start-Process -FilePath (Resolve-PwshExe) -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'attach.ps1'), '-Bot', $Bot) -WindowStyle Hidden | Out-Null
        } catch { Write-DaemonLog "tray: Attach failed: $($_.Exception.Message)" -Bot $Bot }
    }
    $itemAttach.Add_Click($attachAction)
    [void]$menu.Items.Add($itemAttach)

    $itemRestart = New-Object System.Windows.Forms.ToolStripMenuItem 'Restart'
    $itemRestart.Add_Click({
        try {
            $node = Resolve-Node
            if ($node) { Start-Process -FilePath $node -ArgumentList @((Join-Path $script:BotCorp 'cli\botcorp.mjs'), 'restart', $Bot) -WindowStyle Hidden -WorkingDirectory $script:BotCorp | Out-Null }
        } catch { Write-DaemonLog "tray: Restart failed: $($_.Exception.Message)" -Bot $Bot }
    })
    [void]$menu.Items.Add($itemRestart)

    $itemStop = New-Object System.Windows.Forms.ToolStripMenuItem 'Stop'
    $itemStop.Add_Click({
        try {
            $confirm = [System.Windows.Forms.MessageBox]::Show("Stop $Bot ?", 'BotCorp', [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Question)
            if ($confirm -eq [System.Windows.Forms.DialogResult]::Yes) {
                $node = Resolve-Node
                if ($node) { Start-Process -FilePath $node -ArgumentList @((Join-Path $script:BotCorp 'cli\botcorp.mjs'), 'stop', $Bot) -WindowStyle Hidden -WorkingDirectory $script:BotCorp | Out-Null }
            }
        } catch { Write-DaemonLog "tray: Stop failed: $($_.Exception.Message)" -Bot $Bot }
    })
    [void]$menu.Items.Add($itemStop)

    $itemCockpit = New-Object System.Windows.Forms.ToolStripMenuItem 'Open cockpit'
    $itemCockpit.Add_Click({
        try { Start-Process "http://127.0.0.1:$(Get-CockpitPort)/#$Bot" } catch { Write-DaemonLog "tray: Open cockpit failed: $($_.Exception.Message)" -Bot $Bot }
    })
    [void]$menu.Items.Add($itemCockpit)

    [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

    $itemChat = New-Object System.Windows.Forms.ToolStripMenuItem 'New chat...'
    $itemChat.Add_Click({
        try {
            $cli = Join-Path $script:BotCorp 'cli\botcorp.mjs'
            Start-Process -FilePath (Resolve-PwshExe) -ArgumentList @('-NoExit', '-NoProfile', '-Command', "node `"$cli`" chat") | Out-Null
        } catch { Write-DaemonLog "tray: New chat failed: $($_.Exception.Message)" -Bot $Bot }
    })
    [void]$menu.Items.Add($itemChat)

    [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

    $itemExit = New-Object System.Windows.Forms.ToolStripMenuItem 'Exit tray'
    $itemExit.Add_Click({ [System.Windows.Forms.Application]::Exit() })
    [void]$menu.Items.Add($itemExit)

    $icon.ContextMenuStrip = $menu
    $icon.Add_DoubleClick($attachAction)

    $icon.ShowBalloonTip(2000, 'BotCorp', "BotCorp tray for $Bot", [System.Windows.Forms.ToolTipIcon]::Info)

    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = 60000   # same cadence as the reference host's tray
    $timer.Add_Tick({ Update-TrayIcon })
    $timer.Start()

    [System.Windows.Forms.Application]::Run()
} finally {
    try { if ($icon) { $icon.Visible = $false; $icon.Dispose() } } catch {}
    try { $mutex.ReleaseMutex() } catch {}
    try { $mutex.Dispose() } catch {}
}
exit 0
