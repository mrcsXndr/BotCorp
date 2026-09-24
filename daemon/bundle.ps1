# bundle.ps1 - encrypted secrets-bundle format. Dot-sourced by secrets.ps1;
# pure .NET crypto, pwsh 7.4+ (AesGcm(key, tagSize) + Rfc2898DeriveBytes.Pbkdf2
# are both available on this box's pwsh 7.6).
#
#   . (Join-Path $PSScriptRoot 'bundle.ps1')
#   New-SecretsBundle    -Bot <name> -Passphrase <string> -Vault <hashtable> -Files <hashtable> -OutDir <dir>
#   Import-SecretsBundle -Bot <name> -Passphrase <string> -Manifest <path> -Bundle <path>
#
# Manifest (secrets.manifest.json, schema 1) + bundle (secrets.bundle.enc):
#   manifest = {
#     schema: 1, bot: "<name>", created_at: "<ISO UTC>", cipher: "aes-256-gcm",
#     kdf: { name: "pbkdf2-sha256", iterations: 600000, salt: "<b64 16 bytes>" },
#     nonce: "<b64 12 bytes>", bundle: "secrets.bundle.enc",
#     sha256: "<hex sha256 of the .enc file bytes>",
#     vault_keys: ["<key>", ...],
#     files: [ { path: "<relpath>", scope: "bot" | "home", sha256: "<hex of plaintext bytes>", mode: "0600" }, ... ]
#   }
#   .enc bytes = AES-256-GCM ciphertext followed by the 16-byte tag.
#   key = PBKDF2-SHA256(passphrase, salt, iterations, 32 bytes).
#   AAD = UTF-8 bytes of "botcorp-bundle:<bot>".
#   plaintext = UTF-8 JSON { vault: { "<key>": "<value>" }, files: { "<relpath>" | "~/<relpath>": "<base64>" } }
#
# scope bot (the default when absent) = relative to the bot's folder; scope
# home = relative to the operator's USERPROFILE, keyed "~/<relpath>" in the
# plaintext, restored only with an explicit -AllowHome and never into a bot
# folder, a Claude config home, the BotCorp runtime home or .vault (the
# importer in secrets.ps1 enforces the target policy; the relpath rules here
# are the first line).
#
# The plaintext (and the passphrase) must never be printed, logged, or put on
# a command line - the same discipline as vault.ps1.

Set-StrictMode -Off
$ErrorActionPreference = 'Stop'

$script:BundleKdfIterations = 600000

function Get-Sha256Hex {
    param([byte[]]$Bytes)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $h = $sha.ComputeHash($Bytes) } finally { $sha.Dispose() }
    return (($h | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Test-BundleRelPath {
    # A bundle relpath must be relative, forward-slashed, no .. segment, not
    # absolute, and not reach into .vault/ or a .claude-* config home.
    param([string]$Path)
    if (-not $Path) { return $false }
    if ($Path -match '\\') { return $false }
    if ($Path -match '^[A-Za-z]:') { return $false }
    if ($Path.StartsWith('/')) { return $false }
    if ($Path -split '/' | Where-Object { $_ -eq '..' }) { return $false }
    if ($Path.StartsWith('.vault/')) { return $false }
    if ($Path.StartsWith('.claude-')) { return $false }
    return $true
}

function Test-BundleHomeRelPath {
    # A home-scoped relpath: everything Test-BundleRelPath asks, and never a
    # Claude config home (.claude, .claude-*), the runtime home (.botcorp) or a
    # .vault under the profile.
    param([string]$Path)
    if (-not (Test-BundleRelPath $Path)) { return $false }
    if ($Path -match '^\.claude(/|-|$)') { return $false }
    if ($Path -match '^\.botcorp(/|$)') { return $false }
    if ($Path -match '(^|/)\.vault(/|$)') { return $false }
    return $true
}

function Split-BundleFileKey {
    # "~/x" -> @{ scope = home; path = x }; "x" -> @{ scope = bot; path = x }
    param([string]$Key)
    if ($Key.StartsWith('~/')) { return @{ scope = 'home'; path = $Key.Substring(2) } }
    return @{ scope = 'bot'; path = $Key }
}

function Test-BundleFileKey { param([string]$Key)
    $s = Split-BundleFileKey $Key
    if ($s.scope -eq 'home') { return (Test-BundleHomeRelPath $s.path) }
    return (Test-BundleRelPath $s.path)
}

function New-SecretsBundle {
    param(
        [Parameter(Mandatory)][string]$Bot,
        [Parameter(Mandatory)][string]$Passphrase,
        [hashtable]$Vault = @{},
        [hashtable]$Files = @{},
        [Parameter(Mandatory)][string]$OutDir
    )
    if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }

    $vaultKeys = @($Vault.Keys | Sort-Object)
    $filesPayload = [ordered]@{}
    $filesManifest = @()
    foreach ($fileKey in ($Files.Keys | Sort-Object)) {
        if (-not (Test-BundleFileKey $fileKey)) { throw "bundle: bad relpath '$fileKey'" }
        $s = Split-BundleFileKey $fileKey
        $bytes = [byte[]]$Files[$fileKey]
        $filesPayload[$fileKey] = [Convert]::ToBase64String($bytes)
        $filesManifest += [ordered]@{ path = $s.path; scope = $s.scope; sha256 = (Get-Sha256Hex $bytes); mode = '0600' }
    }

    $vaultPayload = [ordered]@{}
    foreach ($k in $vaultKeys) { $vaultPayload[$k] = $Vault[$k] }

    $plaintextObj = [ordered]@{ vault = $vaultPayload; files = $filesPayload }
    $plaintext = [System.Text.Encoding]::UTF8.GetBytes(($plaintextObj | ConvertTo-Json -Depth 8 -Compress))

    $salt = [byte[]]::new(16); [System.Security.Cryptography.RandomNumberGenerator]::Fill($salt)
    $nonce = [byte[]]::new(12); [System.Security.Cryptography.RandomNumberGenerator]::Fill($nonce)
    $key = [System.Security.Cryptography.Rfc2898DeriveBytes]::Pbkdf2(
        [System.Text.Encoding]::UTF8.GetBytes($Passphrase), $salt, $script:BundleKdfIterations,
        [System.Security.Cryptography.HashAlgorithmName]::SHA256, 32)
    $aad = [System.Text.Encoding]::UTF8.GetBytes("botcorp-bundle:$Bot")

    $cipher = [byte[]]::new($plaintext.Length)
    $tag = [byte[]]::new(16)
    $aes = [System.Security.Cryptography.AesGcm]::new($key, 16)
    try { $aes.Encrypt($nonce, $plaintext, $cipher, $tag, $aad) } finally { $aes.Dispose() }
    $encBytes = $cipher + $tag

    $bundlePath = Join-Path $OutDir 'secrets.bundle.enc'
    [System.IO.File]::WriteAllBytes($bundlePath, $encBytes)

    $manifest = [ordered]@{
        schema     = 1
        bot        = $Bot
        created_at = (Get-Date).ToUniversalTime().ToString('o')
        cipher     = 'aes-256-gcm'
        kdf        = [ordered]@{ name = 'pbkdf2-sha256'; iterations = $script:BundleKdfIterations; salt = [Convert]::ToBase64String($salt) }
        nonce      = [Convert]::ToBase64String($nonce)
        bundle     = 'secrets.bundle.enc'
        sha256     = (Get-Sha256Hex $encBytes)
        vault_keys = @($vaultKeys)
        files      = @($filesManifest)
    }
    $manifestPath = Join-Path $OutDir 'secrets.manifest.json'
    [System.IO.File]::WriteAllText($manifestPath, (($manifest | ConvertTo-Json -Depth 6) + "`n"))

    return $manifest
}

function Import-SecretsBundle {
    param(
        [Parameter(Mandatory)][string]$Bot,
        [Parameter(Mandatory)][string]$Passphrase,
        [Parameter(Mandatory)][string]$Manifest,
        [Parameter(Mandatory)][string]$Bundle
    )
    if (-not (Test-Path $Manifest)) { throw "bundle: manifest not found at $Manifest" }
    if (-not (Test-Path $Bundle)) { throw "bundle: bundle not found at $Bundle" }

    $raw = [System.IO.File]::ReadAllText($Manifest)
    $m = $raw | ConvertFrom-Json

    if (-not ($m.PSObject.Properties.Name -contains 'schema') -or [int]$m.schema -ne 1) { throw 'bundle: unsupported manifest schema' }
    if ("$($m.bot)" -ne $Bot) { throw "bundle: bundle is for bot $($m.bot)" }

    # A hash mismatch and a failed decrypt both mean the same thing to the
    # importer - "this bundle does not verify" - so both use the identical
    # message (avoids giving a tamper/passphrase oracle via different text).
    $encBytes = [System.IO.File]::ReadAllBytes($Bundle)
    $actualSha = Get-Sha256Hex $encBytes
    if ($actualSha -ne "$($m.sha256)") { throw 'bundle: wrong passphrase or tampered bundle' }

    if ($encBytes.Length -lt 16) { throw 'bundle: bundle file too short (missing tag)' }
    $tagLen = 16
    $cipher = $encBytes[0..($encBytes.Length - $tagLen - 1)]
    $tag = $encBytes[($encBytes.Length - $tagLen)..($encBytes.Length - 1)]

    $salt = [Convert]::FromBase64String("$($m.kdf.salt)")
    $iterations = [int]$m.kdf.iterations
    $nonce = [Convert]::FromBase64String("$($m.nonce)")
    $key = [System.Security.Cryptography.Rfc2898DeriveBytes]::Pbkdf2(
        [System.Text.Encoding]::UTF8.GetBytes($Passphrase), $salt, $iterations,
        [System.Security.Cryptography.HashAlgorithmName]::SHA256, 32)
    $aad = [System.Text.Encoding]::UTF8.GetBytes("botcorp-bundle:$Bot")

    $plain = [byte[]]::new($cipher.Length)
    $aes = [System.Security.Cryptography.AesGcm]::new($key, 16)
    try {
        try { $aes.Decrypt($nonce, $cipher, $tag, $plain, $aad) }
        catch { throw 'bundle: wrong passphrase or tampered bundle' }
    } finally { $aes.Dispose() }

    $plaintextObj = ([System.Text.Encoding]::UTF8.GetString($plain)) | ConvertFrom-Json

    $plaintextVaultKeys = @()
    if ($plaintextObj.vault) { $plaintextVaultKeys = @($plaintextObj.vault.PSObject.Properties.Name) }
    $manifestVaultKeys = @($m.vault_keys)
    $missingFromPlain = @($manifestVaultKeys | Where-Object { $plaintextVaultKeys -notcontains $_ })
    $extraInPlain = @($plaintextVaultKeys | Where-Object { $manifestVaultKeys -notcontains $_ })
    if ($missingFromPlain -or $extraInPlain) { throw 'bundle: vault_keys do not match the decrypted payload' }
    foreach ($k in $manifestVaultKeys) { if ("$k" -notmatch '^[a-z][a-z0-9_]{0,63}$') { throw "bundle: bad vault key name '$k'" } }

    $vaultOut = @{}
    foreach ($p in $plaintextObj.vault.PSObject.Properties) { $vaultOut[$p.Name] = "$($p.Value)" }

    # Every manifest entry (scope bot unless it says home) must have exactly one
    # plaintext file under its key ("~/<path>" for home), and every path must
    # pass the relpath rules for its scope - all checked BEFORE any byte is
    # handed back.
    $manifestFiles = @($m.files)
    $plaintextFileKeys = @()
    if ($plaintextObj.files) { $plaintextFileKeys = @($plaintextObj.files.PSObject.Properties.Name) }
    $entries = @()
    foreach ($fm in $manifestFiles) {
        $relpath = "$($fm.path)"
        $scope = 'bot'
        try { if (($fm.PSObject.Properties.Name -contains 'scope') -and $fm.scope) { $scope = "$($fm.scope)".ToLowerInvariant() } } catch {}
        if ($scope -notin @('bot', 'home')) { throw "bundle: unknown scope '$scope' for file '$relpath'" }
        $ok = if ($scope -eq 'home') { Test-BundleHomeRelPath $relpath } else { Test-BundleRelPath $relpath }
        if (-not $ok) { throw "bundle: refusing unsafe file path '$relpath' (scope $scope)" }
        $entries += @{ key = $(if ($scope -eq 'home') { "~/$relpath" } else { $relpath }); path = $relpath; scope = $scope; sha256 = "$($fm.sha256)" }
    }
    $manifestFileKeys = @($entries | ForEach-Object { $_.key })
    $missingFilesFromPlain = @($manifestFileKeys | Where-Object { $plaintextFileKeys -notcontains $_ })
    $extraFilesInPlain = @($plaintextFileKeys | Where-Object { $manifestFileKeys -notcontains $_ })
    if ($missingFilesFromPlain -or $extraFilesInPlain) { throw 'bundle: files do not match the decrypted payload' }

    $filesOut = @{}
    foreach ($e in $entries) {
        $b64 = "$($plaintextObj.files.($e.key))"
        $bytes = [Convert]::FromBase64String($b64)
        $actualFileSha = Get-Sha256Hex $bytes
        if ($actualFileSha -ne $e.sha256) { throw "bundle: sha256 mismatch for file '$($e.path)'" }
        $filesOut[$e.key] = @{ path = $e.path; scope = $e.scope; bytes = $bytes }
    }

    return @{ vault = $vaultOut; files = $filesOut }
}
