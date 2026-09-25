# stop.ps1 - stop one bot the same way the daemon does: `claude stop <bg id>`
# for a background session (the conversation is kept; the next start resumes
# it), the guarded tree-kill on the recorded claude pid, `claude stop` on any
# other live session of the bot (they keep its daemon's old env alive), and
# the pty-host if one is attached. Every kill goes through Get-ProcessOwnerRecord: nothing that
# is not ours is touched. Called by `botcorp stop` and `botcorp restart`.
#
#   stop.ps1 -Bot <name> [-DryRun]
param(
    [Parameter(Mandatory)][string]$Bot,
    [switch]$DryRun
)
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot '_common.ps1')

$st = Read-BotState -Bot $Bot
$bgId = ''; $cpid = 0
try { if ($st -and ($st.PSObject.Properties.Name -contains 'bg_id')) { $bgId = "$($st.bg_id)" } } catch {}
try { if ($st -and ($st.PSObject.Properties.Name -contains 'claude_pid')) { $cpid = [int]$st.claude_pid } } catch {}
$ptyJson = Join-Path $script:StateDir "$Bot.pty.json"

if ($DryRun) {
    Write-Output "DRYRUN stop ${Bot}: bg_id=$bgId claude_pid=$cpid pty-host=$(Test-Path $ptyJson)"
    exit 0
}
$ok = $true
if (Test-Path $ptyJson) {
    if (Get-Command Stop-PtyHost -ErrorAction SilentlyContinue) { $ok = (Stop-PtyHost -Bot $Bot) -and $ok }
    Write-Output "stop ${Bot}: pty-host stopped"
}
if ($bgId -or $cpid -gt 0 -or (Get-BgDaemon -ConfigDir (Get-BotPaths -Bot $Bot).ConfigDir).Alive) {
    $ok = (Stop-BgSession -Bot $Bot) -and $ok
    Write-Output "stop ${Bot}: background session $bgId stopped (claude stop + guarded tree-kill on pid $cpid)"
} elseif (-not (Test-Path $ptyJson)) {
    Write-Output "stop ${Bot}: nothing recorded as running"
}
Write-BotState -Bot $Bot -Updates @{ status = 'stopped'; stopped_at = (Get-Date).ToString('o'); stopped_by = 'cli' }
exit $(if ($ok) { 0 } else { 1 })
