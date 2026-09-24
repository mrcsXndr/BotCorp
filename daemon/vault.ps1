# vault.ps1 - the per-bot DPAPI vault. Dot-source it; secrets.ps1 is the CLI face.
#
#   . (Join-Path $PSScriptRoot 'vault.ps1')
#   Set-VaultSecret -BotHome <dir> -Bot <name> -Key oauth_token -Value <plaintext>
#   Get-VaultSecret -BotHome <dir> -Bot <name> -Key oauth_token      -> plaintext or $null
#   Get-VaultList   -BotHome <dir> -Bot <name>                       -> masked entries
#   Remove-VaultSecret / Test-VaultTokenExclusive
#
# File: <BotHome>/.vault/secrets.json
#   { "<key>": { "v": "<base64 DPAPI blob>", "fp": "<sha256 prefix>", "updated_at": "<iso>" }, ... }
#
# Values are protected with ProtectedData.Protect(bytes, entropy = bot name,
# DataProtectionScope.CurrentUser): only THIS Windows account on THIS machine
# can unprotect them - a copied .vault/ is useless anywhere else, which is the
# point. The scheduled-task principal is S4U for the same user, and S4U with
# the real profile decrypts CurrentUser blobs (probed before this was written).
# The directory ACL is reset to the user + SYSTEM only (chmod is a no-op on
# NTFS). `fp` is a keyed fingerprint (sha256 of "botcorp:" + value, 12 hex) so
# the daemon can refuse the SAME Telegram token in two bots without decrypting.
#
# The plaintext must never be printed, logged or put on a command line: the
# launcher unprotects IN-PROCESS and sets the child env; the CLI reads a new
# value from a hidden prompt or stdin. Masking = **** + last 4.

Set-StrictMode -Off
$ErrorActionPreference = 'Stop'

try { Add-Type -AssemblyName System.Security -ErrorAction Stop } catch {}

function Get-VaultPath { param([string]$BotHome) return (Join-Path (Join-Path $BotHome '.vault') 'secrets.json') }

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
    # Reset inheritance and grant only the current user + SYSTEM. Best-effort:
    # a failure here is reported, not fatal (the blob is DPAPI-bound anyway).
    param([string]$Dir)
    try {
        $me = "$env:USERDOMAIN\$env:USERNAME"
        & icacls $Dir /inheritance:r /grant:r "${me}:(OI)(CI)F" "SYSTEM:(OI)(CI)F" 2>&1 | Out-Null
    } catch { Write-Warning "vault: could not set ACL on ${Dir}: $($_.Exception.Message)" }
}

function Write-VaultStore {
    param([string]$BotHome, [hashtable]$Store)
    $dir = Join-Path $BotHome '.vault'
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Protect-VaultDir $dir
    $p = Get-VaultPath $BotHome
    $tmp = "$p.tmp"
    # Ordered, no BOM, trailing newline: identical input -> identical bytes.
    $ordered = [ordered]@{}
    foreach ($k in ($Store.Keys | Sort-Object)) { $ordered[$k] = $Store[$k] }
    [System.IO.File]::WriteAllText($tmp, (($ordered | ConvertTo-Json -Depth 4) + "`n"))
    Move-Item -Force $tmp $p
}

function Get-VaultFingerprint {
    param([string]$Value)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes("botcorp:$Value"))
    } finally { $sha.Dispose() }
    return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0, 12)
}

function Protect-VaultValue {
    param([string]$Bot, [string]$Value)
    $plain = [System.Text.Encoding]::UTF8.GetBytes($Value)
    $entropy = [System.Text.Encoding]::UTF8.GetBytes($Bot)
    $blob = [System.Security.Cryptography.ProtectedData]::Protect($plain, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    return [Convert]::ToBase64String($blob)
}

function Unprotect-VaultValue {
    param([string]$Bot, [string]$B64)
    $blob = [Convert]::FromBase64String($B64)
    $entropy = [System.Text.Encoding]::UTF8.GetBytes($Bot)
    $plain = [System.Security.Cryptography.ProtectedData]::Unprotect($blob, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    return [System.Text.Encoding]::UTF8.GetString($plain)
}

function Set-VaultSecret {
    param([Parameter(Mandatory)][string]$BotHome, [Parameter(Mandatory)][string]$Bot,
          [Parameter(Mandatory)][string]$Key, [Parameter(Mandatory)][string]$Value)
    if ($Key -notmatch '^[a-z][a-z0-9_]{0,63}$') { throw "vault: key must be [a-z][a-z0-9_]* (got '$Key')" }
    $v = $Value.Trim([char]0xFEFF, ' ', "`t", "`r", "`n")
    if (-not $v) { throw 'vault: empty value' }
    $store = Read-VaultStore $BotHome
    $store[$Key] = [ordered]@{
        v          = (Protect-VaultValue -Bot $Bot -Value $v)
        fp         = (Get-VaultFingerprint $v)
        updated_at = (Get-Date).ToUniversalTime().ToString('o')
    }
    Write-VaultStore -BotHome $BotHome -Store $store
    return "****" + $v.Substring([Math]::Max(0, $v.Length - 4))
}

function Get-VaultSecret {
    param([Parameter(Mandatory)][string]$BotHome, [Parameter(Mandatory)][string]$Bot, [Parameter(Mandatory)][string]$Key)
    $store = Read-VaultStore $BotHome
    if (-not $store.ContainsKey($Key)) { return $null }
    $rec = $store[$Key]
    return (Unprotect-VaultValue -Bot $Bot -B64 $rec.v)
}

function Get-VaultList {
    # Masked entries only. Decrypts to compute last4; a blob this account cannot
    # decrypt (copied from another box/user) shows as 'unreadable' rather than
    # failing the whole listing, so `doctor` can say "re-enter tokens".
    param([Parameter(Mandatory)][string]$BotHome, [Parameter(Mandatory)][string]$Bot)
    $store = Read-VaultStore $BotHome
    $out = @()
    foreach ($k in ($store.Keys | Sort-Object)) {
        $rec = $store[$k]
        $masked = 'unreadable'
        try {
            $plain = Unprotect-VaultValue -Bot $Bot -B64 $rec.v
            $masked = '****' + $plain.Substring([Math]::Max(0, $plain.Length - 4))
        } catch {}
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
