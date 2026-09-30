# The cockpit

`cockpit/` is the browser ops surface for every bot on a machine: bot list,
live terminal, chat view of the same session, start / stop / restart, the
vault (masked), Telegram pairing (policy, allowlist, pending senders,
Approve/Deny), session history, automation run records, and a machine-wide
Releases panel for pending harness updates (Apply/Skip). It runs as one node
process (`npm run cockpit`, default `http://127.0.0.1:4477`) that the daemon
keeps alive through `/healthz`.

Two things it deliberately does NOT do:

- **It has no liveness authority and never spawns a pty.** A session is a
  Claude Code background session (`harness.session: bg`, the default) or lives
  in `daemon/pty-host.mjs` (`session: pty`, one process per bot); the cockpit
  attaches to either. Closing the page, restarting or updating the cockpit
  never touches a session.
- **It never changes a bot's state itself.** Every bot or config write goes
  through the CLI (`node cli/botcorp.mjs ...`), so the daemon, the operator's
  terminal and the cockpit share one implementation of each rule. The server
  writes only its own files: the audit log, attachments (in the bot's
  `.botcorp/uploads`, behind the approval token) and the approve-token file; it reads `updates.json` directly for the release list.

## Layout

| File | Role |
|---|---|
| `server.mjs` | HTTP API + static + WS `/term/<bot>`; the auth model below |
| `access.mjs` | Cloudflare Access JWT verification, identity-bound session cookie |
| `bots.mjs` | registry = `bots/*/bot.yaml` (js-yaml) merged with `<BOTCORP_HOME>/state/<bot>.json` (daemon) and `<bot>.pty.json` (pty-host) |
| `ptybridge.mjs` | browser socket <-> pty-host socket; pushes chat turns on the same socket |
| `cli.mjs` | `runCli(args, {stdin})`: `windowsHide`, 60 s timeout, output scrubbed of token shapes |
| `vault.mjs` | `secrets list <bot> --json` (masked) and `secrets set <bot> <key>` with the value on STDIN; lock state via `status <bot> --json` and unlock via `secrets unlock <bot>` with the passphrase on STDIN |
| `pairing.mjs` | policy/allowlist/pending state and approve/deny both go through the CLI (`pair <bot> --list --json`, `pair <bot> <senderId>`, `pair <bot> --deny <senderId>`) — the cockpit never reads `access.json` itself |
| `history.mjs` / `chat.mjs` | read-only over Claude Code transcripts (see the caveat below) |
| `engine.mjs` | `GET /api/engine/version`: `botcorp.json` version + `git rev-parse --short HEAD` (`server.mjs` adds `exposure: loopback\|access`) |
| `updates.mjs` | reads `<BOTCORP_HOME>/state/updates.json` for the Releases panel; Apply/Skip go through the CLI (`update --apply\|--skip <tag>`) |
| `web/` | the page: a React SPA (Vite, TypeScript); the built `web/dist` is committed and is all the server serves. The classic `public/` page and `/classic` were removed in v0.9.3 |

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
{ "team": "<team slug>", "aud": "<application AUD tag>", "frame_ancestors": "https://hub.example.com",
  "allowed_emails": ["ops@example.com"] }
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
  `exp` must be in the future, `email` must be present and, when
  `allowed_emails` is non-empty, listed there (case-insensitive; defence in
  depth against a loose Access policy; empty or absent admits any identity
  Access admits). Any failure is a 401 with no `Set-Cookie`.
- The session cookie is minted only from a verified JWT and bound to its
  `email`: `sha256(email)[:32] . HMAC(secret, email)`. On every request the
  cookie is recomputed from the CURRENT JWT's email and compared in constant
  time, so a cookie for one identity is rejected under another identity's JWT.
  `Secure` is always set in this mode.
- `Content-Security-Policy: default-src 'self'; script-src 'self'; object-src
  'none'; base-uri 'none'; connect-src 'self'; style-src 'self'
  'unsafe-inline'; frame-ancestors <frame_ancestors or 'none'>` on every
  response in both modes (instead of `X-Frame-Options`), so a hub may embed the
  page only when the config says so, and no inline script runs: the pages load
  every script from a file and carry no `on*` attributes.
- `/healthz` is the only unauthenticated route and answers `{"ok":true}` only.
- `GET /api/access/selftest` returns `{verified: true, email, access}` for the
  identity of the calling request. `tunnel-up` and `doctor` call it THROUGH the
  Access edge to prove the edge injects a JWT this cockpit accepts.

There is no env var, flag or setting that disables Access on a non-loopback
listener; `grep -rnE "ACCESS_DISABLE|allowInsecure|--no-access|INSECURE"
cockpit daemon/pty-host.mjs` is 0 by construction and CI keeps it so. A
LAN-only operator uses loopback plus SSH/RDP.

Audit: every `POST`/`PUT`/`PATCH`/`DELETE` under `/api` from an identified
caller (either mode) appends one line to
`<BOTCORP_HOME>/state/cockpit-audit.jsonl`: `{ts, identity, method, path,
bot, result}`, where `path` has no query string, `bot` is the `/api/bots/<name>`
segment or `null`, and `result` is the HTTP status (`aborted` if the client
hung up). Bodies are never recorded, so a vault value or a passphrase cannot
reach it. A chat send adds `inbox_id`, the id of the queued message, never its
text. Every `/term/<bot>` attach adds `{method: "WS", path: "/term/<bot>",
result: "attached"}` (or `result: 403` when refused, see below); keystrokes
are never recorded. A request refused before identification (a bad Host or
Origin, no valid JWT) is not logged.

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

### Operator lock

`GET /api/bots/:name/secrets/lock` returns the bot's vault lock state
(`{mode, version, locked, detail}`, read through `status <bot> --json` — the
cockpit never opens `key.json` itself). When `locked` is true the vault
drawer shows a passphrase field; submitting it posts `POST
/api/bots/:name/unlock` with body `{passphrase}`, piped straight to `secrets
unlock <bot>` on stdin — never logged, and surfaced only here or in the
terminal, never from a chat message. A successful unlock caches the vault
key until the next reboot; the drawer re-reads the lock state afterwards.
The route is operator-gated like every write, and five wrong passphrases in a
row lock it for 10 minutes (429, for every bot, until the cockpit restarts;
`botcorp secrets unlock` in the terminal is unaffected).
Behind Cloudflare Access whenever the cockpit is exposed, like every other
route. Full lock-mode mechanism: `docs/secrets.md`.

### Secret access log

The vault drawer also shows a read-only "Secret access" list: the last 100
rows of `<BOTCORP_HOME>/state/secret-access.jsonl`, the append-only record
`daemon/vault.ps1` writes on every decrypt (bot, key, reason, pid, ok, ts —
never a value), newest first, with its own Refresh button.
`GET /api/bots/:name/secrets/audit?limit=` reads it filtered to one bot;
`GET /api/secrets/audit?bot=&limit=` is the machine-wide equivalent (no
`withBot`, since audit history should outlive a deleted bot). Both go through
`vault.auditTail`, which reads the file directly (capped at 1000) — no CLI hop.

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

A bot's `harness.session` (`bot.yaml`, default `bg`) runs it as a background
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
| Vault lock state / unlock | `GET /api/bots/:name/secrets/lock` -> `status <bot> --json` `vault` / `POST /api/bots/:name/unlock {passphrase}` -> `secrets unlock <bot>` (passphrase on stdin) |
| Pairing state | `pair <bot> --list --json` -> `{policy, allowFrom, pending:[{code, senderId, chatId, age_s, expires_in_s}]}` |
| Approve / deny a Telegram sender | `pair <bot> <senderId>` / `pair <bot> --deny <senderId>` (CLI writes `allowFrom`, `approved/<senderId>` or the deny record, `bot.yaml`) — never from a chat message, only here or in the terminal |
| Releases panel | `GET /api/updates` reads `<BOTCORP_HOME>/state/updates.json`, newest first (by date, then version; an undated entry last), each marked `older` (at or below the installed version) and `current` (the installed one); the panel folds the older ones behind "Show N older". Apply/Skip = `update --apply <tag>` / `update --skip <tag>` |
| Chat send | `POST /api/bots/:name/send {text}` -> `send <bot> --source cockpit --json` (text on stdin); the composer then polls `GET /api/bots/:name/inbox`, which reads the last 50 items of `<BOTCORP_HOME>/state/<bot>/inbox.jsonl` without their text |
| Runs drawer | reads `<BOTCORP_HOME>/state/<bot>/runs.jsonl` tail (read-only) |
| Approvals sheet: "Done by an admin bot" | `GET /api/approvals` also returns `admin`: the last 20 lines of `<BOTCORP_HOME>/state/admin-audit.jsonl` (`{at, by, verb, target, refused}`, newest first). The section shows only when there is one. The cockpit itself always runs the CLI as the operator: it removes `BOT_NAME`, `CLAUDECODE` and `BOTCORP_LAUNCH_ID` from the CLI's env (`docs/cli.md`, "Admin bots") |
| Accounts sheet, New chat: account list | `GET /api/accounts` -> `accounts list --json` + `state/accounts.json` + `state/account-checks.json` + the usage overview: `{accounts:[{id, label, plan, masked, state: ok\|limited\|failed\|no-token, blocked_until, window, failed, check, wanted_by, bots, fiveHour, sevenDay}], bots:[{bot, running, account_wanted, account_pending, on, on_registered}]}`; each bot row also carries `backups` and `account_reason` |
| Accounts sheet: add | `POST /api/accounts {id, label, plan, token}` -> `accounts add <id> --label --plan --by <identity>` with the token on STDIN (never argv, never the audit line; the reply carries the CLI's masked last 4) |
| Accounts sheet: remove | `DELETE /api/accounts/:id` -> `accounts remove <id> --by <identity>`; 409 while a bot.yaml still names it |
| Accounts sheet: Use (per bot) | the chain route below, with the bot's backups minus the new primary; `POST /api/bots/:name/account {id\|none}` -> `accounts use` stays for other callers |
| Accounts sheet: a bot's chain (primary + backups) | `POST /api/bots/:name/accounts {primary: id or none, backups: [ids, at most 5]}` -> `accounts use <bot> <primary>` and `accounts backups <bot> <ids\|none>`, each with `--by <identity>`; approval token required |
| Settings sheet: read | `GET /api/bots/:name/config` -> `config get <bot> --json` (defaults merged) plus `set`, the paths the bot's own `bot.yaml` names (the rest show as "default") |
| Settings sheet: save one value | `POST /api/bots/:name/config {path, value}` (one scalar, or a list of names for `harness.disable` / `harness.hooks_disable` only) -> `config set <bot> <path> <value> --requested-by <identity>`; the reply says `applied`, or `queued` with the approval id when the change widens what the bot may do; a CLI refusal (unknown path, invalid value) is 400 with its reason. Lists, the accounts, automations, tools, secrets and Telegram senders are shown read-only and changed on their own page |
| Tools inventory | `GET /api/bots/:name/inventory` -> `tools <bot> inventory --json` (read-only): `{bot, groups: [harness, bot, third]}`, each group's `sections` holding items `{id, name, kind, source, license, description, on, toggle, locked, note}`; `toggle` is `{path, on, off}` (a bot.yaml value) or `{list, item}` (membership of `harness.disable` / `harness.hooks_disable` turns it off), `null` when the engine cannot switch it |
| Settings sheet: approvals | the bot's pending entries from `GET /api/approvals`, decided with the same route as the Approvals sheet |
| Settings sheet: this machine | `GET /api/cockpit` -> `{version, commit, exposure, cc: {pinned, candidate}}` |
| New chat: recent folders | `GET /api/chat/recent` reads `<BOTCORP_HOME>/state/chat-recent.json` |
| New chat: launch | `POST /api/chat/launch {account, generic, cwd}` -> `chat --account <id> --generic` or `chat --account <id> --cwd <path>` |
| Version | `botcorp.json` + `git rev-parse --short HEAD` + `exposure: loopback\|access` |
| Favicon | `web/public/favicon.svg` (built into `web/dist`), linked from `index.html` |

CLI results come back as `{ok, code, out, err}`; `out`/`err` are truncated to
4 KB and scrubbed of token shapes before they reach the browser.

Operator-gated routes (v0.9.3: gated by default): every `POST`, `PUT`,
`PATCH` and `DELETE` under `/api`, checked once in the auth middleware before
the route runs, plus the `/term/<bot>` socket and the upload thumbnails. The
only open write is `POST /api/pair/claim` (`OPEN_MUTATIONS` in `server.mjs`):
it is how a browser becomes the operator's and has its own one-time code and
lockout. So start / stop / restart (and `--fresh`), chat send, New chat
launch, unlock, pair deny, tools retire and automations run / pause / disable
now need the operator too. Behind Cloudflare Access the verified identity is
the check; on loopback they also need the per-boot approval token
(`X-Approve-Token`) or a paired browser, or they answer 403 `{need:
"approve-token"}` before any validation and the page asks for it once. The
cockpit prints the token at start and also writes it to
`<BOTCORP_HOME>/state/cockpit-approve-token`, readable by the operator's
account only, so a cockpit the daemon started (no terminal) is usable too.

**Browser pairing (loopback, v0.8.3)** replaces the token for one browser:

1. In your own terminal: `botcorp cockpit pair`. It prints an 8-character code
   (`ABCD-EFGH`), valid 10 minutes, single use. Only its sha256 is stored, in
   `<BOTCORP_HOME>/state/cockpit-pairing.json`.
2. The browser posts it to `POST /api/pair/claim {code}`. The server lists a
   device and sets `botcorp_operator=<id>.<HMAC(key, id)>` (HttpOnly,
   SameSite=Strict, 90 days). The key is `<BOTCORP_HOME>/state/cockpit-operator.key`,
   owner-only, made on first use. Five wrong codes lock claiming for 10 minutes
   (429); a new `cockpit pair` lifts the lock.
3. `operatorGate` then passes on that cookie while the device is listed.
   `GET /api/pair/devices` lists them (`current` marks this browser);
   `DELETE /api/pair/devices/:id` (`:id` or `all`, operator-gated) and
   `botcorp cockpit unpair <id|--all>` revoke, effective on the next request.

A bot cannot pair: the CLI refuses `cockpit pair|unpair` in any bot session
(exit 3), the operator guard hook blocks both for every bot, admin included,
and the vault guard blocks tool calls naming `cockpit-operator` or
`cockpit-pairing`. Behind Cloudflare Access pairing is not used (the claim
route answers 404). The residual risk is the same as the token file's: every
process runs as the same OS user, so a process that reads the browser
profile's cookie store, or writes the pairing file itself, gets past it.
Access remains the remote path.

## The page

- Chat and Terminal are two views of ONE socket (`/term/<bot>`). The server
  bridges it to the pty-host and pushes `{t:'chat', ...}` turns on it (tailed
  from the transcript by byte cursor every 1.5 s), so the client polls nothing
  per bot; only the bot list and the attention list (`/api/attention`) poll,
  every 5 s each.
- The socket types into the session and answers its permission prompts, so
  it is operator-gated like every write (v0.9.3): a paired browser's operator
  cookie, the approval token (`X-Approve-Token`, for a non-browser client) or
  Cloudflare Access. Without one the server opens the socket, sends
  `{t:'need', need:'approve-token'}` and closes it with code 4403; the page
  then offers pairing once instead of reconnecting.
- Reconnect with backoff (1 s doubling to 15 s) whenever the socket drops
  while the bot stays selected. A pty exit shows "Session exited with code N.
  Restart it?" with a Restart button.
- Key row: Esc, Ctrl+C, Ctrl+L, Shift+Tab (the mode key, `\x1b[Z`), Tab,
  Enter, arrows, +file (`web/src/screens/bot/TerminalView.tsx`).
- The chat box does not type into the socket: it queues the message in the
  bot's inbox (`botcorp send`, see `docs/cli.md`), which types it once the
  session is idle. Each sent message shows a status line under it (sending,
  queued, held, delivered, expired, not delivered, with the reason), rendered
  with `textContent` only (`web/src/lib/inbox.ts`), like the message itself.
- A terminal paste containing a newline is sent as ONE bracketed paste
  (`\x1b[200~ ... \x1b[201~`), then `\r`.
- Attachments (`core/attach.mjs`): the chat's paperclip, a paste (Ctrl/Cmd+V
  of files or a copied image) or a drop add chips above the chat input; the
  terminal's +file, paste or drop upload at once. `POST
  /api/bots/:name/uploads` takes one file as the raw body (name in
  `X-File-Name`), needs the approval token (`operatorGate`), accepts images
  (png, jpg, gif, webp), PDF, text and common code files up to 20 MB (10 per
  minute), and stores `<bot>/.botcorp/uploads/<yyyymmdd-hhmmss>-<safe name>`
  (the folder ignores itself for git). Chat: `POST /send {text, attachments:
  [ids]}` queues the text plus one `[attached: <abs path> (<type>, <size>)]`
  line per file; the inbox also pastes each image path on its own (a bracketed
  paste), which Claude Code turns into `[Image #n]`, and waits for the screen
  to settle before Enter. PDFs and text stay path lines (the harness rule says
  to Read them). Terminal: the path is pasted into the prompt, no Enter.
  Thumbnails come from `GET /api/bots/:name/uploads/<id>` (gated, images only)
  as `blob:` URLs, hence `img-src 'self' blob:` in the CSP.
- The terminal fits xterm inside an unpadded inner box (`#termScreen`) and
  re-fits on every size change of that box (a `ResizeObserver`), not only on
  window resize.
- Review board (`harness.modules.review_board`): with the module on, the bot
  header shows "Review board" plus the open count, linking to the bot's one
  private review Artifact in a new tab (`rel="noopener noreferrer"`). With
  the module on and nothing recorded yet it shows a muted "no board yet"; with
  the module off it shows nothing, even if a record is on disk. `getBot` reads
  the bot-written `<bot>/.botcorp/review-board.json` (written by
  `harness/tools/v2/review_board.py`) and passes only a
  `https://claude.ai/[code/]artifact/<id>` URL and non-negative integer
  counts; the client checks the URL again. The cockpit reads `bot.yaml` live,
  so the link follows the switch at once; the session-start line follows at
  the next launch.
- Phone: `maximum-scale=1`, chat input `inputmode=text autocapitalize=off`,
  bot list becomes a top strip under 700 px, chat is the default view. Copy on
  select is a setting (off by default) because it fights long-press selection.

### New chat

The sidebar's "New chat" row opens a modal: an account `<select>` (label +
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
