# _paths.ps1 - the one resolver for where bot folders live (core/paths.mjs is
# its Node twin). BOTCORP_BOTS_DIR=<dir> replaces <checkout>/bots for every
# reader and writer alike. Dot-sourced by _common.ps1, secrets.ps1 and accounts.ps1.

function Get-BotsDir {
    param([Parameter(Mandatory)][string]$Root)
    if ($env:BOTCORP_BOTS_DIR) { return $env:BOTCORP_BOTS_DIR }
    return (Join-Path $Root 'bots')
}
