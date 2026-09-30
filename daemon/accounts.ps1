# accounts.ps1 - the accounts registry: Claude accounts an operator can start a
# NEW CHAT from (docs/cli.md `chat`). Separate from bots: a bot is a persona
# with its own folder and vault; an account is only a login (setup token) plus
# a label and a plan. `botcorp accounts` calls this; the tray and chat.ps1
# read it in-process.
#
#   accounts.ps1 -Action add    -Id <id> [-Label <text>] [-Plan <text>] [-FromStdin]   # token on stdin, else hidden prompt
#   accounts.ps1 -Action list   [-Json]                                                  # masked ****last4 only
#   accounts.ps1 -Action remove -Id <id>
#   accounts.ps1 -Action rename -Id <id> -Label <text>                                   # the label only; id, plan and token kept
#   accounts.ps1 -Action seed   [-Json] [-Link] [-DryRun]
#       one account per bot oauth_token not registered yet (matched by the vault
#       fingerprint, so a shared token is one account). id = bot name, or with
#       -Link acct-<last4>; label "Account ····<last4>". -Json adds `bots`, each
#       bot's {bot, id, new} for `botcorp accounts seed --link` to link. -DryRun
#       reads fingerprints only: no decrypt, no write.
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
    [Parameter(Mandatory)][ValidateSet('add', 'list', 'remove', 'rename', 'seed', 'get')][string]$Action,
    [string]$Id,
    [string]$Label,
    [string]$Plan,
    [switch]$FromStdin,
    [switch]$Json,
    [switch]$Link,
    [switch]$DryRun,
    [switch]$IAmTheLauncher,
    [string]$BotCorpRoot
)

$ErrorActionPreference = 'Stop'
# Labels carry non-ASCII ("····PgAA"); the CLI reads this output as UTF-8.
if ([Console]::IsOutputRedirected) { try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {} }
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

# "Account ····PgAA": a setup token has no email to name it by. The CLI renames
# it "<Plan> ····PgAA" once it detects a plan (cli/botcorp.mjs detectPlan).
function Get-SeedLabel { param([string]$Last4) return ('Account ' + ([string][char]0x00B7) * 4 + $Last4) }

# acct-<last4>, lowercased into the id shape; -2, -3, ... when that id is taken.
function New-SeedAccountId {
    param([string]$Last4, [hashtable]$Taken)
    $base = 'acct-' + (($Last4.ToLowerInvariant() -replace '[^a-z0-9]', '-').Trim('-'))
    if ($base -eq 'acct-') { $base = 'acct' }
    $cand = $base
    for ($n = 2; (Read-Account $cand) -or $Taken.ContainsKey($cand); $n++) { $cand = "$base-$n" }
    return $cand
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
        'rename' {
            if (-not $Id -or $Id -notmatch $ID_RE) { Write-Error 'accounts rename: -Id <id> required'; exit 1 }
            $newLabel = "$Label".Trim()
            if (-not $newLabel -or $newLabel.Length -gt 64 -or $newLabel -match '[\r\n\x00]') { Write-Error 'accounts rename: -Label <text> required (one line, at most 64 characters)'; exit 1 }
            if (-not (Read-Account $Id)) { Write-Output "accounts: no such account $Id"; exit 2 }
            $rec = Write-Account -AccountId $Id -AccountLabel $newLabel -AccountPlan ''
            Write-Output "accounts: $Id label -> $($rec.label)"
        }
        'seed' {
            $botsDir = Get-BotsDir -Root $root
            $done = @(); $skipped = @(); $map = @()
            # fingerprint -> account id: the registry's, then each account this run adds
            $byFp = @{}; $taken = @{}
            foreach ($r in @(Get-AccountRows)) { if ($r.fp -and -not $byFp.ContainsKey($r.fp)) { $byFp[$r.fp] = $r.id } }
            foreach ($d in (Get-ChildItem -Path $botsDir -Directory -ErrorAction SilentlyContinue | Sort-Object Name)) {
                if ($d.Name.StartsWith('_') -or -not (Test-Path (Join-Path $d.FullName 'bot.yaml'))) { continue }
                $rec = $null
                try { $rec = (Read-VaultStore $d.FullName)['oauth_token'] } catch { $rec = $null }
                if (-not $rec) { $skipped += "$($d.Name) (no oauth_token)"; continue }
                $fp = "$($rec.fp)"; $last4 = "$($rec.last4)"
                if ($fp -and $byFp.ContainsKey($fp)) {
                    $map += [ordered]@{ bot = $d.Name; id = $byFp[$fp]; new = $false }
                    continue
                }
                if (-not $Link -and (Read-Account $d.Name)) { $skipped += "$($d.Name) (exists)"; continue }
                if ($DryRun) {
                    $newId = if ($Link) { New-SeedAccountId -Last4 $(if ($last4) { $last4 } else { $fp.Substring(0, [Math]::Min(4, $fp.Length)) }) -Taken $taken } else { $d.Name }
                    $taken[$newId] = $true; if ($fp) { $byFp[$fp] = $newId }
                    $done += $newId
                    $map += [ordered]@{ bot = $d.Name; id = $newId; new = $true }
                    continue
                }
                $tok = $null
                try { $tok = Get-VaultSecret -BotHome $d.FullName -Bot $d.Name -Key 'oauth_token' } catch { $tok = $null }
                if (-not $tok) { $skipped += "$($d.Name) (oauth_token unreadable)"; continue }
                $tok = $tok.Trim()
                if (-not $fp) { $fp = Get-VaultFingerprint $tok }
                if (-not $last4) { $last4 = $tok.Substring([Math]::Max(0, $tok.Length - 4)) }
                $newId = if ($Link) { New-SeedAccountId -Last4 $last4 -Taken $taken } else { $d.Name }
                [void](Write-Account -AccountId $newId -AccountLabel (Get-SeedLabel $last4) -AccountPlan '')
                $masked = Set-VaultSecret -BotHome (Get-AccountHome $newId) -Bot (Get-AccountEntropy $newId) -Key 'oauth_token' -Value $tok
                $tok = $null
                $taken[$newId] = $true; $byFp[$fp] = $newId
                $done += "$newId $masked"
                $map += [ordered]@{ bot = $d.Name; id = $newId; new = $true }
            }
            if ($Json) { Write-Output (ConvertTo-Json -InputObject ([ordered]@{ seeded = $done; skipped = $skipped; bots = $map }) -Depth 4 -Compress) }
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
