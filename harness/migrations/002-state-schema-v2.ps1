# 002-state-schema-v2.ps1 - rewrite <BOTCORP_HOME>/state/<bot>.json to state
# schema v2 (docs/daemon.md "State file"): the flat `status`, `exit_code`,
# `stopped_at` and `stopped_by` fold into the `desired` and `launch` blocks
# (daemon/_common.ps1 ConvertTo-BotStateV2). `observed` is the tick's to write.
#
# update.ps1 -Apply runs it with env BOTCORP_ROOT + BOTCORP_HOME, under the
# daemon mutex, after the smoke passed. Idempotent: a v2 file is left
# byte-for-byte as it was. -Bot limits it to one bot. Exit 1 when a file could
# not be rewritten (every reader still reads a v1 file, and every daemon state
# write converts it, so a miss heals on its own).
param([string]$Bot = '', [string]$BotHome = '')

$ErrorActionPreference = 'Continue'
$root = if ($env:BOTCORP_ROOT) { $env:BOTCORP_ROOT } else { Split-Path (Split-Path $PSScriptRoot -Parent) -Parent }
. (Join-Path $root 'daemon\_common.ps1')

$failed = 0; $changed = 0; $seen = 0
foreach ($f in @(Get-ChildItem -Path $script:StateDir -Filter '*.json' -File -ErrorAction SilentlyContinue)) {
    $name = $f.BaseName
    if ($Bot -and $name -ne $Bot) { continue }
    $st = Read-JsonFile -Path $f.FullName
    # bot state files only (updates.json, harness.json, daemon.json share the folder)
    if (-not $st -or "$($st.bot)" -ne $name) { continue }
    $seen++
    $v2 = ConvertTo-BotStateV2 -State $st
    if (-not $v2.Changed) { continue }
    if (Write-JsonFile -Path $f.FullName -Object $v2.State -Depth 6) { $changed++; Write-DaemonLog 'migration 002: state file rewritten to schema v2' -Bot $name }
    else { $failed++; Write-DaemonLog 'migration 002: state file NOT rewritten (readers still take v1)' -Bot $name }
}
Write-Output "002-state-schema-v2: $seen bot state files, $changed rewritten, $failed failed"
exit $(if ($failed) { 1 } else { 0 })
