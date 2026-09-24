# secrets.ps1 - CLI face of the DPAPI vault (daemon/vault.ps1). `botcorp secrets`
# calls this; so does the cockpit's vault panel (through the CLI, value on stdin).
#
#   secrets.ps1 -Bot <name> -Action set    -Key oauth_token [-FromStdin]   # else a hidden prompt
#   secrets.ps1 -Bot <name> -Action list   [-Json]                          # masked only
#   secrets.ps1 -Bot <name> -Action delete -Key <key>
#   secrets.ps1 -Bot <name> -Action get    -Key <key> -Nonce <launch nonce> # plaintext to stdout: an ATTESTED launcher only
#   secrets.ps1 -Bot <name> -Action doctor [-Json]                          # acl + one audited decrypt probe + lock state
#   secrets.ps1 -Bot <name> -Action acl                                     # re-apply the vault ACL
#   secrets.ps1 -Bot <name> -Action migrate                                 # v1 (bot-name entropy) -> v2 (per-bot key)
#   secrets.ps1 -Bot <name> -Action lock                                    # passphrase on stdin -> operator lock; already locked: re-lock now
#   secrets.ps1 -Bot <name> -Action unlock [-Permanent]                     # passphrase on stdin -> unlocked until reboot (or back to mode none)
#   secrets.ps1 -Bot <name> -Action export-bundle -OutDir <dir> [-Files a,~/b]      # passphrase on stdin; ~/ = scope home
#   secrets.ps1 -Bot <name> -Action import-bundle -Bundle <enc> [-Manifest <json>] [-DryRun] [-AllowHome] [-Force]
#
# Key aliases: oauth -> oauth_token, telegram -> telegram_token, hub -> hub_token.
# A Telegram token is refused if another bot's vault already holds the same
# one (one poller per token). Exit codes: 0 ok, 1 error, 3 duplicate token.
#
# export-bundle/import-bundle move a bot's vault + chosen files between
# machines: daemon/bundle.ps1 is the encrypted-bundle format (AES-256-GCM,
# PBKDF2-SHA256). Every passphrase is ALWAYS read from stdin - never argv,
# never echoed - same discipline as vault.ps1.

param(
    [Parameter(Mandatory)][string]$Bot,
    [Parameter(Mandatory)][ValidateSet('set','get','list','delete','doctor','acl','lock-state','migrate','lock','unlock','export-bundle','import-bundle')][string]$Action,
    [string]$Key,
    [switch]$FromStdin,
    [switch]$Json,
    [string]$Nonce,
    [string]$BotCorpRoot,
    [string]$OutDir,
    [string]$Bundle,
    [string]$Manifest,
    [string[]]$Files,
    [switch]$DryRun,
    [switch]$AllowHome,
    [switch]$Force,
    [switch]$Permanent
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'vault.ps1')
. (Join-Path $PSScriptRoot 'bundle.ps1')

function Read-PassphraseFromStdin {
    $v = [Console]::In.ReadToEnd()
    $v = "$v".Trim([char]0xFEFF, ' ', "`t", "`r", "`n")
    if (-not $v) { throw 'secrets: empty passphrase on stdin' }
    return $v
}

function Get-FullPathNorm { param([string]$P) return ([System.IO.Path]::GetFullPath($P)).TrimEnd('\') }
function Test-PathUnder { param([string]$Path, [string]$Root) return ("$Path\".StartsWith("$Root\", [System.StringComparison]::OrdinalIgnoreCase)) }

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
            # Plaintext leaves only for an attested launch: the nonce a trusted
            # start path minted (vault.ps1 Test-LaunchNonce); audited reason launch.
            if (-not $Nonce) { Write-Error 'secrets get: plaintext is only for an attested launcher (-Nonce <launch nonce>); use list'; exit 1 }
            if (-not $Key) { Write-Error 'secrets get: -Key required'; exit 1 }
            $v = Get-VaultSecret -BotHome $botHome -Bot $Bot -Key $Key -Reason 'launch' -Nonce $Nonce
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
        'acl' {
            # Re-apply the vault ACL (user + SYSTEM, inheritance off, files too)
            # without touching any entry - what a copied/restored bot folder needs.
            $dir = Join-Path $botHome '.vault'
            if (-not (Test-Path $dir)) { Write-Output "secrets acl: $Bot has no vault yet"; exit 0 }
            Protect-VaultDir $dir
            $acl = Test-VaultAcl -BotHome $botHome
            Write-Output "secrets acl: $Bot/.vault -> $($acl.detail)"
            if (-not $acl.ok) { exit 1 }
        }
        'doctor' {
            # What `botcorp doctor` asks: the ACL state, the lock state and ONE
            # audited decrypt (reason doctor) to prove the blobs are readable by
            # this account - `list` never decrypts, so readability needs a probe.
            # A locked vault is reported as locked, not as unreadable.
            $acl = Test-VaultAcl -BotHome $botHome
            $lock = Get-VaultLockState -BotHome $botHome -Bot $Bot
            $keys = @((Read-VaultStore $botHome).Keys | Sort-Object)
            $probe = @{ ok = $true; key = $null; detail = 'no entries' }
            if ($keys.Count -gt 0) {
                $probe.key = $keys[0]
                if ($lock.locked) { $probe.detail = "not probed: vault locked" }
                else {
                    try { [void](Get-VaultSecret -BotHome $botHome -Bot $Bot -Key $keys[0] -Reason 'doctor'); $probe.detail = "decrypted $($keys[0])" }
                    catch { $probe.ok = $false; $probe.detail = "cannot decrypt $($keys[0]) as this account" }
                }
            }
            $r = [ordered]@{ acl = $acl; probe = $probe; lock = $lock; keys = $keys }
            if ($Json) { Write-Output (ConvertTo-Json -InputObject $r -Depth 4 -Compress) }
            else { Write-Output "acl: $($acl.detail)"; Write-Output "probe: $($probe.detail)"; Write-Output "lock: $($lock.mode) v$($lock.version) $(if ($lock.locked) { 'LOCKED' } else { 'unlocked' }) - $($lock.detail)" }
        }
        'lock-state' {
            # Lock state only (`botcorp status`): unwraps the key at most, never
            # an entry, so nothing is audited.
            $lock = Get-VaultLockState -BotHome $botHome -Bot $Bot
            if ($Json) { Write-Output (ConvertTo-Json -InputObject $lock -Depth 3 -Compress) }
            else { Write-Output "lock: $($lock.mode) v$($lock.version) $(if ($lock.locked) { 'LOCKED' } else { 'unlocked' }) - $($lock.detail)" }
        }
        'migrate' {
            $did = ConvertTo-VaultV2 -BotHome $botHome -Bot $Bot
            Write-Output ($(if ($did) { "secrets migrate: $Bot vault is now v2 (per-bot key, DPAPI-wrapped; lock mode none)" } else { "secrets migrate: $Bot vault is already v2" }))
        }
        'lock' {
            $st = Get-VaultLockState -BotHome $botHome -Bot $Bot
            if ($st.mode -eq 'operator') {
                # Already operator mode: re-lock now (drop the until-reboot cache).
                Lock-VaultNow -Bot $Bot
                Write-Output "secrets lock: $Bot re-locked (unlock cache dropped); botcorp secrets unlock $Bot to use it again"
            } else {
                $passphrase = Read-PassphraseFromStdin
                Lock-Vault -BotHome $botHome -Bot $Bot -Passphrase $passphrase
                Write-Output "secrets lock: $Bot is now operator-locked (v2 key wrapped under the passphrase only). It stays LOCKED after every reboot until: botcorp secrets unlock $Bot"
            }
        }
        'unlock' {
            $passphrase = Read-PassphraseFromStdin
            $how = Unlock-Vault -BotHome $botHome -Bot $Bot -Passphrase $passphrase -Permanent:$Permanent
            Write-Output ($(if ($how -eq 'permanent') { "secrets unlock: $Bot operator lock REMOVED (back to lock mode none: DPAPI-wrapped key, readable across reboots)" } else { "secrets unlock: $Bot unlocked until the next reboot (the daemon will start it on its next tick)" }))
        }
        'export-bundle' {
            if (-not $OutDir) { Write-Error 'secrets export-bundle: -OutDir required'; exit 1 }
            $passphrase = Read-PassphraseFromStdin

            $vaultRows = @(Get-VaultList -BotHome $botHome -Bot $Bot)
            $vaultOut = @{}
            foreach ($row in $vaultRows) {
                $vaultOut[$row.key] = Get-VaultSecret -BotHome $botHome -Bot $Bot -Key $row.key -Reason 'export'
            }

            # `~/x` = scope home (relative to USERPROFILE), else scope bot.
            # One comma-joined value: `pwsh -File` binds only the FIRST of
            # `-Files a b` to a [string[]] and silently drops the rest.
            $filesOut = @{}
            foreach ($relpath in @($Files | ForEach-Object { "$_" -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })) {
                $norm = $relpath -replace '\\', '/'
                if ($norm.StartsWith('~/')) {
                    $rel = $norm.Substring(2)
                    if (-not (Test-BundleHomeRelPath $rel)) { Write-Error "secrets export-bundle: bad home relpath '$relpath'"; exit 1 }
                    $full = Join-Path $env:USERPROFILE ($rel -replace '/', '\')
                } else {
                    if (-not (Test-BundleRelPath $norm)) { Write-Error "secrets export-bundle: bad relpath '$relpath'"; exit 1 }
                    $full = Join-Path $botHome $norm
                }
                if (-not (Test-Path $full -PathType Leaf)) { Write-Error "secrets export-bundle: file not found: $relpath"; exit 1 }
                $filesOut[$norm] = [System.IO.File]::ReadAllBytes($full)
            }

            [void](New-SecretsBundle -Bot $Bot -Passphrase $passphrase -Vault $vaultOut -Files $filesOut -OutDir $OutDir)
            Write-Output "bundle: $(Join-Path $OutDir 'secrets.bundle.enc') ($($vaultOut.Count) keys, $($filesOut.Count) files)"
        }
        'import-bundle' {
            if (-not $Bundle) { Write-Error 'secrets import-bundle: -Bundle required'; exit 1 }
            $manifestPath = if ($Manifest) { $Manifest } else { Join-Path (Split-Path $Bundle -Parent) 'secrets.manifest.json' }
            $passphrase = Read-PassphraseFromStdin

            $result = Import-SecretsBundle -Bot $Bot -Passphrase $passphrase -Manifest $manifestPath -Bundle $Bundle

            # Resolve EVERY target before anything is written, print them all,
            # then refuse as a whole: a home file without -AllowHome, any target
            # outside USERPROFILE / inside a bot folder / inside the runtime
            # home, or an existing file without -Force.
            $userProfile = Get-FullPathNorm $env:USERPROFILE
            $botsDirFull = Get-FullPathNorm $botsDir
            $botHomeFull = Get-FullPathNorm $botHome
            $rtHomeFull = Get-FullPathNorm (Get-VaultRuntimeRoot)
            $plans = @(); $homeCount = 0; $existing = @(); $bad = @()
            foreach ($k in ($result.files.Keys | Sort-Object)) {
                $f = $result.files[$k]
                $scope = "$($f.scope)"; $rel = "$($f.path)"
                if ($scope -eq 'home') {
                    $homeCount++
                    $full = Get-FullPathNorm (Join-Path $env:USERPROFILE ($rel -replace '/', '\'))
                    if (-not (Test-PathUnder $full $userProfile)) { $bad += "$rel (outside USERPROFILE)" }
                    elseif (Test-PathUnder $full $botsDirFull) { $bad += "$rel (inside a bot folder: $full)" }
                    elseif (Test-PathUnder $full $rtHomeFull) { $bad += "$rel (inside the BotCorp runtime home: $full)" }
                } else {
                    $full = Get-FullPathNorm (Join-Path $botHome ($rel -replace '/', '\'))
                    if (-not (Test-PathUnder $full $botHomeFull)) { $bad += "$rel (outside the bot folder)" }
                }
                $exists = Test-Path $full -PathType Leaf
                if ($exists) { $existing += $full }
                $plans += @{ scope = $scope; path = $rel; full = $full; exists = $exists; bytes = $f.bytes }
                Write-Output "target [$scope] $full$(if ($exists) { ' (EXISTS)' })"
            }
            foreach ($k in ($result.vault.Keys | Sort-Object)) { Write-Output "target [vault] $Bot/$k" }
            # [Console]::Error, not Write-Error: one plain line the CLI can echo
            # (Write-Error wraps a long message across decorated lines).
            if ($bad.Count -gt 0) { [Console]::Error.WriteLine("secrets import-bundle: refusing unsafe target(s): $($bad -join '; ') - nothing written"); exit 1 }

            if ($DryRun) {
                # A dry run is the preview of a real run: it reports the -AllowHome /
                # -Force refusals the real run would hit instead of stopping at the
                # first one, so the operator sees the whole plan in one pass.
                foreach ($p in $plans) { Write-Output "would restore [$($p.scope)] $($p.path)$(if ($p.exists) { ' (EXISTS)' })" }
                foreach ($k in ($result.vault.Keys | Sort-Object)) { Write-Output "would set vault $k" }
                if ($homeCount -gt 0 -and -not $AllowHome) { Write-Output "dry run: $homeCount home-scoped file(s) need -AllowHome (botcorp: --allow-home)" }
                if ($existing.Count -gt 0 -and -not $Force) { Write-Output "dry run: $($existing.Count) existing file(s) need -Force (botcorp: --force)" }
                Write-Output "secrets import-bundle: dry run - $($plans.Count) files, $($result.vault.Count) keys, nothing written"
            } else {
                if ($homeCount -gt 0 -and -not $AllowHome) { [Console]::Error.WriteLine("secrets import-bundle: $homeCount home-scoped file(s) (relative to $userProfile) need -AllowHome (botcorp: --allow-home) - nothing written"); exit 1 }
                if ($existing.Count -gt 0 -and -not $Force) { [Console]::Error.WriteLine("secrets import-bundle: would overwrite existing file(s) - pass -Force (botcorp: --force): $($existing -join '; ') - nothing written"); exit 1 }
                $me = "$env:USERDOMAIN\$env:USERNAME"
                foreach ($p in $plans) {
                    $dir = Split-Path $p.full -Parent
                    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
                    [System.IO.File]::WriteAllBytes($p.full, $p.bytes)
                    try { & (Join-Path $env:SystemRoot 'System32\icacls.exe') $p.full /inheritance:r /grant:r "${me}:F" 2>&1 | Out-Null } catch {}
                    Write-SecretAudit -Bot $Bot -Key "file:$($p.scope):$($p.path)" -Reason 'import' -Ok $true
                    Write-Output "restored [$($p.scope)] $($p.path)"
                }
                foreach ($k in ($result.vault.Keys | Sort-Object)) {
                    $masked = Set-VaultSecret -BotHome $botHome -Bot $Bot -Key $k -Value $result.vault[$k]
                    Write-SecretAudit -Bot $Bot -Key $k -Reason 'import' -Ok $true
                    Write-Output "vault $k = $masked"
                }
                Write-Output "secrets import-bundle: restored $($plans.Count) files, $($result.vault.Count) vault keys"
            }
        }
    }
    exit 0
} catch {
    # Never echo a value in an error path; the message can only name the key.
    Write-Error "secrets ${Action}: $($_.Exception.Message -replace '[A-Za-z0-9_-]{30,}', '****')"
    exit 1
}
