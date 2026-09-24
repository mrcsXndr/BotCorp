# vault.ps1 - the per-bot DPAPI vault. Dot-source it; secrets.ps1 is the CLI face.
#
#   . (Join-Path $PSScriptRoot 'vault.ps1')
#   Set-VaultSecret -BotHome <dir> -Bot <name> -Key oauth_token -Value <plaintext>
#   Get-VaultSecret -BotHome <dir> -Bot <name> -Key oauth_token -Reason <why> [-Nonce <launch nonce>]
#   Get-VaultList   -BotHome <dir> -Bot <name>                       -> masked entries
#   Remove-VaultSecret / Test-VaultTokenExclusive
#   ConvertTo-VaultV2 / Lock-Vault / Unlock-Vault / Get-VaultLockState   (per-bot key + operator lock)
#   New-LaunchNonce / Test-LaunchNonce / Confirm-LaunchNonce             (launch attestation)
#
# Files under <BotHome>/.vault/:
#   secrets.json  { "<key>": { "v": "<base64 DPAPI blob>", "fp": "<sha256 prefix>", "last4", "updated_at" }, ... }
#   key.json      (v2 only) { "v": 2, "wraps": { "dpapi": "<b64 DPAPI(K)>" | "operator": { kdf, iter, salt, nonce, ct } } }
#
# v1 (no key.json): each value is ProtectedData.Protect(bytes, entropy = bot
# name, CurrentUser). v2 (`botcorp secrets migrate`): a random 32-byte per-bot
# key K is the entropy for every entry, and K itself is WRAPPED once -
#   dpapi     DPAPI(K, entropy = bot name): readable by this Windows account on
#             this machine across an unattended reboot (lock mode `none`);
#   operator  AES-256-GCM(K) under PBKDF2-SHA256(passphrase) and NO dpapi wrap:
#             after a reboot the vault is LOCKED until `botcorp secrets unlock`
#             / the cockpit; the unwrapped K is then cached at
#             <BOTCORP_HOME>/state/unlock/<bot>.key, DPAPI-bound to the OS boot
#             time, so the cache dies with the boot (lock mode `operator`).
# Either way a copied .vault/ is useless anywhere else, which is the point.
# The scheduled-task principal is the same user, and a Password logon (or S4U
# with the real profile) decrypts CurrentUser blobs (probed before this was
# written). The directory ACL is reset to the user + SYSTEM only (chmod is a
# no-op on NTFS). `fp` is a keyed fingerprint (sha256 of "botcorp:" + value,
# 12 hex) so the daemon can refuse the SAME Telegram token in two bots without
# decrypting.
#
# Launch attestation: a trusted start path (the daemon tick, restart.ps1,
# launch-visible.ps1, `botcorp start`) mints a 32-byte nonce, records ONLY its
# sha256 in <BOTCORP_HOME>/state/<bot>.json `launch`, and hands the raw nonce
# to launch.ps1 (env BOTCORP_LAUNCH_NONCE). Get-VaultSecret -Reason launch
# refuses without a nonce that matches, is unconsumed and under 120 s old, so
# a launch.ps1 started any other way runs WITHOUT secrets. It proves which
# path launched; it is not an OS boundary (see docs/secrets.md).
#
# The plaintext must never be printed, logged or put on a command line: the
# launcher unprotects IN-PROCESS and sets the child env; the CLI reads a new
# value from a hidden prompt or stdin. Masking = **** + last 4.

Set-StrictMode -Off
$ErrorActionPreference = 'Stop'

try { Add-Type -AssemblyName System.Security -ErrorAction Stop } catch {}

$script:VaultKdfIterations = 600000
$script:VaultNonceMaxAgeSec = 120

function Get-VaultPath { param([string]$BotHome) return (Join-Path (Join-Path $BotHome '.vault') 'secrets.json') }
function Get-VaultKeyPath { param([string]$BotHome) return (Join-Path (Join-Path $BotHome '.vault') 'key.json') }

function Get-VaultRuntimeRoot {
    # <BOTCORP_HOME> (audit log, launch state, unlock cache); the daemon exports it.
    if ($env:BOTCORP_HOME) { return $env:BOTCORP_HOME }
    return (Join-Path $env:USERPROFILE '.botcorp')
}

function Read-VaultStore {
    param([string]$BotHome)
    $p = Get-VaultPath $BotHome
    if (-not (Test-Path $p)) { return @{} }
    $raw = [System.IO.File]::ReadAllText($p)
    if (-not $raw.Trim()) { return @{} }
    $obj = $raw | ConvertFrom-Json
    $h = @{}
    foreach ($prop in $obj.PSObject.Properties) { $h[$prop.Name] = $prop.Value }
    return $h
}

function Protect-VaultDir {
    # Reset inheritance and grant only the current user + SYSTEM, on the
    # directory AND every file already in it (a file created before the
    # directory ACL was reset keeps its inherited ACEs otherwise). Best-effort:
    # a failure here is reported, not fatal (the blob is DPAPI-bound anyway).
    # This is hygiene, not isolation: every bot runs as this same user, so the
    # ACL cannot keep one bot's process out of another bot's vault - the
    # harness vault-guard hook and the audit log are what cover that.
    param([string]$Dir)
    try {
        $me = "$env:USERDOMAIN\$env:USERNAME"
        $icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
        & $icacls $Dir /inheritance:r /grant:r "${me}:(OI)(CI)F" "SYSTEM:(OI)(CI)F" 2>&1 | Out-Null
        foreach ($f in (Get-ChildItem -Path $Dir -File -Force -ErrorAction SilentlyContinue)) {
            & $icacls $f.FullName /inheritance:r /grant:r "${me}:F" "SYSTEM:F" 2>&1 | Out-Null
        }
    } catch { Write-Warning "vault: could not set ACL on ${Dir}: $($_.Exception.Message)" }
}

function Test-VaultAcl {
    # Does <BotHome>/.vault (and each file in it) grant ONLY the current user
    # and SYSTEM, with inheritance off? Returns @{ ok; detail } for doctor.
    param([string]$BotHome)
    $dir = Join-Path $BotHome '.vault'
    if (-not (Test-Path $dir)) { return @{ ok = $true; detail = 'no vault yet' } }
    $me = "$env:USERDOMAIN\$env:USERNAME"
    $allowed = @($me.ToLowerInvariant(), 'nt authority\system')
    $bad = @()
    foreach ($item in @(Get-Item $dir) + @(Get-ChildItem -Path $dir -File -Force -ErrorAction SilentlyContinue)) {
        try {
            $acl = Get-Acl -Path $item.FullName
            if (-not $acl.AreAccessRulesProtected) { $bad += "$($item.Name): inheritance on"; continue }
            $extra = @($acl.Access | Where-Object { $_.IdentityReference.Value.ToLowerInvariant() -notin $allowed } | ForEach-Object { $_.IdentityReference.Value })
            if ($extra.Count -gt 0) { $bad += "$($item.Name): also grants $($extra -join ', ')" }
        } catch { $bad += "$($item.Name): unreadable ACL" }
    }
    if ($bad.Count -eq 0) { return @{ ok = $true; detail = "$me + SYSTEM only, inheritance off" } }
    return @{ ok = $false; detail = ($bad -join '; ') }
}

function Write-VaultStore {
    param([string]$BotHome, [hashtable]$Store)
    $dir = Join-Path $BotHome '.vault'
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $p = Get-VaultPath $BotHome
    $tmp = "$p.tmp"
    # Ordered, no BOM, trailing newline: identical input -> identical bytes.
    $ordered = [ordered]@{}
    foreach ($k in ($Store.Keys | Sort-Object)) { $ordered[$k] = $Store[$k] }
    [System.IO.File]::WriteAllText($tmp, (($ordered | ConvertTo-Json -Depth 4) + "`n"))
    Move-Item -Force $tmp $p
    # AFTER the move: the ACL pass covers the file that now exists (before it,
    # a freshly moved secrets.json kept inherited ACEs).
    Protect-VaultDir $dir
}

function Write-VaultJsonFile {
    # Atomic, no BOM, then the vault ACL pass (key.json lives next to secrets.json).
    param([string]$BotHome, [string]$Path, $Object)
    $dir = Join-Path $BotHome '.vault'
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $tmp = "$Path.tmp"
    [System.IO.File]::WriteAllText($tmp, (($Object | ConvertTo-Json -Depth 6) + "`n"))
    Move-Item -Force $tmp $Path
    Protect-VaultDir $dir
}

$script:VaultParentPid = $null
function Get-VaultParentPid {
    if ($null -eq $script:VaultParentPid) {
        try { $script:VaultParentPid = [int](Get-CimInstance Win32_Process -Filter "ProcessId=$PID" -ErrorAction Stop).ParentProcessId } catch { $script:VaultParentPid = 0 }
    }
    return $script:VaultParentPid
}

function Write-SecretAudit {
    # Append-only record of EVERY decrypt attempt (and every bundle-import
    # write) - bot, key, why, which process - never the value.
    # <BOTCORP_HOME>/state/secret-access.jsonl; `botcorp secrets audit` and the
    # cockpit read it. Fail-open: auditing can never block a launch.
    param([string]$Bot, [string]$Key, [string]$Reason, [bool]$Ok, [string]$Nonce)
    try {
        $dir = Join-Path (Get-VaultRuntimeRoot) 'state'
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        $rec = [ordered]@{ ts = (Get-Date).ToUniversalTime().ToString('o'); bot = $Bot; key = $Key; reason = $Reason; pid = $PID; ppid = (Get-VaultParentPid); ok = $Ok }
        if ($Nonce) { $rec['nonce'] = $Nonce.Substring(0, [Math]::Min(8, $Nonce.Length)) }
        $bytes = [System.Text.Encoding]::UTF8.GetBytes((($rec | ConvertTo-Json -Compress) + "`n"))
        $fs = [System.IO.File]::Open((Join-Path $dir 'secret-access.jsonl'), [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
        try { $fs.Write($bytes, 0, $bytes.Length) } finally { $fs.Dispose() }
    } catch {}
}

function Get-VaultSha256Hex {
    param([byte[]]$Bytes)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $h = $sha.ComputeHash($Bytes) } finally { $sha.Dispose() }
    return (($h | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Get-VaultFingerprint {
    param([string]$Value)
    return (Get-VaultSha256Hex ([System.Text.Encoding]::UTF8.GetBytes("botcorp:$Value"))).Substring(0, 12)
}

function Protect-VaultValue {
    # -Key (v2): the per-bot key is the entropy; else (v1) the bot name.
    param([string]$Bot, [string]$Value, [byte[]]$Key)
    $plain = [System.Text.Encoding]::UTF8.GetBytes($Value)
    $entropy = if ($Key) { $Key } else { [System.Text.Encoding]::UTF8.GetBytes($Bot) }
    $blob = [System.Security.Cryptography.ProtectedData]::Protect($plain, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    return [Convert]::ToBase64String($blob)
}

function Unprotect-VaultValue {
    param([string]$Bot, [string]$B64, [byte[]]$Key)
    $blob = [Convert]::FromBase64String($B64)
    $entropy = if ($Key) { $Key } else { [System.Text.Encoding]::UTF8.GetBytes($Bot) }
    $plain = [System.Security.Cryptography.ProtectedData]::Unprotect($blob, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    return [System.Text.Encoding]::UTF8.GetString($plain)
}

# --- v2 key file + lock mode -------------------------------------------------------
function Read-VaultKeyFile {
    param([string]$BotHome)
    $p = Get-VaultKeyPath $BotHome
    if (-not (Test-Path $p)) { return $null }
    $raw = [System.IO.File]::ReadAllText($p)
    if (-not $raw.Trim()) { return $null }
    return ($raw | ConvertFrom-Json)
}

function Test-VaultWrap { param($KeyFile, [string]$Name)
    try { return ($KeyFile -and $KeyFile.wraps -and ($KeyFile.wraps.PSObject.Properties.Name -contains $Name) -and $null -ne $KeyFile.wraps.$Name) } catch { return $false }
}

$script:VaultBootStamp = $null
function Get-VaultBootStamp {
    # The OS boot time that binds an unlock cache to THIS boot, as
    # "boot:<UTC ISO>" - the prefix keeps ConvertFrom-Json from turning the
    # stored copy into a [datetime] (which would never compare equal again).
    # BOTCORP_FAKE_BOOT is a test seam only (simulates a reboot).
    if ($env:BOTCORP_FAKE_BOOT) { return "boot:$env:BOTCORP_FAKE_BOOT" }
    if (-not $script:VaultBootStamp) {
        $script:VaultBootStamp = 'boot:' + (Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToUniversalTime().ToString('o')
    }
    return $script:VaultBootStamp
}

function Get-VaultUnlockCachePath { param([string]$Bot) return (Join-Path (Join-Path (Get-VaultRuntimeRoot) 'state\unlock') "$Bot.key") }

function Get-VaultKey {
    # The v2 per-bot key K (32 bytes), or $null for a v1 vault. Throws
    # 'vault: <bot> is locked' when the only wrap is the operator one and no
    # unlock cache from THIS boot exists (a stale cache is deleted).
    param([Parameter(Mandatory)][string]$BotHome, [Parameter(Mandatory)][string]$Bot)
    $kf = Read-VaultKeyFile $BotHome
    if (-not $kf) { return $null }
    if (Test-VaultWrap $kf 'dpapi') {
        return [System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String("$($kf.wraps.dpapi)"), [System.Text.Encoding]::UTF8.GetBytes($Bot), [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    }
    $cache = Get-VaultUnlockCachePath $Bot
    if (Test-Path $cache) {
        try {
            $c = [System.IO.File]::ReadAllText($cache) | ConvertFrom-Json
            $boot = Get-VaultBootStamp
            if ("$($c.boot)" -eq $boot) {
                return [System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String("$($c.k)"), [System.Text.Encoding]::UTF8.GetBytes("unlock:${Bot}:$boot"), [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
            }
        } catch {}
        # From an earlier boot (or unreadable): it can never unlock again.
        try { Remove-Item $cache -Force -ErrorAction SilentlyContinue } catch {}
    }
    throw "vault: $Bot is locked (operator lock, not unlocked since boot) - botcorp secrets unlock $Bot"
}

function Get-VaultLockState {
    # @{ mode = none|operator; version = 1|2; locked = bool; detail } - never decrypts an entry.
    param([Parameter(Mandatory)][string]$BotHome, [Parameter(Mandatory)][string]$Bot)
    $kf = Read-VaultKeyFile $BotHome
    if (-not $kf) { return @{ mode = 'none'; version = 1; locked = $false; detail = "v1 vault (bot-name entropy); botcorp secrets migrate $Bot moves it to a per-bot key" } }
    if (Test-VaultWrap $kf 'dpapi') { return @{ mode = 'none'; version = 2; locked = $false; detail = 'per-bot key, DPAPI-wrapped (readable across an unattended reboot)' } }
    if (-not (Test-VaultWrap $kf 'operator')) { return @{ mode = 'operator'; version = 2; locked = $true; detail = 'key.json has no usable wrap (corrupt) - re-enter the secrets' } }
    try { [void](Get-VaultKey -BotHome $BotHome -Bot $Bot); return @{ mode = 'operator'; version = 2; locked = $false; detail = 'operator lock, unlocked until reboot' } }
    catch { return @{ mode = 'operator'; version = 2; locked = $true; detail = "operator lock, LOCKED since boot (botcorp secrets unlock $Bot or the cockpit)" } }
}

function Test-VaultLocked { param([string]$BotHome, [string]$Bot) try { return [bool](Get-VaultLockState -BotHome $BotHome -Bot $Bot).locked } catch { return $false } }

function New-VaultOperatorWrap {
    param([string]$Bot, [byte[]]$Key, [string]$Passphrase)
    $salt = [byte[]]::new(16); [System.Security.Cryptography.RandomNumberGenerator]::Fill($salt)
    $nonce = [byte[]]::new(12); [System.Security.Cryptography.RandomNumberGenerator]::Fill($nonce)
    $kek = [System.Security.Cryptography.Rfc2898DeriveBytes]::Pbkdf2([System.Text.Encoding]::UTF8.GetBytes($Passphrase), $salt, $script:VaultKdfIterations, [System.Security.Cryptography.HashAlgorithmName]::SHA256, 32)
    $ct = [byte[]]::new($Key.Length); $tag = [byte[]]::new(16)
    $aes = [System.Security.Cryptography.AesGcm]::new($kek, 16)
    try { $aes.Encrypt($nonce, $Key, $ct, $tag, [System.Text.Encoding]::UTF8.GetBytes("botcorp-vault-key:$Bot")) } finally { $aes.Dispose() }
    return [ordered]@{ kdf = 'pbkdf2-sha256'; iter = $script:VaultKdfIterations; salt = [Convert]::ToBase64String($salt); nonce = [Convert]::ToBase64String($nonce); ct = [Convert]::ToBase64String($ct + $tag) }
}

function Unprotect-VaultOperatorWrap {
    param([string]$Bot, $Wrap, [string]$Passphrase)
    $salt = [Convert]::FromBase64String("$($Wrap.salt)"); $nonce = [Convert]::FromBase64String("$($Wrap.nonce)")
    $blob = [Convert]::FromBase64String("$($Wrap.ct)")
    if ($blob.Length -lt 17) { throw 'vault: corrupt operator wrap' }
    $ct = $blob[0..($blob.Length - 17)]; $tag = $blob[($blob.Length - 16)..($blob.Length - 1)]
    $kek = [System.Security.Cryptography.Rfc2898DeriveBytes]::Pbkdf2([System.Text.Encoding]::UTF8.GetBytes($Passphrase), $salt, [int]$Wrap.iter, [System.Security.Cryptography.HashAlgorithmName]::SHA256, 32)
    $key = [byte[]]::new($ct.Length)
    $aes = [System.Security.Cryptography.AesGcm]::new($kek, 16)
    try { try { $aes.Decrypt($nonce, $ct, $tag, $key, [System.Text.Encoding]::UTF8.GetBytes("botcorp-vault-key:$Bot")) } catch { throw 'vault: wrong passphrase' } } finally { $aes.Dispose() }
    return $key
}

function ConvertTo-VaultV2 {
    # v1 -> v2: mint K, re-protect every entry with it, key.json with the dpapi
    # wrap (lock mode none). Returns $false when already v2. Needs every v1
    # entry readable by this account.
    param([Parameter(Mandatory)][string]$BotHome, [Parameter(Mandatory)][string]$Bot)
    if (Read-VaultKeyFile $BotHome) { return $false }
    $store = Read-VaultStore $BotHome
    # ($vaultKey, not $K: variable names are case-insensitive and $k is the loop entry name)
    $vaultKey = [byte[]]::new(32); [System.Security.Cryptography.RandomNumberGenerator]::Fill($vaultKey)
    $new = @{}
    foreach ($entryName in $store.Keys) {
        $rec = $store[$entryName]
        $plain = Unprotect-VaultValue -Bot $Bot -B64 $rec.v
        $h = [ordered]@{}
        foreach ($p in $rec.PSObject.Properties) { $h[$p.Name] = $p.Value }
        $h['v'] = Protect-VaultValue -Bot $Bot -Value $plain -Key $vaultKey
        $new[$entryName] = $h
    }
    $kf = [ordered]@{ v = 2; created_at = (Get-Date).ToUniversalTime().ToString('o'); wraps = [ordered]@{ dpapi = [Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect($vaultKey, [System.Text.Encoding]::UTF8.GetBytes($Bot), [System.Security.Cryptography.DataProtectionScope]::CurrentUser)) } }
    Write-VaultJsonFile -BotHome $BotHome -Path (Get-VaultKeyPath $BotHome) -Object $kf
    try { Write-VaultStore -BotHome $BotHome -Store $new }
    catch { try { Remove-Item (Get-VaultKeyPath $BotHome) -Force -ErrorAction SilentlyContinue } catch {}; throw }
    return $true
}

function Lock-Vault {
    # Operator lock: K wrapped under the passphrase ONLY (the dpapi wrap is
    # removed) and the unlock cache dropped, so the vault is locked right now
    # and after every reboot until `unlock`. Migrates a v1 vault first.
    param([Parameter(Mandatory)][string]$BotHome, [Parameter(Mandatory)][string]$Bot, [Parameter(Mandatory)][string]$Passphrase)
    if ($Passphrase.Length -lt 8) { throw 'vault: passphrase must be at least 8 characters' }
    [void](ConvertTo-VaultV2 -BotHome $BotHome -Bot $Bot)
    $K = Get-VaultKey -BotHome $BotHome -Bot $Bot
    $kf = Read-VaultKeyFile $BotHome
    $out = [ordered]@{ v = 2; created_at = "$($kf.created_at)"; locked_at = (Get-Date).ToUniversalTime().ToString('o'); wraps = [ordered]@{ operator = (New-VaultOperatorWrap -Bot $Bot -Key $K -Passphrase $Passphrase) } }
    Write-VaultJsonFile -BotHome $BotHome -Path (Get-VaultKeyPath $BotHome) -Object $out
    Lock-VaultNow -Bot $Bot
}

function Lock-VaultNow {
    # Drop the unlock cache: locked until the next `unlock` (no passphrase needed).
    param([Parameter(Mandatory)][string]$Bot)
    try { Remove-Item (Get-VaultUnlockCachePath $Bot) -Force -ErrorAction SilentlyContinue } catch {}
}

function Unlock-Vault {
    # Verify the passphrase (GCM tag), then cache K for THIS boot only:
    # DPAPI(K, entropy "unlock:<bot>:<boot time>") at state/unlock/<bot>.key,
    # ACL'd to the user. -Permanent instead restores the dpapi wrap and
    # removes the operator one (back to lock mode none).
    param([Parameter(Mandatory)][string]$BotHome, [Parameter(Mandatory)][string]$Bot, [Parameter(Mandatory)][string]$Passphrase, [switch]$Permanent)
    $kf = Read-VaultKeyFile $BotHome
    if (-not (Test-VaultWrap $kf 'operator')) { throw "vault: $Bot is not operator-locked (nothing to unlock)" }
    $K = $null
    try { $K = Unprotect-VaultOperatorWrap -Bot $Bot -Wrap $kf.wraps.operator -Passphrase $Passphrase }
    catch { Write-SecretAudit -Bot $Bot -Key '*' -Reason 'unlock' -Ok $false; throw }
    if ($Permanent) {
        $out = [ordered]@{ v = 2; created_at = "$($kf.created_at)"; wraps = [ordered]@{ dpapi = [Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect($K, [System.Text.Encoding]::UTF8.GetBytes($Bot), [System.Security.Cryptography.DataProtectionScope]::CurrentUser)) } }
        Write-VaultJsonFile -BotHome $BotHome -Path (Get-VaultKeyPath $BotHome) -Object $out
        Lock-VaultNow -Bot $Bot
        Write-SecretAudit -Bot $Bot -Key '*' -Reason 'unlock' -Ok $true
        return 'permanent'
    }
    $boot = Get-VaultBootStamp
    $cache = Get-VaultUnlockCachePath $Bot
    $dir = Split-Path $cache -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $rec = [ordered]@{ bot = $Bot; boot = $boot; unlocked_at = (Get-Date).ToUniversalTime().ToString('o'); k = [Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect($K, [System.Text.Encoding]::UTF8.GetBytes("unlock:${Bot}:$boot"), [System.Security.Cryptography.DataProtectionScope]::CurrentUser)) }
    [System.IO.File]::WriteAllText("$cache.tmp", (($rec | ConvertTo-Json -Depth 3) + "`n"))
    Move-Item -Force "$cache.tmp" $cache
    try { & (Join-Path $env:SystemRoot 'System32\icacls.exe') $cache /inheritance:r /grant:r "$env:USERDOMAIN\${env:USERNAME}:F" 2>&1 | Out-Null } catch {}
    Write-SecretAudit -Bot $Bot -Key '*' -Reason 'unlock' -Ok $true
    return 'until-reboot'
}

# --- launch attestation ---------------------------------------------------------------
function Get-VaultLaunchStatePath { param([string]$Bot) return (Join-Path (Join-Path (Get-VaultRuntimeRoot) 'state') "$Bot.json") }

function Update-VaultLaunchState {
    # Merge `launch` into state/<bot>.json (the same read-merge-write the daemon's
    # Write-BotState does; every other key is preserved).
    param([string]$Bot, $Launch)
    $p = Get-VaultLaunchStatePath $Bot
    $m = [ordered]@{}
    try {
        if (Test-Path $p) { $cur = [System.IO.File]::ReadAllText($p) | ConvertFrom-Json; foreach ($prop in $cur.PSObject.Properties) { $m[$prop.Name] = $prop.Value } }
    } catch {}
    if (-not $m.Contains('bot')) { $m['bot'] = $Bot }
    $m['launch'] = $Launch
    $dir = Split-Path $p -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    [System.IO.File]::WriteAllText($p, (($m | ConvertTo-Json -Depth 6) + "`n"))
}

function New-LaunchNonce {
    # 32 random bytes as hex. Only sha256(nonce) is recorded (state files are
    # readable by every process of this user); the raw nonce goes to the
    # launcher via env, never to disk.
    param([Parameter(Mandatory)][string]$Bot)
    $b = [byte[]]::new(32); [System.Security.Cryptography.RandomNumberGenerator]::Fill($b)
    $nonce = (($b | ForEach-Object { $_.ToString('x2') }) -join '')
    # at_unix drives the age check (ConvertFrom-Json would turn an ISO `at` into a [datetime]).
    Update-VaultLaunchState -Bot $Bot -Launch ([ordered]@{ nonce_sha256 = (Get-VaultSha256Hex ([System.Text.Encoding]::UTF8.GetBytes($nonce))); minted_by_pid = $PID; at = (Get-Date).ToUniversalTime().ToString('o'); at_unix = [long][DateTimeOffset]::UtcNow.ToUnixTimeSeconds(); consumed_at = $null })
    return $nonce
}

function Test-LaunchNonce {
    # Matches the recorded hash, not consumed, minted under MaxAgeSec ago.
    param([Parameter(Mandatory)][string]$Bot, [string]$Nonce, [int]$MaxAgeSec = $script:VaultNonceMaxAgeSec)
    if (-not $Nonce -or $Nonce -notmatch '^[0-9a-f]{64}$') { return $false }
    try {
        $p = Get-VaultLaunchStatePath $Bot
        if (-not (Test-Path $p)) { return $false }
        $st = [System.IO.File]::ReadAllText($p) | ConvertFrom-Json
        if (-not ($st.PSObject.Properties.Name -contains 'launch') -or $null -eq $st.launch) { return $false }
        $l = $st.launch
        if (($l.PSObject.Properties.Name -contains 'consumed_at') -and $l.consumed_at) { return $false }
        if (-not ($l.PSObject.Properties.Name -contains 'at_unix')) { return $false }
        $age = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - [long]$l.at_unix
        if ($age -lt 0 -or $age -gt $MaxAgeSec) { return $false }
        return ("$($l.nonce_sha256)" -eq (Get-VaultSha256Hex ([System.Text.Encoding]::UTF8.GetBytes($Nonce))))
    } catch { return $false }
}

function Confirm-LaunchNonce {
    # Consume: the child is up (or about to exec); the same nonce never
    # authorises another decrypt.
    param([Parameter(Mandatory)][string]$Bot)
    try {
        $st = [System.IO.File]::ReadAllText((Get-VaultLaunchStatePath $Bot)) | ConvertFrom-Json
        if (-not $st.launch) { return }
        $l = [ordered]@{}
        foreach ($p in $st.launch.PSObject.Properties) { $l[$p.Name] = $p.Value }
        $l['consumed_at'] = (Get-Date).ToUniversalTime().ToString('o')
        Update-VaultLaunchState -Bot $Bot -Launch $l
    } catch {}
}

# --- entries -----------------------------------------------------------------------------
function Set-VaultSecret {
    param([Parameter(Mandatory)][string]$BotHome, [Parameter(Mandatory)][string]$Bot,
          [Parameter(Mandatory)][string]$Key, [Parameter(Mandatory)][string]$Value)
    if ($Key -notmatch '^[a-z][a-z0-9_]{0,63}$') { throw "vault: key must be [a-z][a-z0-9_]* (got '$Key')" }
    $v = $Value.Trim([char]0xFEFF, ' ', "`t", "`r", "`n")
    if (-not $v) { throw 'vault: empty value' }
    $K = Get-VaultKey -BotHome $BotHome -Bot $Bot   # throws when operator-locked
    $store = Read-VaultStore $BotHome
    # last4 is stored so `list` never has to decrypt (every decrypt is audited).
    $store[$Key] = [ordered]@{
        v          = (Protect-VaultValue -Bot $Bot -Value $v -Key $K)
        fp         = (Get-VaultFingerprint $v)
        last4      = $v.Substring([Math]::Max(0, $v.Length - 4))
        updated_at = (Get-Date).ToUniversalTime().ToString('o')
    }
    Write-VaultStore -BotHome $BotHome -Store $store
    return "****" + $v.Substring([Math]::Max(0, $v.Length - 4))
}

function Get-VaultSecret {
    # The ONE decrypt path. -Reason names the caller for the audit line
    # (launch | automation | cli | list | export | doctor | unlock | import); a
    # missing key is $null and is not audited, a failed unprotect (or a locked
    # vault, or an unattested launch) is audited ok=false and rethrown.
    # Reason `launch` is refused without a valid -Nonce (Test-LaunchNonce).
    param([Parameter(Mandatory)][string]$BotHome, [Parameter(Mandatory)][string]$Bot, [Parameter(Mandatory)][string]$Key,
          [string]$Reason = 'cli', [string]$Nonce)
    $store = Read-VaultStore $BotHome
    if (-not $store.ContainsKey($Key)) { return $null }
    $rec = $store[$Key]
    try {
        if ($Reason -eq 'launch' -and -not (Test-LaunchNonce -Bot $Bot -Nonce $Nonce)) { throw "vault: launch not attested (no valid launch nonce) - start the bot with: botcorp start $Bot" }
        $K = Get-VaultKey -BotHome $BotHome -Bot $Bot
        $plain = Unprotect-VaultValue -Bot $Bot -B64 $rec.v -Key $K
        Write-SecretAudit -Bot $Bot -Key $Key -Reason $Reason -Ok $true -Nonce $Nonce
        return $plain
    } catch {
        Write-SecretAudit -Bot $Bot -Key $Key -Reason $Reason -Ok $false -Nonce $Nonce
        throw
    }
}

function Get-VaultList {
    # Masked entries only, WITHOUT decrypting: last4 is stored at set time. An
    # entry written before last4 existed is decrypted once (audited, reason
    # list) so it still shows; a blob this account cannot decrypt (copied from
    # another box/user) shows as 'unreadable' rather than failing the whole
    # listing, so `doctor` can say "re-enter tokens".
    param([Parameter(Mandatory)][string]$BotHome, [Parameter(Mandatory)][string]$Bot)
    $store = Read-VaultStore $BotHome
    $out = @()
    foreach ($k in ($store.Keys | Sort-Object)) {
        $rec = $store[$k]
        $masked = 'unreadable'
        $last4 = $null
        try { if ($rec.PSObject.Properties.Name -contains 'last4') { $last4 = "$($rec.last4)" } } catch {}
        if ($last4) { $masked = '****' + $last4 }
        else {
            try { $plain = Get-VaultSecret -BotHome $BotHome -Bot $Bot -Key $k -Reason 'list'; $masked = '****' + $plain.Substring([Math]::Max(0, $plain.Length - 4)) } catch {}
        }
        $out += [pscustomobject]@{ key = $k; masked = $masked; fp = $rec.fp; updated_at = $rec.updated_at }
    }
    return $out
}

function Remove-VaultSecret {
    param([Parameter(Mandatory)][string]$BotHome, [Parameter(Mandatory)][string]$Key)
    $store = Read-VaultStore $BotHome
    if (-not $store.ContainsKey($Key)) { return $false }
    $store.Remove($Key)
    Write-VaultStore -BotHome $BotHome -Store $store
    return $true
}

function Test-VaultTokenExclusive {
    # The single-poller invariant is per Telegram token: two bots with the same
    # token would fight over one getUpdates slot. Returns the name of another
    # bot under <BotsDir> whose vault holds the same fingerprint, else $null.
    param([Parameter(Mandatory)][string]$BotsDir, [Parameter(Mandatory)][string]$Bot,
          [Parameter(Mandatory)][string]$Key, [Parameter(Mandatory)][string]$Value)
    $fp = Get-VaultFingerprint $Value.Trim()
    foreach ($d in (Get-ChildItem -Path $BotsDir -Directory -ErrorAction SilentlyContinue)) {
        if ($d.Name -eq $Bot -or $d.Name.StartsWith('_')) { continue }
        try {
            $st = Read-VaultStore $d.FullName
            if ($st.ContainsKey($Key) -and $st[$Key].fp -eq $fp) { return $d.Name }
        } catch {}
    }
    return $null
}
