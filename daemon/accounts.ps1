# accounts.ps1 - the accounts registry: Claude accounts an operator can start a
# NEW CHAT from (docs/cli.md `chat`). Separate from bots: a bot is a persona
# with its own folder and vault; an account is only a login (setup token) plus
# a label and a plan. `botcorp accounts` calls this; the tray and chat.ps1
# read it in-process.
#
#   accounts.ps1 -Action add    -Id <id> [-Label <text>] [-Plan <text>] [-FromStdin]   # token on stdin, else hidden prompt
#   accounts.ps1 -Action list   [-Json]                                                  # masked ****last4 only
#   accounts.ps1 -Action remove -Id <id>
#   accounts.ps1 -Action seed   [-Json]        # one account per bot that holds an oauth_token (id = bot name); existing ids kept
#   accounts.ps1 -Action get    -Id <id> -IAmTheLauncher                                # plaintext to stdout: chat.ps1/tests only
#
# Layout (machine runtime, never in the checkout):
#   <BOTCORP_HOME>/accounts/<id>/account.json          {id, label, plan, added_at, updated_at}
#   <BOTCORP_HOME>/accounts/<id>/.vault/secrets.json   DPAPI (CurrentUser), key oauth_token, entropy "account:<id>"
#   <BOTCORP_HOME>/accounts/<id>/claude/               that account's CLAUDE_CONFIG_DIR (seeded by chat.ps1)
#
# The plaintext never reaches argv, a log line or an error message. `seed`
# unprotects a bot's token and re-protects it under the account entropy in
# this one process. Exit codes: 0 ok, 1 error, 2 no such account / no token.

param(
    [Parameter(Mandatory)][ValidateSet('add', 'list', 'remove', 'seed', 'get')][string]$Action,
    [string]$Id,
    [string]$Label,
    [string]$Plan,
    [switch]$FromStdin,
    [switch]$Json,
    [switch]$IAmTheLauncher,
    [string]$BotCorpRoot
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'vault.ps1')
. (Join-Path $PSScriptRoot '_paths.ps1')

$ID_RE = '^[a-z0-9][a-z0-9-]{0,31}$'
$root = if ($BotCorpRoot) { $BotCorpRoot } else { Split-Path $PSScriptRoot -Parent }
$rtHome = if ($env:BOTCORP_HOME) { $env:BOTCORP_HOME } else { Join-Path $env:USERPROFILE '.botcorp' }
$accountsDir = Join-Path $rtHome 'accounts'

function Get-AccountHome { param([string]$AccountId) return (Join-Path $accountsDir $AccountId) }
function Get-AccountEntropy { param([string]$AccountId) return "account:$AccountId" }

function Read-Account {
    param([string]$AccountId)
    $f = Join-Path (Get-AccountHome $AccountId) 'account.json'
    if (-not (Test-Path $f)) { return $null }
    try { return (Get-Content $f -Raw | ConvertFrom-Json) } catch { return $null }
}

function Write-Account {
    param([string]$AccountId, [string]$AccountLabel, [string]$AccountPlan)
    $acctHome = Get-AccountHome $AccountId
    if (-not (Test-Path $acctHome)) { New-Item -ItemType Directory -Force -Path $acctHome | Out-Null }
    $cur = Read-Account $AccountId
    $now = (Get-Date).ToUniversalTime().ToString('o')
    $rec = [ordered]@{
        id         = $AccountId
        label      = $(if ($AccountLabel) { $AccountLabel } elseif ($cur -and $cur.label) { "$($cur.label)" } else { $AccountId })
        plan       = $(if ($AccountPlan) { $AccountPlan } elseif ($cur -and $cur.plan) { "$($cur.plan)" } else { '' })
        added_at   = $(if ($cur -and $cur.added_at) { "$($cur.added_at)" } else { $now })
        updated_at = $now
    }
    $f = Join-Path $acctHome 'account.json'
    [System.IO.File]::WriteAllText("$f.tmp", (($rec | ConvertTo-Json -Depth 3) + "`n"))
    Move-Item -Force "$f.tmp" $f
    return $rec
}

function Get-AccountRows {
    $rows = @()
    if (-not (Test-Path $accountsDir)) { return $rows }
    foreach ($d in (Get-ChildItem -Path $accountsDir -Directory | Sort-Object Name)) {
        $a = Read-Account $d.Name
        if (-not $a) { continue }
        $masked = ''; $fp = ''
        try {
            $l = @(Get-VaultList -BotHome $d.FullName -Bot (Get-AccountEntropy $d.Name)) | Where-Object { $_.key -eq 'oauth_token' } | Select-Object -First 1
            if ($l) { $masked = "$($l.masked)"; $fp = "$($l.fp)" }
        } catch {}
        $rows += [pscustomobject]@{
            id = $d.Name; label = "$($a.label)"; plan = "$($a.plan)"; masked = $masked; fp = $fp
            config_dir = (Join-Path $d.FullName 'claude'); updated_at = "$($a.updated_at)"
        }
    }
    return $rows
}

try {
    switch ($Action) {
        'add' {
            if (-not $Id) { Write-Error 'accounts add: -Id required'; exit 1 }
            if ($Id -notmatch $ID_RE) { Write-Error "accounts add: bad id '$Id' (lowercase, digits, hyphens; max 32)"; exit 1 }
            $value = $null
            if ($FromStdin -or [Console]::IsInputRedirected) { $value = [Console]::In.ReadToEnd() }
            else {
                $sec = Read-Host -AsSecureString -Prompt "Setup token for account $Id (from ``claude setup-token``; hidden)"
                $value = [System.Net.NetworkCredential]::new('', $sec).Password
            }
            $value = "$value".Trim([char]0xFEFF, ' ', "`t", "`r", "`n")
            if (-not $value) { Write-Error 'accounts add: empty token'; exit 1 }
            $rec = Write-Account -AccountId $Id -AccountLabel $Label -AccountPlan $Plan
            $masked = Set-VaultSecret -BotHome (Get-AccountHome $Id) -Bot (Get-AccountEntropy $Id) -Key 'oauth_token' -Value $value
            $value = $null
            Write-Output "accounts: $Id ($($rec.label)$(if ($rec.plan) { ", $($rec.plan)" })) token $masked (DPAPI, CurrentUser)"
        }
        'list' {
            $rows = @(Get-AccountRows)
            if ($Json) { Write-Output (ConvertTo-Json -InputObject $rows -Depth 3 -Compress) }
            elseif ($rows.Count -eq 0) { Write-Output 'accounts: none (botcorp accounts add <id>, or botcorp accounts seed)' }
            else { $rows | ForEach-Object { Write-Output ("{0,-16} {1,-24} {2,-12} {3}" -f $_.id, $_.label, $_.plan, $(if ($_.masked) { $_.masked } else { '(no token)' })) } }
        }
        'remove' {
            if (-not $Id -or $Id -notmatch $ID_RE) { Write-Error 'accounts remove: -Id <id> required'; exit 1 }
            $acctHome = Get-AccountHome $Id
            if (-not (Test-Path (Join-Path $acctHome 'account.json'))) { Write-Output "accounts: no such account $Id"; exit 2 }
            # The vault and the registry record go; the config dir (histories) stays
            # unless the operator deletes it: a removed login is not a wiped history.
            [void](Remove-VaultSecret -BotHome $acctHome -Key 'oauth_token')
            Remove-Item -Force (Join-Path $acctHome 'account.json')
            Write-Output "accounts: removed $Id (its claude/ config dir under $acctHome is kept; delete it by hand if wanted)"
        }
        'seed' {
            $botsDir = Get-BotsDir -Root $root
            $done = @(); $skipped = @()
            foreach ($d in (Get-ChildItem -Path $botsDir -Directory -ErrorAction SilentlyContinue | Sort-Object Name)) {
                if ($d.Name.StartsWith('_') -or -not (Test-Path (Join-Path $d.FullName 'bot.yaml'))) { continue }
                if (Read-Account $d.Name) { $skipped += "$($d.Name) (exists)"; continue }
                $tok = $null
                try { $tok = Get-VaultSecret -BotHome $d.FullName -Bot $d.Name -Key 'oauth_token' } catch { $tok = $null }
                if (-not $tok) { $skipped += "$($d.Name) (no oauth_token)"; continue }
                [void](Write-Account -AccountId $d.Name -AccountLabel "bot $($d.Name)" -AccountPlan '')
                $masked = Set-VaultSecret -BotHome (Get-AccountHome $d.Name) -Bot (Get-AccountEntropy $d.Name) -Key 'oauth_token' -Value $tok
                $tok = $null
                $done += "$($d.Name) $masked"
            }
            if ($Json) { Write-Output (ConvertTo-Json -InputObject ([ordered]@{ seeded = $done; skipped = $skipped }) -Compress) }
            else {
                Write-Output "accounts seed: $($done.Count) added$(if ($done.Count) { ' - ' + ($done -join ', ') })"
                if ($skipped.Count) { Write-Output "accounts seed: skipped $($skipped -join ', ')" }
            }
        }
        'get' {
            if (-not $IAmTheLauncher) { Write-Error 'accounts get: plaintext is only for the launcher (-IAmTheLauncher); use list'; exit 1 }
            if (-not $Id -or $Id -notmatch $ID_RE) { Write-Error 'accounts get: -Id <id> required'; exit 1 }
            $v = Get-VaultSecret -BotHome (Get-AccountHome $Id) -Bot (Get-AccountEntropy $Id) -Key 'oauth_token'
            if ($null -eq $v) { exit 2 }
            [Console]::Out.Write($v)
        }
    }
    exit 0
} catch {
    Write-Error "accounts ${Action}: $($_.Exception.Message -replace '[A-Za-z0-9_-]{30,}', '****')"
    exit 1
}
