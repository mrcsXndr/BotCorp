# `botcorp` - the operator CLI

`node cli/botcorp.mjs <command> ...` from the BotCorp checkout (alias it to
`botcorp`). It is the ONE implementation of every rule the daemon, the cockpit
and your terminal share: the cockpit's buttons call it, the daemon's ticks call
it, and a bot's chat-driven config changes go through it. Node 20+, Windows
first (`pwsh` 7 for the vault and the scheduled-task checks).

Conventions:

- Exit codes: `0` ok, `1` error, `2` usage, `3` duplicate Telegram token.
- Plain text, one fact per line. Read commands take `--json` and print objects.
- A secret is never on a command line and never printed: values go in on
  STDIN (or a hidden prompt) and come out masked (`****last4`).
- Paths: BotCorp root = the folder above `cli/`; bots live in
  `bots/<name>/` (= `BOT_HOME`), each with its own Claude Code config home
  `bots/<name>/.claude-<name>/` and vault `bots/<name>/.vault/`. Machine
  runtime lives under `BOTCORP_HOME` (default `~/.botcorp`): `state/`,
  `logs/`, `work/`, `access.json`.

## Commands

### `new [--name <slug>] [--persona "..."] [--telegram] [--telegram-owner <id>] [--modules a,b] [--no-modules c] [--yes] [--oauth-stdin] [--no-launch] [--no-plugin-install]`

Creates a bot from `templates/bot/`. Default name = first free `bot-1`,
`bot-2`, ... A bot folder is a PLAIN folder that BotCorp's `.gitignore`
keeps out of the repo; `new` runs no `git init` (see `export` / `import` /
`backup` for moving and versioning one). In order:

1. **the feature catalogue.** On a terminal (stdin is a TTY and `--yes` is
   absent) it shows one numbered checklist, defaults pre-marked: modules
   (`harness.modules.*` with one-line descriptions), skills
   (`harness/skills/*`), agents (`harness/agents/*`) and integrations
   (telegram, board, hub, backup; access is shown as info because cockpit
   exposure is machine-wide). Type numbers to toggle, Enter to accept.
   Non-interactive: `--modules a,b` / `--no-modules c` (module names from
   `templates/bot/bot.yaml`), `--telegram` = `--modules telegram`, `--yes`
   keeps the defaults; the backup module has no flag (set
   `backup.git_remote` with `config set` afterwards). With telegram on it
   asks for YOUR Telegram user id (`--telegram-owner <id>`, 5-12 digits;
   message `@userinfobot` to read yours) and writes it to
   `integrations.telegram.allow_from`, so the operator never needs a pairing
   code; blank = pair later;
2. writes a MINIMAL `bots/<name>/bot.yaml`: `name`, `persona`, and only the
   catalogue choices that differ from the defaults in `daemon/botyaml.mjs`
   (`harness.modules.<x>`, `harness.skills`/`agents` as a list, `allow_from`,
   `backup.git_remote`);
3. `sync` (generated `.claude/settings.json`, `CLAUDE.md`, `.gitignore`,
   `settings.local.json`, `tg-enable.settings.json`, `memory/*`, the
   `.claude-<name>/` config home, and with telegram on `access.json` plus the
   `approved/<id>` marker for the owner id), then seeds
   `<config home>/.claude.json` (onboarding done, workspace trusted;
   `docs/cc-compat.md`);
4. asks for the ONE token a bot needs, the OAuth token from `claude
   setup-token` (hidden prompt; `--oauth-stdin` reads it from stdin instead)
   and stores it as vault key `oauth_token`; blank = skip, the session then
   needs `/login` until `secrets set <name> oauth`;
5. with telegram on: prompts for the BotFather token (vault key
   `telegram_token`; exit 3 if another bot already holds it), then installs
   the official Telegram plugin INTO THIS BOT'S CONFIG HOME and leaves it
   DISABLED (`claude plugin marketplace add
   https://github.com/anthropics/claude-plugins-official`, `claude plugin
   install telegram@claude-plugins-official --scope user`, `claude plugin
   disable telegram@claude-plugins-official`, all with
   `CLAUDE_CONFIG_DIR=<config home>`, 180 s each; `--no-plugin-install`
   skips the three steps for an offline or test run, the launcher needs them
   done before the poller can start). Only the launcher's `--settings
   tg-enable.settings.json` ever enables it, so a plain `claude` in the bot
   folder can never start a second poller;
6. `start <name>` (fresh) unless `--no-launch`, then prints the resulting
   catalogue table and the next steps.

### `export <bot> [--out <zip>] [--list]`

Zips `bots/<bot>/` for a move to another machine (or a cold copy). Default
`<BOTCORP_HOME>/exports/<bot>-<yyyymmdd-hhmm>.zip`. EXCLUDED: `.vault/`
(DPAPI blobs are useless elsewhere), every `.claude-*` config home
(transcripts, plugin state, `.credentials.json`; `import` re-seeds one and
`sync` rebuilds the Telegram allow-list from `bot.yaml`), `node_modules`,
`__pycache__`, `*.pyc`. `.git/` is never exported or
imported (a bot folder is not a nested repo; `botcorp backup` re-creates one
from `backup.git_remote`). Prints the path and the
entry list (`--list` forces the full list past 40 entries) and the reminder
`tokens are not exported: run botcorp secrets set on the target`. Pure
Node (`cli/_zip.mjs`, deflate, no zip64: >4 GB or >65535 entries is refused).

### `import <zip> [--as <name>]`

Unpacks an export into `bots/<name>/` (name from the zip's `bot.yaml`, or
`--as`). Refuses if the bot already exists. `.vault/`, `.git/` and `.claude-*`
entries in a hand-made zip are dropped. `bot.yaml` lands byte-for-byte; with
`--as` only its `name:` line is edited as text, so every comment survives.
Then `sync` (which rebuilds `access.json` from `bot.yaml`), the `.claude.json`
seed, and the reminder to `secrets set <name> oauth` (and `telegram`). Nothing
is started.

### `backup <bot> [--dry-run]`

The optional backup module: OFF while `backup.git_remote` is null (the
command says so and exits 1). With a remote: `git init` inside
`bots/<bot>/` once (branch `main`), `.gitignore` = the template's (restored
if missing), and a hard refusal unless `.vault`, `.claude-<bot>` and
`.claude/settings.json` are ignored there; repo-local identity (the
checkout's `user.name/email`, else `botcorp <botcorp@users.noreply.github.com>`);
`origin` = the remote; `git add` of `.gitignore` + `backup.paths` (default
`[memory]`); one commit `backup <iso>` when something changed; `git push -u
origin HEAD:main` bounded 120 s with `GIT_TERMINAL_PROMPT=0`,
`GCM_INTERACTIVE=never`, `credential.interactive=never` (a credential prompt
is never answered: use a token URL or a stored credential). The daemon can
run it on a cadence: `harness/automations.yaml` may carry a `backup`
automation gated by `module: backup` (the module counts as enabled exactly
when `git_remote` is set; `daemon/botyaml.mjs enabledModules` adds `backup`
to `BOT_MODULES` then).

### `adopt <path> --as <name> [--dry-run] [--config-dir <old CLAUDE_CONFIG_DIR>]`

Copies a hand-grown bot folder into `bots/<name>/` and syncs it. Refuses if
`bots/<name>` already exists. `<path>` is COPIED, never moved: the source is
left untouched. The copy drops `.git`, `.vault`, `.claude-*` config homes,
`.env*`, `*.oauth_token`, `token.json`, `credentials.json` and
`channels/telegram/.env` — nothing that could carry a live credential comes
along, so no token is ever migrated. Files that are byte-identical to a
harness file (relative paths under `.claude/hooks`, `tools`, `.claude/agents`,
`.claude/rules`, `.claude/skills`, `.claude/commands` compared with
`harness/*`) are dropped as duplicates; anything the bot owns that overlaps a
harness hook is moved into `.claude/settings.local.json` instead of staying a
loose file. `bot.yaml` is written from what's found (model, effortLevel,
permissions mode; telegram on if a `tg-enable.settings.json` exists) when the
folder doesn't already have one. Then it runs `sync` and seeds
`<config home>/.claude.json`. `--config-dir <old CLAUDE_CONFIG_DIR>` copies
only the allow-list from the old config home
(`channels/telegram/access.json`) — nothing else. `--dry-run` prints all of
the above, touching nothing.

### `sync <bot> [--dry-run]`

`daemon/sync.mjs`: `bot.yaml` -> generated `.claude/settings.json` (header
says "regenerated"; never `enabledPlugins`, never hooks), merged
`access.json` when the telegram module is on, bot-owned files only if
absent. For every id that the merge ADDS to `allowFrom` it also drops the
empty marker `<config home>/channels/telegram/approved/<id>`, which the
plugin polls (sends "Paired!", deletes the file); ids already in the file
get no second marker, so a re-sync never re-greets anyone. Idempotent; run
after any hand edit of `bot.yaml`.

### `secrets set <bot> <key>` / `secrets list <bot> [--json]` / `secrets delete <bot> <key>`

Front for `daemon/secrets.ps1` (DPAPI, CurrentUser, per-bot entropy). `set`
takes the value from stdin when piped, else a hidden prompt; the key is the
only thing on argv. Aliases: `oauth` -> `oauth_token`, `telegram` ->
`telegram_token`, `hub` -> `hub_token`. Any other key name is accepted
(`aws_secret_access_key`, `hcloud_token`, ...); such keys are injected into an
automation's environment as their UPPERCASE name when listed in
`automations[].secrets`. `list` is masked (`****last4`,
`unreadable` for a blob this account cannot decrypt); `--json` rows are
`{key, masked, fp, updated_at}`, no value field. Exit 3 = another bot's vault
holds the same Telegram token (one poller per token).

```
echo <token> | botcorp secrets set bot-1 telegram
botcorp secrets list bot-1
```

### `pair <bot> <senderId>` / `pair <bot> --list [--json]` / `pair <bot> --deny <senderId>`

The operator's approval of a Telegram sender, done at the machine or from
the cockpit, never from a chat message. Writes, exactly as the official
plugin's access skill does: `allowFrom` (add) in
`<config home>/channels/telegram/access.json`, removes any `pending` entry for
that sender, creates the empty marker
`<config home>/channels/telegram/approved/<senderId>`, and adds the id to
`integrations.telegram.allow_from` in `bot.yaml` so `sync` and the file agree;
then syncs. `--list` is what the cockpit's pairing panel shows: the pending
senders (`senderId`, `chatId`, age) and the current `allowFrom`; `--json`
returns `{policy, allowFrom: [...], pending: [{code, senderId, chatId, age_s,
expires_in_s}]}` (plus `present`/`file`). `--deny <senderId>` removes that
sender's pending codes (a missing sender is reported, not an error). The
plugin stores no username and BotCorp never runs its own `getUpdates` to
fetch one (it would 409 the live poller).

Policies: `pairing` (default) hands an unknown sender a one-time code and
keeps the entry in `pending` until the operator approves it here; the
operator's own id is pre-allowed by `new --telegram-owner`. `allowlist` is
the STRICTER option: unknown senders are dropped silently and never appear
as pending, so nothing can be approved from the cockpit; use it once the
allow-list is final. Nothing ever approves a pairing from inside a chat.

### `accounts add <id> [--label <text>] [--plan <text>]` / `accounts list [--json]` / `accounts remove <id>` / `accounts seed`

The accounts registry: Claude logins kept separately from any one bot, for the
`chat` launcher. Each account lives at `~/.botcorp/accounts/<id>/`:
`account.json` (id, label, plan) plus a DPAPI vault (entropy `account:<id>`)
holding `oauth_token`, and `claude/` — that account's own `CLAUDE_CONFIG_DIR`
(settings, history, credentials). `add` takes the token on STDIN or a hidden
prompt, never argv. `list [--json]` prints `{id, label, plan, masked,
config_dir, updated_at}` per account (masked = `****last4` or empty).
`remove <id>` deletes the token and the `account.json` record but keeps
`claude/` (session histories survive). `seed` creates one account per bot
that already holds an `oauth_token` (id = the bot's name, re-encrypted
in-process into the account vault's own entropy; accounts that already exist
are left alone).

### `chat [--account <id>] [--cwd <path>|--generic] [--dry-run]`

Opens a plain interactive Claude for an account — not a bot session. Run with
no flags on a terminal (stdin is a TTY) for an interactive picker: account,
then Generic / a recent folder / a typed folder. Otherwise the flags:
`--account <id>` picks the login, `--cwd <path>` opens that folder as the
workspace, `--generic` uses the account's own home with no project context.

Launches a Windows Terminal tab (`wt -w 0 new-tab`) running
`daemon/chat.ps1 -InTab`, which — inside the tab process — reads the
account's token from its vault, sets `CLAUDE_CODE_OAUTH_TOKEN` and
`CLAUDE_CONFIG_DIR=~/.botcorp/accounts/<id>/claude` (seeded on first use from
`~/.claude/settings.json` minus plugins/hooks/env, plus a `.claude.json` that
trusts the workspace), clears any bot/child-session markers, and runs plain
`claude`: no `--plugin-dir`, no `--channels`, no supervisor, no state file.
Generic mode's cwd is the account home. It never inherits the machine-wide
HKCU `CLAUDE_CODE_OAUTH_TOKEN`. `--dry-run` prints the window command and the
env with the token masked, launching nothing.

### `attach <bot> [--elevate]`

Pulls a bot's background session up into a Windows Terminal tab:
`daemon/attach.ps1` runs `claude attach <bg id>` under the bot's own config
home. Elevated when the bot's `install.json` run_level is `Highest`, or
`--elevate`. The session keeps running when the tab closes — this only opens
a window onto it. Prints a message and exits 0 when the bot has no recorded
background session id.

### `tray <bot> on [--attach-at-login]|off|status`

A per-bot tray icon: `daemon/tray.ps1` shows status / context % / last tick
as the tooltip, with a menu (Attach, Restart, Stop, Open cockpit, New chat,
Exit) and double-click = Attach. `on` registers
`HKCU\...\Run\BotCorp-Tray-<bot>` (a hidden-pwsh wscript shim) via
`daemon/tray-register.ps1` so it starts at login; `off` removes that entry;
`status` prints whether it is registered or absent. `on --attach-at-login`
also registers a second HKCU Run value, `BotCorp-Attach-<bot>`, that runs
`daemon/attach.ps1 -WaitSec 180` at login: it waits up to 3 minutes for the
daemon to bring the session up, then opens the attach tab, as the reference
host does.

### `config get <bot> [<dotted.path>] [--json]` / `config set <bot> <dotted.path> <value>`

The GUARDED WRITER: the only way `bot.yaml` changes from inside a bot session
(the harness `config-guard` PreToolUse hook blocks direct `Edit`/`Write` on
`bot.yaml`, the generated `settings.json`, `access.json` and the vault).
`get` reads the effective config (defaults applied). Values parse as
`true | false | null | <number> | [a,b] | string`. Automations are addressed
by name: `automations.<name>.enabled`. Unknown paths (anything not in
`daemon/botyaml.mjs` DEFAULTS, for `get` and `set` alike) and values that
would make `bot.yaml` invalid are rejected (`name` cannot be changed here).

Non-widening paths apply immediately (written to `bot.yaml`, then `sync`;
effective at the next session roll): `model`, `effort`, `persona`,
`harness.modules.*`, `harness.hooks_disable`, `automations.<name>.enabled`,
`suggest.*`, `integrations.hub.interval_s`, and anything else that does not
widen.

WIDENING changes are NOT applied. They are appended to
`<BOTCORP_HOME>/state/<bot>.approvals.json` as
`{id, ts, path, value, requested_by, reason}` and the command prints
`queued for operator approval: botcorp approve <bot> <id>`:

| path | widening when |
|---|---|
| `integrations.telegram.allow_from` | the new list adds an id |
| `integrations.telegram.dm_policy` | it loosens: `disabled` < `allowlist` < `pairing` (pairing admits new senders with a code) |
| `permissions` | `default` -> `bypass` |
| `harness.modules.remote_control` | `false` -> `true` |
| `automations.<name>.secrets` | the new list adds a vault key |

`requested_by` is `bot:<BOT_NAME>` when a bot session calls it, else
`operator:<user>` (`--requested-by` overrides). Every queue/approve/reject is
appended to `<BOTCORP_HOME>/logs/<bot>/approvals.log`.

### `approve <bot> <id|--all>` / `approve <bot> --list [--json]` / `reject <bot> <id>`

Applies a queued entry (or all), then `sync`. Approving an `allow_from`
addition also performs `pair` for each new id (access.json + `approved/<id>`)
when the telegram module is on; when it is off the ids sit in `bot.yaml` and
`sync` writes them into `access.json` once the module is enabled (the command
says so). `reject` drops the entry.

### `start <bot> [--fresh]` / `stop <bot>` / `restart <bot> [--fresh]`

- `start`: spawns `node daemon/pty-host.mjs --bot <bot> --botcorp <root>
  --continue|--fresh` DETACHED (the host owns the ConPTY; the cockpit attaches
  to it), waits up to 10 s for `<BOTCORP_HOME>/state/<bot>.pty.json` and prints
  its pty pid, host pid and loopback port (never the attach token). Refuses if
  a live host already owns the bot.
- `stop`: `pty-host --stop <bot>` (tree-kill of the shell: claude and the
  Telegram poller included). Then removes `<config home>/channels/telegram/bot.pid`
  if ITS pid is dead and `<config home>/botcorp/tg_owner.lock` if ITS pid is
  dead (the plugin's own stale-pid cleanup is a no-op on Windows; a stale lock
  would make the next launch think the poller is foreign).
- `restart`: stop, wait up to 10 s for the pty pid to die, with `--fresh`
  touch `bots/<bot>/.claude/.botcorp_fresh_restart` (launch.ps1 honours a
  marker younger than 300 s and starts FRESH; the default keeps the running
  context with `--continue`), then start.

### `status [<bot>] [--json]`

Per bot: running (pty.json with a live host pid), pty/host pids and port,
the daemon's `state/<bot>.json` (`status`, `started_by`, `poller`,
`claude_pid`), telegram module, model, harness version
(`harness/.claude-plugin/plugin.json`), the age of `<config
home>/botcorp/status.json` with context used %, 5 h / 7 d rate-limit usage
and the running CC version (written by the statusline on every render), and
the pending approvals count.

### `automations <bot> [list [--json] | pause <name> | resume <name> | run <name>]`

`list` joins `bot.yaml` `automations[]` with the daemon's
`<BOTCORP_HOME>/state/<bot>/automations.json` when present. `pause` /
`resume` = `config set automations.<name>.enabled false|true` (non-widening,
applied at once; the next daemon tick honours it). `run` appends
`{"automation": "<name>", "ts": "<iso>"}` to
`<BOTCORP_HOME>/state/<bot>/events/run-now.queue`, which
`daemon/automations.ps1` consumes on its next tick (the run still obeys
`timeout_min`, `max_per_day` and the idle gate).

### `update [--json]` / `update --apply <tag>` / `update --skip <tag>` / `update --check`

Harness updates are ADMIN actions; nothing applies automatically. The
daemon's hourly check records releases in `<BOTCORP_HOME>/state/updates.json`
(`{releases: [{tag, sha, date, what, why, value, status}]}`, status
`pending | apply_requested | applied | skipped | failed`), each with
plain-language notes: What changed / Why / Value to you. `update` lists them
with those notes; `--apply <tag>` sets `status: apply_requested` (the daemon
applies it at each bot's next safe restart, smoke test and automatic rollback
kept) and `--skip <tag>` sets `skipped`; both stamp `decided_at` /
`decided_by` and refuse from inside a bot session (`BOT_NAME` set). The CLI
never applies anything itself. `--check` shells to `daemon/update.ps1
-Check` to record new releases now.

### `install [--s4u] [--unregister]`

Registers the two scheduled tasks via `daemon/install.ps1`. Unless `--s4u`,
it prompts (hidden) for the Windows password of the task principal and hands
it to the script on STDIN (`-PasswordFromStdin`; never on argv); blank, or
an `install.ps1` without that switch, registers the S4U tasks (no stored
password) and says so. `--unregister` removes both tasks. Missing script:
`daemon/install.ps1 not present`, exit 1.

### `cockpit expose --team <slug> --aud <aud> --yes` / `cockpit unexpose`

Cockpit exposure is MACHINE-WIDE: there is ONE cockpit per box and
`<BOTCORP_HOME>/access.json` (`{team, aud}`) is what lets it bind
off-loopback and accept a tunnel, gated by Cloudflare Access (JWT verified on
every request, fail-closed; `cockpit/access.mjs`). `expose` prints that
consequence and writes nothing without `--yes` (exit 1); `unexpose` deletes
the file. Per-bot `integrations.access` only records which Access app a bot
expects (`doctor` cross-checks it against the machine file). Restart the
cockpit after either.

### `suggest <bot> --topic <t> [--lesson <file>] [--dry-run]`

The improvement cycle's upstream path. Refuses when the checkout has no
`.git`. Creates a git worktree of the BotCorp checkout at
`<BOTCORP_HOME>/work/<t>` on branch `suggest/<bot>/<t>` from `origin/main`
(or `HEAD` without an origin); with `--lesson` copies the file to
`harness/lessons/<slug>.md`, runs `scripts/debrand-lint.py` on it (a hit
stops here with the worktree left for you to fix) and commits it. It prints
the `git push` and `gh pr create --label suggest --label bot:<bot>` commands
it would run next and runs neither. `--dry-run` prints everything and creates
nothing.

### `doctor [--json] [--host]`

One `PASS` / `WARN` / `FAIL` / `INFO` line per check, grouped under
`[core]`, `[bots]`, `[cockpit]`, `[host]` headings; exit 1 on any `FAIL`.
`--host` runs only the host group.

- `claude --version` >= `botcorp.json.minClaudeCode`, node >= 20, python
  >= 3.11, pwsh >= 7, git present;
- `harness/.claude-plugin/plugin.json` readable; `claude plugin validate
  harness --strict` passes;
- scheduled tasks: `BotCorp-Daemon` and `BotCorp-Launch` present (WARN when
  absent: `botcorp install`); any OTHER `*Bot*` task is a FAIL and is named
  (two supervisors fighting over one bot is the failure this catches);
- per bot: `bot.yaml` valid; vault readable (`unreadable` entries =>
  `vault unreadable - re-enter tokens`; no `oauth_token` => WARN); no
  `enabledPlugins` in `bots/<bot>/.claude/settings.json` or `<config
  home>/settings.json`; `<bot>: oauth token` — the vault `oauth_token` must
  exist and must not be the machine-wide `CLAUDE_CODE_OAUTH_TOKEN` (compared
  on the last 4 characters only); FAIL means the bot would run on another
  bot's account; `<bot>: google account` — with `integrations.google.account`
  set, Drive `about.user.emailAddress` for `bots/<bot>/token.json` must equal
  it; `bots/<bot>/.vault` ignored by the BotCorp checkout
  when it is a git repo (a bot folder is not a repo, so there is no per-bot
  ignore check unless the backup module made one: then `.vault` and
  `.claude-<bot>` must be ignored THERE or it is a FAIL);
  with telegram on: `pairing: policy=<p> allowlisted=<n> pending=<n>`, WARN
  when the policy is `pairing` and `allowFrom` is empty (nobody can talk to
  the bot without a code); `integrations.access.team` set but the cockpit
  not exposed, or a different team than the machine file => WARN;
  `integrations.cloudflare: {account_id, workers}` + `CLOUDFLARE_API_TOKEN`
  in the env (never read from the vault here; the daemon injects it) => one
  line per Worker from `GET .../accounts/<id>/builds/workers/<script
  tag>/triggers` (10 s each), FAIL `git-connected Workers Builds trigger on
  <worker>: a push would double-deploy` when any trigger exists, INFO when
  unset or the token is absent, WARN `could not read` on any error;
  `integrations.google.account` + a `token.json` in the bot folder: compared
  through `harness/tools/google/google_workspace.py whoami` (10 s) when that
  module is present, INFO `google account check needs the google tools
  module` when it is not; `<bot>: tray` — `HKCU\...\Run\BotCorp-Tray-<bot>`
  present when `harness.tray` is true (FAIL when it should be registered and
  isn't), INFO when the tray is off;
- `account <id>: token` — a 1-turn `claude -p` on `claude-haiku-4-5-20251001`
  run under that account's config dir with its vault token in the env; PASS /
  FAIL / INFO, cached 24 h in `~/.botcorp/state/account-checks.json` keyed by
  the token's fingerprint (never the token itself);
- cockpit: `GET http://127.0.0.1:<port>/healthz` (WARN when down;
  `COCKPIT_PORT`, default 4477); `cockpit exposure: loopback-only (no
  <BOTCORP_HOME>/access.json)` or `exposed via Access team=<t>`; without the
  file, ANY non-loopback address of this machine answering on the cockpit
  port => `FAIL reachable off-box without Access`;
- `git status --porcelain` of the checkout non-empty => WARN `harness edited
  in place` (an in-place edit blocks the self-update from applying);
- host (Windows; the remote-box requirements from `docs/host-setup.md`; each
  line carries the value read, each read is bounded and fails open to WARN
  `could not read`): `CloudflareWARP` service Running + Automatic (FAIL
  otherwise); `warp-cli status` (10 s) contains `Connected` (FAIL);
  auto-connect present in `warp-cli settings` or under
  `HKLM\SOFTWARE\Cloudflare\CloudflareWARP` /
  `HKLM\SOFTWARE\Policies\Cloudflare\WARP` (WARN); RDP enabled
  (`fDenyTSConnections` = 0, FAIL) with NLA (`RDP-Tcp\UserAuthentication` =
  1, WARN); an enabled inbound RDP firewall rule (the "Remote Desktop"
  group, or any rule named `*RDP*` / `*3389*`: name a custom mesh-only rule
  that way) on port 3389 whose `RemoteAddress` covers `100.96.0.0/12` (`Any`
  counts; WARN when none: the mesh cannot reach RDP; enumerating every
  port filter needs elevation, so the check goes rule-first);
  `Winlogon\AutoAdminLogon` absent or 0 (FAIL when 1: no auto-login);
  `powercfg /q SCHEME_CURRENT SUB_SLEEP STANDBYIDLE` AC index = 0 (FAIL);
  hibernation off (`powercfg /a` lists it as not available, or
  `HibernateEnabled` = 0, or `HiberbootEnabled` = 0; WARN otherwise); BIOS
  power-on-after-power-loss cannot be read: `INFO verify in firmware`.

### `help`

Prints the command summary.

## Environment

| Variable | Meaning |
|---|---|
| `BOTCORP_HOME` | machine runtime root (default `~/.botcorp`) |
| `COCKPIT_PORT` / `PORT` | cockpit port for `doctor` and the printed URL (default 4477) |
| `BOTCORP_PTY_COMMAND` | pty-host test seam: `start` hosts this command line instead of `launch.ps1` (tests only) |
| `BOT_NAME` | set inside a bot session by the launcher; `config set` records it as `requested_by`; `update --apply/--skip` refuses when it is set |
| `CLOUDFLARE_API_TOKEN` | `doctor`'s Workers Builds trigger check (`integrations.cloudflare`); env only, the daemon injects it |
| `BOTCORP_DEBUG` | print stack traces for unexpected errors |

## What the cockpit calls

`start|stop|restart <bot> [--fresh]`, `secrets list <bot> --json`,
`secrets set <bot> <key>` (value on stdin), `pair <bot> <senderId>`, `pair
<bot> --list --json`, `pair <bot> --deny <senderId>`, `update [--json]`,
`update --apply|--skip <tag>`. Output is truncated to 4 KB and scrubbed of
token shapes before it reaches the browser (`cockpit/cli.mjs`).

## Notes

- A bot folder is a plain folder, never a nested git repo: `new` does not
  `git init`, `doctor` does not expect one. `export`/`import` move a bot;
  the optional `backup:` module (and only it) creates a repo inside the
  folder for `memory/`.
- `bot.yaml` round-trips through js-yaml on `pair`, `config set`, `approve`
  and `import --as`: keys and values survive, comments do not. Keep the
  explanations in `templates/bot/bot.yaml`, not in a bot's file.
- The vault ceiling: "encrypted at rest" covers `.vault/secrets.json`.
  Anything Claude Code writes under the bot's own config home stays under
  Claude Code's control: `.credentials.json` (present only after an
  interactive `/login`, e.g. for Remote Control) and, if the env-only token
  path is unavailable on a box, `channels/telegram/.env`. Both are ACL'd to
  the user and gitignored; neither is encrypted by BotCorp.
