# tunnel-up.ps1 - expose the cockpit through a Cloudflare tunnel, gated on Access.
#
# Forced Access (docs/tunnel-cf-access.md): refuses to run unless
# <BOTCORP_HOME>/access.json exists with `team` + `aud`. There is no flag or
# env var that disables this — a LAN-only operator uses loopback + SSH/RDP
# instead of exposing the cockpit at all.
#
# Prereq (ONE-TIME, Cloudflare side — see docs/tunnel-cf-access.md). Two ways:
#   A) API-provisioned (remotely-managed) tunnel: a run-token saved at
#      <BOTCORP_HOME>/tunnel.token and ingress configured in the CF dashboard:
#          pwsh -File scripts\tunnel-up.ps1 -Hostname botcorp.example.com
#   B) cert-based (cloudflared tunnel login/create/route): pass the names:
#          pwsh -File scripts\tunnel-up.ps1 -Hostname botcorp.example.com -Tunnel botcorp
#
# What this script does, in order:
#   1. refuses without a valid-looking access.json (team + aud present) — M5/H1/H2
#   2. refuses if -Port is already bound by something else: prints who owns it
#      and exits 1 — it NEVER kills another process's listener
#   3. (re)launches the cockpit bound to loopback with the tunnel host
#      allow-listed (COCKPIT_ALLOWED_HOSTS), which also flips its session
#      cookie to Secure
#   4. starts cloudflared (background), then polls https://<hostname>/healthz
#      for a 200
#   5. prints the one check this script CANNOT do for you: a verified Cf-
#      Access-Jwt-Assertion is only ever injected by the Access edge itself,
#      never by a script on this box, so open the printed selftest URL in a
#      browser (or run `botcorp doctor`, which does this off-box check for you)

param(
    [Parameter(Mandatory)][string]$Hostname,
    [string]$Tunnel = '',
    [int]$Port = 4477
)

$ErrorActionPreference = 'Stop'
$repo    = Split-Path $PSScriptRoot -Parent
$rtHome  = if ($env:BOTCORP_HOME) { $env:BOTCORP_HOME } else { Join-Path $env:USERPROFILE '.botcorp' }
$accessFile = Join-Path $rtHome 'access.json'
$tokenFile  = Join-Path $rtHome 'tunnel.token'

# --- 1. forced Access: no flag disables this ---------------------------------
if (-not (Test-Path $accessFile)) {
    Write-Host "Access required: no $accessFile. Set integrations.access {team, aud} and write it there before exposing the cockpit off-box. See docs/tunnel-cf-access.md. There is no flag to skip this." -ForegroundColor Red
    exit 1
}
try { $access = Get-Content $accessFile -Raw | ConvertFrom-Json } catch {
    Write-Host "Access required: $accessFile is not valid JSON." -ForegroundColor Red
    exit 1
}
if (-not $access.team -or -not $access.aud) {
    Write-Host "Access required: $accessFile is missing 'team' and/or 'aud'. See docs/tunnel-cf-access.md." -ForegroundColor Red
    exit 1
}

function Resolve-Node {
    $n = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
    if (-not $n) { foreach ($c in @("$env:ProgramFiles\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe")) { if (Test-Path $c) { $n = $c; break } } }
    return $n
}
function Resolve-Cloudflared {
    $c = (Get-Command cloudflared.exe -ErrorAction SilentlyContinue).Source
    if (-not $c) { foreach ($p in @("$env:USERPROFILE\.local\bin\cloudflared.exe", "$env:ProgramFiles\cloudflared\cloudflared.exe")) { if (Test-Path $p) { $c = $p; break } } }
    return $c
}

$node = Resolve-Node
$cf   = Resolve-Cloudflared
if (-not $node) { Write-Host 'Node.js not found - run the installer first.' -ForegroundColor Red; exit 1 }
if (-not $cf)   { Write-Host 'cloudflared not found - install it (winget install Cloudflare.cloudflared).' -ForegroundColor Red; exit 1 }
if (-not $Tunnel -and -not (Test-Path $tokenFile)) {
    Write-Host "No run-token at $tokenFile and no -Tunnel name given." -ForegroundColor Red
    Write-Host 'Do the one-time setup in docs/tunnel-cf-access.md first.' -ForegroundColor Red
    exit 1
}

# --- 2. refuse a busy port; never kill it (M5) -------------------------------
$existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
    $ownerProcId = ($existing | Select-Object -First 1 -ExpandProperty OwningProcess)
    $ownerProc = Get-Process -Id $ownerProcId -ErrorAction SilentlyContinue
    $ownerName = if ($ownerProc) { "$($ownerProc.ProcessName) (pid $ownerProcId)" } else { "pid $ownerProcId" }
    Write-Host "Port $Port is already in use by $ownerName. Refusing to touch it - stop it yourself if it's stale, or pass a different -Port." -ForegroundColor Red
    exit 1
}

# --- 3. (re)launch the cockpit with the tunnel host allow-listed -------------
New-Item -ItemType Directory -Force -Path $rtHome | Out-Null
$log = Join-Path $rtHome 'cockpit.log'
$env:COCKPIT_ALLOWED_HOSTS = $Hostname
Write-Host "Starting cockpit (127.0.0.1:$Port, allow-listing $Hostname)..." -ForegroundColor Cyan
Start-Process -FilePath $node -ArgumentList "$repo\cockpit\server.mjs" `
    -WorkingDirectory $repo -WindowStyle Hidden `
    -RedirectStandardOutput $log -RedirectStandardError "$log.err"

$cockpitUp = $false
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    try { if ((Invoke-WebRequest "http://127.0.0.1:$Port/healthz" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200) { $cockpitUp = $true; break } } catch {}
}
if (-not $cockpitUp) { Write-Host "Cockpit did not come up on 127.0.0.1:$Port - see $log / $log.err" -ForegroundColor Red; exit 1 }
Write-Host 'Cockpit up.' -ForegroundColor Green

# --- 4. start cloudflared (background), then poll the public healthz --------
$cfLog = Join-Path $rtHome 'cloudflared.log'
if (-not $Tunnel) {
    Write-Host "Bringing up tunnel via run-token -> https://$Hostname ..." -ForegroundColor Cyan
    Start-Process -FilePath $cf -ArgumentList @('tunnel', 'run', '--token', (Get-Content $tokenFile -Raw).Trim()) `
        -WindowStyle Hidden -RedirectStandardOutput $cfLog -RedirectStandardError $cfLog
} else {
    Write-Host "Bringing up tunnel '$Tunnel' -> https://$Hostname ..." -ForegroundColor Cyan
    Start-Process -FilePath $cf -ArgumentList @('tunnel', 'run', '--url', "http://127.0.0.1:$Port", $Tunnel) `
        -WindowStyle Hidden -RedirectStandardOutput $cfLog -RedirectStandardError $cfLog
}

$edgeUp = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    try { if ((Invoke-WebRequest "https://$Hostname/healthz" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200) { $edgeUp = $true; break } } catch {}
}
if ($edgeUp) { Write-Host "Edge reachable: https://$Hostname/healthz -> 200" -ForegroundColor Green }
else { Write-Host "https://$Hostname/healthz did not answer 200 within 30s - check DNS and $cfLog" -ForegroundColor Yellow }

# --- 5. the one check this script cannot do for you --------------------------
Write-Host ''
Write-Host 'Verify at this URL in a browser (a verified Access JWT is only ever' -ForegroundColor Yellow
Write-Host 'injected by the Cloudflare edge itself, never by a script on this box):' -ForegroundColor Yellow
Write-Host "  https://$Hostname/api/access/selftest" -ForegroundColor Yellow
Write-Host '  It must show {"verified":true,"email":...}.' -ForegroundColor Yellow
Write-Host '  `botcorp doctor` performs this off-box check for you.' -ForegroundColor Yellow
Write-Host ''
Write-Host 'cloudflared and the cockpit are running in the background; logs are under' -ForegroundColor DarkGray
Write-Host "  $rtHome" -ForegroundColor DarkGray
