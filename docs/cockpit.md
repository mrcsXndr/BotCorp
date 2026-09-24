# The cockpit

`cockpit/` is the browser ops surface for every bot on a machine: bot list,
live terminal, chat view of the same session, start / stop / restart, the
vault (masked), Telegram pairing (policy, allowlist, pending senders,
Approve/Deny), session history, automation run records, and a machine-wide
Releases panel for pending harness updates (Apply/Skip). It runs as one node
process (`npm run cockpit`, default `http://127.0.0.1:4477`) that the daemon
keeps alive through `/healthz`.

Two things it deliberately does NOT do:

- **It has no liveness authority and never spawns a pty.** Sessions live in
  `daemon/pty-host.mjs` (one process per bot); the cockpit attaches to them.
  Closing the page, restarting or updating the cockpit never touches a session.
- **It never changes state itself.** Every write goes through the CLI
  (`node cli/botcorp.mjs ...`), so the daemon, the operator's terminal and the
  cockpit share one implementation of each rule.

## Layout

| File | Role |
|---|---|
| `server.mjs` | HTTP API + static + WS `/term/<bot>`; the auth model below |
| `access.mjs` | Cloudflare Access JWT verification, identity-bound session cookie |
| `bots.mjs` | registry = `bots/*/bot.yaml` (js-yaml) merged with `<BOTCORP_HOME>/state/<bot>.json` (daemon) and `<bot>.pty.json` (pty-host) |
| `ptybridge.mjs` | browser socket <-> pty-host socket; pushes chat turns on the same socket |
| `cli.mjs` | `runCli(args, {stdin})`: `windowsHide`, 60 s timeout, output scrubbed of token shapes |
| `vault.mjs` | `secrets list <bot> --json` (masked) and `secrets set <bot> <key>` with the value on STDIN |
| `pairing.mjs` | policy/allowlist/pending state and approve/deny both go through the CLI (`pair <bot> --list --json`, `pair <bot> <senderId>`, `pair <bot> --deny <senderId>`) — the cockpit never reads `access.json` itself |
| `history.mjs` / `chat.mjs` | read-only over Claude Code transcripts (see the caveat below) |
| `engine.mjs` | `GET /api/engine/version`: `botcorp.json` version + `git rev-parse --short HEAD` (`server.mjs` adds `exposure: loopback\|access`) |
| `updates.mjs` | reads `<BOTCORP_HOME>/state/updates.json` for the Releases panel; Apply/Skip go through the CLI (`update --apply\|--skip <tag>`) |
| `public/` | the page: vanilla JS + xterm.js, no build step, no external requests |

Machine runtime lives under `BOTCORP_HOME` (default `~/.botcorp`): `state/`,
`logs/`, `access.json`. Bots live under `<BotCorp>/bots/<name>/` (= `BOT_HOME`),
config home `bots/<name>/.claude-<name>/`, vault `bots/<name>/.vault/`.

## Auth model

There are exactly two modes and nothing switches either off. Exposure is the
optional `integrations.access` module — loopback stays the default until you
run `botcorp cockpit expose --team <team> --aud <aud> --yes`, which writes
`access.json` below. `GET /api/engine/version` reports which mode is active
as `exposure: "loopback"` or `"access"`, so the cockpit header can show it.

**Loopback (default).** Bind `127.0.0.1`. Host allowlist (`127.0.0.1:<port>`,
`localhost:<port>`, `[::1]:<port>`) kills DNS rebinding; an `Origin` header,
when present, must be one of ours; a per-boot session cookie (`HttpOnly`,
`SameSite=Strict`) is minted on page loads and required on every `/api` call
and WS upgrade. Threat model: another process or web page on the same box.

**Cloudflare Access (forced for anything else).** Present
`<BOTCORP_HOME>/access.json`:

```json
{ "team": "<team slug>", "aud": "<application AUD tag>", "frame_ancestors": "https://hub.example.com" }
```

Then:

- A non-loopback bind (`--bind` / `COCKPIT_HOST`) without this file refuses to
  start: exit code 2, `Access required: set integrations.access {team, aud} in
  the machine config`.
- With the file present, EVERY request, HTTP and WS upgrade alike, must carry
  `Cf-Access-Jwt-Assertion`. It is verified RS256 against
  `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` (JWKS cached 1 h,
  refetched once on an unknown `kid`), `iss` must equal
  `https://<team>.cloudflareaccess.com`, `aud` must contain the configured tag,
  `exp` must be in the future, `email` must be present. Any failure is a 401
  with no `Set-Cookie`.
- The session cookie is minted only from a verified JWT and bound to its
  `email`: `sha256(email)[:32] . HMAC(secret, email)`. On every request the
  cookie is recomputed from the CURRENT JWT's email and compared in constant
  time, so a cookie for one identity is rejected under another identity's JWT.
  `Secure` is always set in this mode.
- `Content-Security-Policy: frame-ancestors <frame_ancestors or 'none'>` on
  every response (instead of `X-Frame-Options`), so a hub may embed the page
  only when the config says so.
- `/healthz` is the only unauthenticated route and answers `{"ok":true}` only.
- `GET /api/access/selftest` returns `{verified: true, email, access}` for the
  identity of the calling request. `tunnel-up` and `doctor` call it THROUGH the
  Access edge to prove the edge injects a JWT this cockpit accepts.

There is no env var, flag or setting that disables Access on a non-loopback
listener; `grep -rnE "ACCESS_DISABLE|allowInsecure|--no-access|INSECURE"
cockpit daemon/pty-host.mjs` is 0 by construction and CI keeps it so. A
LAN-only operator uses loopback plus SSH/RDP.

Caps: `express.json` 8 MB (413 above), paste files 8 MB decoded and 10 per
minute per session, WS input frames 1 MB (dropped with `{t:'err'}`, both in the
cockpit and in the pty-host).

### The vault ceiling

`GET /api/bots/:name/secrets` returns masked entries and `PUT
/api/bots/:name/secrets/:key` pipes the value to the CLI on stdin; the cockpit
never opens `.vault/secrets.json` and cannot return a value. "Encrypted at
rest" covers that vault (DPAPI, current user). Whatever Claude Code writes
under the bot's own config home stays under Claude Code's control:
`.credentials.json` (only after an interactive `/login`, e.g. for Remote
Control) and, if the env-only token path is ever unavailable,
`channels/telegram/.env`. Both are ACL-restricted to the user and gitignored;
neither is encrypted by BotCorp.

## pty-host contract (`daemon/pty-host.mjs`)

```
node daemon/pty-host.mjs --bot <name> --botcorp <BotCorp root> [--continue|--fresh]
node daemon/pty-host.mjs --stop <name>
```

- Spawns `pwsh -NoProfile -ExecutionPolicy Bypass -File <root>/daemon/launch.ps1
  -Bot <name> -Continue|-Fresh -InPty` in a ConPTY with cwd = `BOT_HOME` and
  env `BOT_NAME`, `BOT_HOME`, `BOTCORP_HOME`, `BOTCORP_ROOT`. `launch.ps1` does
  vault -> env and runs `claude`; nothing is typed into the shell. `pwsh` is
  resolved to a real exe path (never the WindowsApps alias).
- Writes `<BOTCORP_HOME>/state/<bot>.pty.json` `{pid, ptyPid, port, token,
  startedAt, mode}` and ACLs it to the current user (`icacls /inheritance:r
  /grant:r`). `pid` is the host, `ptyPid` the shell (root of the tree).
- Listens on `ws://127.0.0.1:<ephemeral>/?token=<per-boot random>`. Frames:
  host -> client `{t:'hello', pid, ptyPid, startedAt, mode}`, `{t:'o', d}`
  (scrollback replay first, then live), `{t:'exit', code}`, `{t:'err', m}`;
  client -> host `{t:'i', d}` (1 MB cap), `{t:'r', cols, rows}`.
- Scrollback ring: 200 000 chars, trimmed on a `\n` boundary so the first
  replayed frame never starts inside an escape sequence.
- On pty exit: broadcasts `exit`, deletes `pty.json`, exits after 2 s.
- `--stop`: `taskkill /T /F /PID <ptyPid>` (the whole tree: shell, claude, the
  Telegram poller), waits for the host to finish, forces it if needed, removes
  `pty.json`. Idempotent. Exit 3 if a live host already owns the bot.
- A stale `pty.json` whose `pid` is dead reads as "not running" everywhere.

The daemon spawns the host detached (breakaway from its own job object) and
restarts a dead one with `--continue`.

### Attach mode (background sessions)

A bot's `harness.service` (`bot.yaml`, default `bg`) runs it as a background
Claude Code session rather than one the pty-host owns outright. When
`GET /api/bots/:name` reports `service: "bg"` and a `bg_id` in the daemon's
own `state/<bot>.json`, the cockpit reads both defensively (either can be
absent on an older or mid-migration bot) and changes only two things: the
header reads "background session `<bg_id>` (attach)" instead of "running ·
pid …", and the Start button reads "Attach". The `/term/<bot>` WebSocket and
the pty-host frame protocol above are unchanged either way — the cockpit
never spawns a session itself, attached or not.

## What the cockpit calls

| UI action | Call |
|---|---|
| Start / Stop / Restart / Restart fresh | `node cli/botcorp.mjs start|stop|restart <bot> [--fresh]` |
| Vault list / set | `secrets list <bot> --json` / `secrets set <bot> <key>` (value on stdin) |
| Pairing state | `pair <bot> --list --json` -> `{policy, allowFrom, pending:[{code, senderId, chatId, age_s, expires_in_s}]}` |
| Approve / deny a Telegram sender | `pair <bot> <senderId>` / `pair <bot> --deny <senderId>` (CLI writes `allowFrom`, `approved/<senderId>` or the deny record, `bot.yaml`) — never from a chat message, only here or in the terminal |
| Releases panel | `GET /api/updates` reads `<BOTCORP_HOME>/state/updates.json`; Apply/Skip = `update --apply <tag>` / `update --skip <tag>` |
| Runs drawer | reads `<BOTCORP_HOME>/state/<bot>/runs.jsonl` tail (read-only) |
| New chat: account list | `GET /api/accounts` -> `accounts list --json` |
| New chat: recent folders | `GET /api/chat/recent` reads `<BOTCORP_HOME>/state/chat-recent.json` |
| New chat: launch | `POST /api/chat/launch {account, generic, cwd}` -> `chat --account <id> --generic` or `chat --account <id> --cwd <path>` |
| Version | `botcorp.json` + `git rev-parse --short HEAD` + `exposure: loopback\|access` |

CLI results come back as `{ok, code, out, err}`; `out`/`err` are truncated to
4 KB and scrubbed of token shapes before they reach the browser.

## The page

- Chat and Terminal are two views of ONE socket (`/term/<bot>`). The server
  bridges it to the pty-host and pushes `{t:'chat', ...}` turns on it (tailed
  from the transcript by byte cursor every 1.5 s), so the client polls nothing
  per bot; only the bot list is a single 5 s poll.
- Reconnect with backoff (1 s doubling to 15 s) whenever the socket drops
  while the bot stays selected. A pty exit shows "Session exited with code N.
  Restart it?" with a Restart button.
- Key row: Esc, Ctrl+C, Ctrl+L, Mode, Tab, Enter, arrows, +file. The Mode key
  sends `\x1b[Z` (Shift+Tab); `MODE_KEY_SEQ` at the top of `app.js` is the one
  constant to flip to `\x1bm` (Alt+M) if ConPTY does not deliver Shift+Tab.
- Multi-line text (chat box, or a terminal paste containing a newline) is
  sent as ONE bracketed paste (`\x1b[200~ ... \x1b[201~`), then `\r`.
- Image / file paste, drop, or +file: `POST /api/bots/:name/paste` stores it at
  `%TEMP%/botcorp-paste/<bot>/paste-<ms>.<ext>`; the client types
  `@<forward-slash path> ` with no Enter.
- Remote Control: "Enable Remote Control" types `/login`, "Start Remote
  Control" types `/remote-control`; the link the TUI prints is surfaced in a
  bar with an Open button (login and claude.ai/code URLs).
- Phone: `maximum-scale=1`, chat input `inputmode=text autocapitalize=off`,
  bot list becomes a top strip under 700 px, chat is the default view. Copy on
  select is a setting (off by default) because it fights long-press selection.

### New chat

The side-foot "new chat" link opens a modal: an account `<select>` (label +
masked, populated from `GET /api/accounts`, disabled with "no accounts:
botcorp accounts add <id>" when none exist), a Generic / Codebase radio, and
for Codebase a `<select>` of recent workspaces (`GET /api/chat/recent`) plus a
text field to type a folder path instead. Launch posts to
`/api/chat/launch` and shows the CLI's `out`/`err` in the modal. The tab
itself opens on the HOST machine's own desktop, not in the browser — over an
Access-exposed cockpit the operator only ever sees the CLI's launch outcome
here, never the interactive session.

### Transcript caveat

`chat.mjs` and `history.mjs` read Claude Code's session transcripts
(`<config home>/projects/<slug>/<session>.jsonl`, slug = the absolute cwd with
every non-alphanumeric character replaced by `-`). That format is internal to
Claude Code and may change between versions. Both modules are best-effort:
every entry point is wrapped, a failure degrades to "chat view unavailable" in
the page, and nothing in the daemon or the CLI depends on them.

## Test seams

| Seam | Effect | Why it is not a bypass |
|---|---|---|
| `COCKPIT_ACCESS_JWKS_FILE=<path>` | the verifier reads the JWKS from a file instead of fetching it | signature, `iss`, `aud`, `exp` and the cookie binding still run in full; tests sign with a throwaway RSA key |
| `BOTCORP_PTY_COMMAND=<command line>` | pty-host runs this line (via `cmd.exe /c`, or `sh -c`) instead of `launch.ps1` | launches only what is already on the box, touches no vault or auth; used to host a fake session for attach/replay/stop tests |
| `BOTCORP_HOME=<dir>` | relocate the machine runtime | the normal runtime knob; tests point it at a scratch dir |

Smoke sequence used in review: loopback `/healthz` 200, spoofed Host 403,
`/api` without cookie 403, 9 MB paste 413; `COCKPIT_HOST=0.0.0.0` without
`access.json` exit 2; with `access.json` + JWKS file: no JWT 401 (no
`Set-Cookie`), wrong `aud` 401, expired 401, tampered 401, valid 200 with a
`Secure` cookie, selftest `{verified:true,email}`, another identity's JWT with
that cookie 403; pty-host attach replays on a `\n` boundary, survives a cockpit
restart, `--stop` removes `pty.json` and the shell tree.
