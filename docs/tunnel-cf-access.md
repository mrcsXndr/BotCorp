# Remote access: Cloudflare Tunnel + Cloudflare Access

Reach the cockpit from anywhere (your phone, another laptop) without opening
a port, exposing your IP, or running a VPN. Two layers:

```
your browser ──HTTPS──▶ Cloudflare Access (identity gate: your email OTP / SSO)
                        │  only identities on YOUR policy get past this
                        ▼
                  Cloudflare edge ──▶ cloudflared tunnel ──▶ 127.0.0.1:4477 cockpit
                                                              (loopback-only, still
                                                               verifies every JWT)
```

The cockpit never binds to a public interface. `cloudflared` makes an
**outbound** connection to Cloudflare; nothing inbound is opened on your
machine. Cloudflare Access authenticates every request at the edge, so the
cockpit is reachable only by identities you allow.

## This is forced, not optional (there is no flag to skip it)

The cockpit binds `127.0.0.1` by default and refuses to bind anything else,
or accept a tunnel connector, unless `<BOTCORP_HOME>/access.json` exists with
a `team` and an `aud`:

```json
{ "team": "<team slug>", "aud": "<application AUD tag>", "frame_ancestors": "https://hub.example.com" }
```

With that file present, **every** request — HTTP and WebSocket alike — must
carry a `Cf-Access-Jwt-Assertion` that verifies against
`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` (signature, `iss`,
the configured `aud`, `exp`); anything else is a 401 with no session cookie.
`scripts/tunnel-up.ps1` reads the same file and refuses to run at all without
it — before it even resolves `cloudflared`. `botcorp doctor` independently
fails whenever the cockpit answers on a non-loopback address without Access
configured, or when a request without a JWT gets anything other than 401 on
such a listener. **There is no env var, flag, or setting that turns any of
this off.** A LAN-only operator uses loopback plus SSH/RDP instead of
exposing the cockpit at all — see the cockpit's own auth-model doc
(`docs/cockpit.md`) for the full request-by-request behaviour.

## ⚠️ Read first — this is a remote-control surface

The cockpit streams live terminals into Claude Code sessions. Publishing it
means giving remote shell-level control of every bot on this machine. Treat
it like SSH:

- **Lock the Cloudflare Access policy to your identity only** (your specific
  email), not a broad rule. This is the real gate — the JWT verification
  above only checks that a request came through an Access application that
  issued it; the *policy* on that application is what decides who gets one.
- The cockpit's per-boot session cookie is a second layer of defence, bound
  to the JWT's `email` claim — a cookie minted for one identity is rejected
  under another identity's JWT.
- Don't put the tunnel hostname anywhere public. There's no reason anyone
  else should know it exists.
- Optionally add a Cloudflare Access service token, or require WARP, as an
  extra factor.

## One-time setup (Cloudflare side)

Needs a Cloudflare account with a zone you control (e.g. `example.com`).
Two equivalent routes — pick one:

### Option A — remotely-managed tunnel (recommended, no local cert)

Create everything in the dashboard (Zero Trust → Networks → Tunnels →
Create):

1. **Tunnel:** name it `botcorp`, pick *cloudflared*, and copy the **run
   token** it shows you. Save it (one line) to `<BOTCORP_HOME>/tunnel.token`
   (default `~/.botcorp/tunnel.token`).
2. **Public hostname:** `botcorp.example.com` → service
   `http://127.0.0.1:4477` (this also creates the DNS CNAME). The ingress
   lives on the Cloudflare side, so config changes never touch this machine.

(Everything above is also plain Cloudflare API — tunnel `POST
/accounts/{id}/cfd_tunnel` with `config_src: cloudflare`, ingress `PUT
.../configurations`, CNAME to `<tunnel-id>.cfargotunnel.com`, token `GET
.../token` — if you'd rather script it than click it.)

### Option B — cert-based (classic cloudflared CLI)

```powershell
# 1. Authenticate cloudflared to your Cloudflare account (opens a browser).
cloudflared tunnel login

# 2. Create a named tunnel (stores a credentials file under ~/.cloudflared).
cloudflared tunnel create botcorp

# 3. Point a hostname at it (creates the DNS CNAME for you).
cloudflared tunnel route dns botcorp botcorp.example.com
```

### Both options: the Access application + `access.json`

Create the application under Zero Trust → Access → Applications → Add (or
via `POST /accounts/{id}/access/apps` + a policy):

- **Type:** Self-hosted
- **Application domain:** `botcorp.example.com`
- **Policy:** Action *Allow*, rule *Emails* → *your@email* (only you).
- Session duration: short (e.g. 24h) so a stolen cookie expires.

Then run `botcorp cockpit expose --team <team slug> --aud <application AUD
tag> --yes` (Zero Trust → Access → Applications → your app → the AUD tag
shown at the top) to write `<BOTCORP_HOME>/access.json`. This is the optional
`integrations.access` module — the cockpit stays loopback-only until this
file exists. Once it does, forced-Access mode above turns on with no way to
disable it short of deleting the file; without it, `tunnel-up.ps1` and any
"expose" path simply refuse to run.

## Launch (every time you want it reachable)

```powershell
# Option A (token at <BOTCORP_HOME>/tunnel.token):
pwsh -File scripts\tunnel-up.ps1 -Hostname botcorp.example.com

# Option B (cert-based named tunnel):
pwsh -File scripts\tunnel-up.ps1 -Hostname botcorp.example.com -Tunnel botcorp
```

`tunnel-up.ps1`, in order: refuses without a valid `access.json`; refuses if
the cockpit's port is already held by something else (it prints who owns it
and exits — it never kills another process's listener); (re)launches the
cockpit with the tunnel host allow-listed
(`COCKPIT_ALLOWED_HOSTS`, which also flips the session cookie to `Secure`);
starts `cloudflared`; polls `https://botcorp.example.com/healthz` for a 200.

It then prints the one check it cannot perform itself: open
`https://botcorp.example.com/api/access/selftest` in a browser and confirm
`{"verified":true,"email":...}`. A verified `Cf-Access-Jwt-Assertion` is only
ever injected by the Cloudflare edge — a script running on this box has no
way to present one to itself, so this last step is either a manual browser
check or `botcorp doctor`, which performs it off-box on your behalf as part
of its regular checks.

## Always-on (optional)

To keep it up across reboots, install cloudflared as a service (it reads the
tunnel's config) and let the BotCorp daemon keep the cockpit alive:

```powershell
cloudflared service install          # runs the tunnel as a Windows service
```

Keep `COCKPIT_ALLOWED_HOSTS=botcorp.example.com` set as a user environment
variable so a daemon-started cockpit also accepts the tunnel host, and keep
`access.json` in place — removing it does not open anything up; it simply
makes every future non-loopback bind refuse to start until it's restored.

## Why the cockpit accepts the tunnel host

Its control-plane lockdown (host allowlist + origin check + the Access JWT
check on all HTTP + WebSocket traffic) rejects any Host/Origin it doesn't
know — that's what stops DNS rebinding and CSRF, loopback or not.
`COCKPIT_ALLOWED_HOSTS` adds your tunnel hostname to that allowlist (host +
`https://` origin), so Cloudflare-edge traffic is accepted while everything
else is still refused. See `docs/cockpit.md` for the full auth model.
