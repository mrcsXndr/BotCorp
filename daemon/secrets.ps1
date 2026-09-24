# secrets.ps1 - CLI face of the DPAPI vault (daemon/vault.ps1). `botcorp secrets`
# calls this; so does the cockpit's vault panel (through the CLI, value on stdin).
#
#   secrets.ps1 -Bot <name> -Action set    -Key oauth_token [-FromStdin]   # else a hidden prompt
#   secrets.ps1 -Bot <name> -Action list   [-Json]                          # masked only
#   secrets.ps1 -Bot <name> -Action delete -Key <key>
#   secrets.ps1 -Bot <name> -Action get    -Key <key> -IAmTheLauncher       # plaintext to stdout: launcher/tests only
#
# Key aliases: oauth -> oauth_token, telegram -> telegram_token, hub -> hub_token.
# A Telegram token is refused if another bot's vault already holds the same
# one (one poller per token). Exit codes: 0 ok, 1 error, 3 duplicate token.

param(
    [Parameter(Mandatory)][string]$Bot,
    [Parameter(Mandatory)][ValidateSet('set','get','list','delete')][string]$Action,
    [string]$Key,
    [switch]$FromStdin,
    [switch]$Json,
    [switch]$IAmTheLauncher,
    [string]$BotCorpRoot
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'vault.ps1')

$root = if ($BotCorpRoot) { $BotCorpRoot } else { Split-Path $PSScriptRoot -Parent }
$botsDir = Join-Path $root 'bots'
$botHome = Join-Path $botsDir $Bot
if ($Bot -notmatch '^[a-z0-9][a-z0-9-]{0,31}$') { Write-Error "secrets: bad bot name '$Bot'"; exit 1 }
if (-not (Test-Path (Join-Path $botHome 'bot.yaml'))) { Write-Error "secrets: no bot at $botHome (no bot.yaml)"; exit 1 }

$aliases = @{ oauth = 'oauth_token'; telegram = 'telegram_token'; hub = 'hub_token' }
if ($Key -and $aliases.ContainsKey($Key)) { $Key = $aliases[$Key] }

try {
    switch ($Action) {
        'set' {
            if (-not $Key) { Write-Error 'secrets set: -Key required'; exit 1 }
            $value = $null
            if ($FromStdin -or [Console]::IsInputRedirected) {
                $value = [Console]::In.ReadToEnd()
            } else {
                $sec = Read-Host -AsSecureString -Prompt "Value for $Bot/$Key (hidden)"
                $value = [System.Net.NetworkCredential]::new('', $sec).Password
            }
            $value = "$value".Trim([char]0xFEFF, ' ', "`t", "`r", "`n")
            if (-not $value) { Write-Error 'secrets set: empty value'; exit 1 }
            if ($Key -eq 'telegram_token') {
                # [Console]::Error, not Write-Error: under -ErrorAction Stop the
                # latter throws before `exit 3` runs and the catch turns it into 1.
                if ($value -notmatch '^[0-9]{8,12}:[A-Za-z0-9_-]{30,}$') { [Console]::Error.WriteLine('secrets set: that does not look like a Telegram bot token'); exit 1 }
                $dup = Test-VaultTokenExclusive -BotsDir $botsDir -Bot $Bot -Key $Key -Value $value
                if ($dup) { [Console]::Error.WriteLine("secrets set: bot '$dup' already holds this Telegram token (one poller per token)"); exit 3 }
            }
            $masked = Set-VaultSecret -BotHome $botHome -Bot $Bot -Key $Key -Value $value
            Write-Output "secrets: $Bot/$Key = $masked (DPAPI, CurrentUser)"
        }
        'get' {
            if (-not $IAmTheLauncher) { Write-Error 'secrets get: plaintext is only for the launcher (-IAmTheLauncher); use list'; exit 1 }
            if (-not $Key) { Write-Error 'secrets get: -Key required'; exit 1 }
            $v = Get-VaultSecret -BotHome $botHome -Bot $Bot -Key $Key
            if ($null -eq $v) { exit 2 }
            [Console]::Out.Write($v)
        }
        'list' {
            $rows = @(Get-VaultList -BotHome $botHome -Bot $Bot)
            if ($Json) { Write-Output (ConvertTo-Json -InputObject $rows -Depth 3 -Compress) }
            elseif ($rows.Count -eq 0) { Write-Output "secrets: $Bot has no vault entries" }
            else { $rows | ForEach-Object { Write-Output ("{0,-16} {1,-14} {2}" -f $_.key, $_.masked, $_.updated_at) } }
        }
        'delete' {
            if (-not $Key) { Write-Error 'secrets delete: -Key required'; exit 1 }
            $ok = Remove-VaultSecret -BotHome $botHome -Key $Key
            Write-Output ($(if ($ok) { "secrets: removed $Bot/$Key" } else { "secrets: no such key $Key" }))
        }
    }
    exit 0
} catch {
    # Never echo a value in an error path; the message can only name the key.
    Write-Error "secrets ${Action}: $($_.Exception.Message -replace '[A-Za-z0-9_-]{30,}', '****')"
    exit 1
}
