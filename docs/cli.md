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
   and stores it as vault key `oauth_token`; blank = skip, the bot then
   refuses to launch until `secrets set <name> oauth` (or a `/login` in its
   config home);
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

### `export <bot> [--out <zip>] [--list] [--include-state]`

Zips `bots/<bot>/` for a move to another machine (or a cold copy). Default
`<BOTCORP_HOME>/exports/<bot>-<yyyymmdd-hhmm>.zip`. EXCLUDED: `.vault/`
(DPAPI blobs are useless elsewhere), every `.claude-*` config home
(transcripts, plugin state, `.credentials.json`; `import` re-seeds one and
`sync` rebuilds the Telegram allow-list from `bot.yaml`), `node_modules`,
`__pycache__`, `*.pyc`, and — unless `--include-state` — the runtime state
the target regenerates: `memory/index/` (the recall index, rebuilt from the
journals at session start), `memory/metrics/`, `.claude/.current_session_id`
and `.claude/.debrief_*`. Real memory (`memory/auto`, `memory/sessions`,
`TDL.md`, `MEMORY.md`) is always in. `.git/` is never exported or
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

Between backups, the `auto_commit` Stop hook pushes too, once `backup` is in
the session's `BOT_MODULES` (a launch after `git_remote` was set): it commits
anything uncommitted, then, if the bot folder's OWN repo (a `.git` in
`bots/<bot>/`) has commits on no `origin` ref, runs `git push origin
HEAD:<branch>` in the background with `GIT_TERMINAL_PROMPT=0`,
`GCM_INTERACTIVE=never`, `credential.interactive=never` and a 60 s bound, so
the hook returns at once. It also runs on a clean tree, so a failed push is
retried on the next Stop. No origin = no push (`botcorp backup <bot>` adds
it). Each attempt appends `<ts> push <branch> ahead=<n> rc=<exit>` to
`<BOTCORP_HOME>/state/<bot>/push.log`; doctor's `<bot>: unpushed commits`
reads it. A bot without `backup.git_remote` is untouched: commits stay
local, as before.

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

It also MERGES two files in the config home (`bots/<name>/.claude-<name>/`),
keeping every other key the operator has there: `settings.json` gets
`skipDangerousModePermissionPrompt: true` - only when `bot.yaml` already
opts the bot into `permissions: bypass`, and only in these USER settings
(Claude Code ignores the key in the project `.claude/settings.json`) - and
`.claude.json` gets `projects[<bot home>].hasTrustDialogAccepted: true`. A
`claude --bg --dangerously-skip-permissions` launch refuses until both the
bypass disclaimer has been accepted and the workspace is trusted, which a
fresh config home the daemon starts unattended can never do interactively.

The bot's rules, skills, agents and `CLAUDE.md` run harness tools relative
to the bot folder (`python tools/tg/tg_send.py ...`, `python
tools/v2/recall.py ...`, `bash tools/browser/ab.sh ...`), but they ship in
the harness. So sync writes a forwarding shim `bots/<name>/tools/<dir>/<tool>`
for every `.py`, `.sh` and `.ps1` in every `harness/tools/<dir>/` (not the
`_`-prefixed private modules). It runs the harness copy - Python in the same
interpreter, `.sh` by `exec bash <harness copy> "$@"`, `.ps1` by `& <harness
copy> @args` - so argv, stdin and the exit code pass through; a `.py` shim
that a bot's own script imports is the harness module. The harness is found
relative to the shim (`bots/<name>` -> the BotCorp checkout) or else at the
checkout sync ran from, never a plugin-cache version path, so a harness
update needs no re-sync. The marker line `# botcorp-shim: generated by
botcorp sync` is the first line (the second, after the shebang, in a `.sh`).
A file without it is the bot's own and is never touched (delete the line to
take a shim over); a shim whose harness tool or folder is gone is removed.
Unchanged shims are reported as one `tools/ shims (<n>)` line. A test greps
the harness and the bot template for relative `tools/<dir>/<file>`
references and fails on any that no shim covers; the Google tools the
morning / standup / tasks skills use are the bot's own (the harness ships
none), and those skills say so.
`bot.yaml` `integrations.telegram.chat_id` goes to
`<config home>/botcorp/telegram.json`, where the tools read it at send time.
The default chat of `tg_send.py` and the media senders is, in order:
`TELEGRAM_CHAT_ID` in the env, `<bot>/.env`, `bot.yaml` `chat_id`, the one
id in `access.json` `allowFrom` when there is exactly one (a DM chat id is
the user id). With several ids and no `chat_id` there is no default: a send
needs `--chat-id`. `python tools/tg/tg_send.py --check` prints the file that
ran, the token (last 4) and the chat, with where each came from, without
sending.

With the telegram module on, `botcorp sync` (the CLI command, not
`daemon/sync.mjs`, which the tick runs offline) also installs the Telegram
plugin into the config home when it is missing - `new` always did, `import`
and `adopt` never did, and `--channels` then started nothing. It runs the
same three `claude plugin` steps as `new` (marketplace add, install,
disable); `--dry-run` only says it is missing.

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

### `secrets acl <bot>`

Re-applies the vault directory ACL (current user + SYSTEM only, inheritance
off, on the `.vault` folder and every file already in it) without touching
any entry. What a copied or restored bot folder needs, since it may have
inherited a wider ACL from its new parent. See `docs/secrets.md` for the
threat model this ACL does (and doesn't) cover.

### `secrets migrate <bot>`

Moves a v1 vault (bot-name DPAPI entropy per entry) to v2: mints a random
per-bot key, re-protects every entry with it, and writes `.vault/key.json`
with a DPAPI wrap (lock mode `none`). A no-op, reported as such, on a vault
that is already v2. `lock` runs this automatically first if needed.

### `secrets lock <bot>` / `secrets unlock <bot> [--permanent]`

Operator lock mode. `lock` (passphrase on stdin, minimum 8 characters; a
hidden prompt when not piped) wraps the vault's per-bot key under the
passphrase only and drops the DPAPI wrap, so the vault is LOCKED right now
and stays locked after every reboot until `unlock`. Calling `lock` again on
an already operator-locked vault re-locks it at once with no passphrase
needed (drops the until-reboot unlock cache). `unlock` (passphrase on stdin)
verifies it and caches the key until the next reboot, so the daemon can
cold-start / restart the bot again; `--permanent` instead restores the
DPAPI wrap and removes the operator lock entirely (back to lock mode
`none`). Full mechanism, on-disk shapes and cockpit path: `docs/secrets.md`.

```
echo <passphrase> | botcorp secrets lock bot-1
echo <passphrase> | botcorp secrets unlock bot-1
```

### `secrets export-bundle <bot> --out <dir> [--files a,~/b]` / `secrets import-bundle <bot> <bundle.enc> [--manifest <json>] [--dry-run] [--allow-home] [--force]`

Move a bot's vault entries (and optionally chosen credential files) between
machines as an encrypted bundle. The passphrase always comes in on stdin -
never argv, never echoed. `--files` entries are relative to the bot's own
folder by default; a `~/`-prefixed entry (e.g. `~/AppData/Roaming/thing/
creds.json`) is relative to `USERPROFILE` instead (scope `home`).
`import-bundle` prints every resolved target (`target [bot|home|vault] ...`)
before writing anything, refuses any home-scoped file unless `--allow-home`
is passed, and refuses to overwrite any existing file unless `--force` is
passed; `--dry-run` prints what would be restored and writes nothing. Full
bundle format, encryption details and import guarantees: `docs/secrets.md`.

```
echo <passphrase> | botcorp secrets export-bundle bot-1 --out .\out --files token.json,~/AppData/Roaming/thing/creds.json
echo <passphrase> | botcorp secrets import-bundle bot-1 .\out\secrets.bundle.enc --allow-home
```

### `secrets audit [bot] [--tail N] [--json]`

Reads `<BOTCORP_HOME>/state/secret-access.jsonl`, one line per decrypt written
by `daemon/vault.ps1`: `bot`, `key`, `reason` (`launch|automation|cli|list|
export|doctor|unlock|import`), `pid`/`ppid`, `ok`, `ts` — never a value.
Append-only; audit history outlives a bot, so this does not require the bot
to still exist (no `requireBot` check). Prints the newest `--tail` lines
(default 50, max 5000), optionally filtered to one bot; `--json` returns the
array. A missing log file prints `no secret access recorded yet` and exits 0.

```
botcorp secrets audit bot-1 --tail 20
botcorp secrets audit --json
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
`bot.yaml`, the generated `settings.json`, `access.json` and the vault; the
`vault-guard` hook separately blocks any tool — including `Read`/`Bash` — from
touching a vault or the secrets CLI's mutating verbs).
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

### `start <bot> [--fresh] [--debug]` / `stop <bot>` / `restart <bot> [--fresh] [--debug]`

`--debug` (bg bots) passes `launch.ps1 -DebugLog`: this one launch runs with
`--debug-file <config home>/debug/<yyyyMMdd-HHmmss>.txt`, Claude Code's own
debug log, which carries every MCP server's stderr (`MCP server
"plugin:telegram:telegram" Server stderr: ...`). `bot.yaml`
`harness.debug: true` does the same for every launch, the daemon's included
(the only way for a pty bot). Off by default; the newest 10 logs are kept.

`harness.boot_prompt` is the one prompt a daemon cold-start sends after the
HOST rebooted (never on a routine relaunch or a `start`): `null` (default) =
a telegram bot sends one "back online after reboot" line via
`tools/tg/tg_send.py`, `''` = off, a string = that prompt (`{boot}` / `{now}`
substituted). Once per boot per bot (docs/daemon.md, "Boot kick-off").
`harness.context_window` is the bot's auto-compact window: `70%` (default)
of the model's context window (1M for the Opus 5 / Fable 5 family, 200k for
Haiku, an unknown model counts as 1M), an integer token count
(100000-1000000), or `auto` (Claude Code's own). `botcorp config set <bot>
harness.context_window 50%` works as typed in pwsh and bash. The launch sets
`CLAUDE_CODE_AUTO_COMPACT_WINDOW` in the session env, which Claude Code ranks
above every `autoCompactWindow` setting, so it also beats a machine-wide value
(`auto` drops that one for the bot); sync writes the same number as
`autoCompactWindow` into the config home's settings.json for a session
BotCorp did not start. Applies at the next session start. Doctor: `<bot>:
context window` (the value, where it comes from, the machine-wide value it
overrides; WARN on a stale settings.json or a running session started with
another value).
`harness.resume_prompt` is the short turn every other unattended bg launch
(daemon cold-start / restart, `botcorp start|restart`) seeds instead: `null` = re-arm the watchers the
rules describe, pick up an interrupted task, else reply "ok"; `''` = off
(docs/daemon.md, "Resume seed").

A bg bot's session resumes WITHOUT flags while the config home's roster holds
it (running or stopped): its saved options apply, and any flag would make
Claude Code start a copy (docs/daemon.md, "Resuming a bg session"). So a
`start` / `restart` with `--debug`, or whose flags differ from what the
session saved (channels / settings changed), refuses (exit 4) and says
`start <bot> --fresh`; `--fresh` starts a new session with the new flags (the
old conversation stays on disk). A session started with `--debug` keeps its
debug log on every resume until the next `--fresh`. An unattended start (the daemon, `restart.ps1`)
with changed flags reflags instead of refusing: it `claude rm`s the roster row
and resumes the same conversation with the new flags. A bg launch after which
no live claude process runs the session exits 3, never 0.

- `start` is a trusted launch path: it mints the launch nonce (attestation,
  `docs/secrets.md`) before spawning, so its launch gets the bot's declared
  vault secrets. It refuses outright when the vault is operator-locked
  (`vault: <bot> is LOCKED ... unlock first: botcorp secrets unlock <bot>`).
- `start`: spawns `node daemon/pty-host.mjs --bot <bot> --botcorp <root>
  --continue|--fresh` DETACHED (the host owns the ConPTY; the cockpit attaches
  to it), waits up to 10 s for `<BOTCORP_HOME>/state/<bot>.pty.json` and prints
  its pty pid, host pid and loopback port (never the attach token). Refuses if
  a live host already owns the bot.
- `stop`: `pty-host --stop <bot>` (tree-kill of the shell: claude and the
  Telegram poller included); a bg bot goes through `daemon/stop.ps1`:
  `claude stop <bg id>`, the guarded tree-kill on the recorded claude pid,
  `claude stop` on every OTHER live session in the bot's config home (e.g. a
  copy a `--resume` started) - each one would keep the config home's Claude
  Code daemon, and the env it started with, alive for the next start
  (docs/daemon.md, "bg sessions and the daemon's env") - and `claude rm` of
  every roster row that is neither the recorded session nor alive (a copy
  that never came up; `rm` keeps the conversation on disk). Then removes `<config home>/channels/telegram/bot.pid`
  if ITS pid is dead and `<config home>/botcorp/tg_owner.lock` if ITS pid is
  dead (the plugin's own stale-pid cleanup is a no-op on Windows; a stale lock
  would make the next launch think the poller is foreign).
- `restart`: stop, wait up to 10 s for the pty pid to die, with `--fresh`
  touch `bots/<bot>/.claude/.botcorp_fresh_restart` (launch.ps1 honours a
  marker younger than 300 s and starts FRESH; the default keeps the running
  context with `--continue`), then start.

### `status [<bot>] [--json]`

Per bot: running (a live pty host pid, or the state file's `claude_pid`
alive as a process - measured, never read back from the file) and its
`phase` (`idle`, `working`, `blocked`, `unknown`, `starting`, `stopped` or
`down`, the same record `observe` prints; `phase` and `activity` in
`--json`), pty/host pids and port, the daemon's `state/<bot>.json` (`launch`
= the last launch phase, `started_by`, `poller`, `claude_pid`; with nothing
alive `claude_pid=-` and `poller=none`, or `poller=ORPHAN` when only the Telegram
poller's `bot.pid` is alive). While the bot is alive with the telegram
module on, `poller` is measured too: `OWNED` (plus `bot.pid=<pid>`) only when
`<config home>/channels/telegram/bot.pid` names a live process that descends
from the bot's claude (bg) or pty root - the plugin writes that file only
after its token check - otherwise `DEAD`; `FOREIGN` when the launch went
without `--channels` because another live process held the owner-lock,
`UNKNOWN` when the process tree could not be read. `--json` adds
`poller_pid`. A running bot also gets `secrets env:`: the env var NAMES
(never values) of the vault keys in the session's env, read from the record
of the launch whose env the session runs on (`launch-env.json`
`secret_env`), plus any `secrets:` key missing from it. Then the telegram module, model, harness version
(`harness/.claude-plugin/plugin.json`), the age of `<config
home>/botcorp/status.json` with context used %, 5 h / 7 d rate-limit usage
and the running CC version (written by the statusline on every render), the
pending approvals count, and a `vault: <mode> v<version>[ LOCKED - botcorp
secrets unlock <bot>]` line (`{mode, version, locked, detail}` under
`vault` in `--json`) — the same lock state the cockpit reads for its vault
drawer. A bot with declared automations gets an `automations:` line: each
name, `(prompt)` for a `kind: prompt` entry, and its last result (`sent` /
`skipped: <reason>` / `failed: ...` for a prompt, `exit N` otherwise);
`{name, kind, last_result, next_due}` under `automations` in `--json`.

### `observe <bot>|--all [--json] [--roster]`

What each bot's session is doing right now, measured from the processes and
Claude Code's own files (`core/observe.mjs`), never read back from the state
file. Read-only. One record per bot: `{bot, alive, activity, phase, poller,
bg_id, blocked, at, kind, claude_pid, session_id, quiet_s}`. `activity` is
`down`, `blocked`, `idle`, `working` or `unknown`; `phase` adds the launch
and the operator's intent (`starting`, `stopped`, `down`); both are defined
in docs/daemon.md "State file". `--all` = every bot under the bots dir;
`--json` prints one object for a named bot, an array for `--all`. The text
form is one line per bot: name, phase, `alive=`, `poller=`, `bg=`, and
`blocked=` / `quiet=` when they apply.
`--roster` also asks `claude agents --json` (bg bots), which finds a worker
the supervisor restarted under a new pid; it writes the config home's
`.claude.json`, so the daemon tick does not pass it. The tick runs `observe
--all --json` every 3 min and persists each record as `observed`.

### `automations <bot> [list [--json] | pause <name> | resume <name> | run <name>]`

`list` joins `bot.yaml` `automations[]` with the daemon's
`<BOTCORP_HOME>/state/<bot>/automations.json` when present; each row carries
its `kind`, and a `kind: prompt` row shows the prompt's first 60 characters
and `last_result` (docs/automations.md). `pause` /
`resume` = `config set automations.<name>.enabled false|true` (non-widening,
applied at once; the next daemon tick honours it). `run` appends
`{"automation": "<name>", "ts": "<iso>"}` to
`<BOTCORP_HOME>/state/<bot>/events/run-now.queue`, which
`daemon/automations.ps1` consumes on its next tick (the run still obeys
`timeout_min`, `max_per_day` and the idle gate). A name queued twice runs
once; an unknown or disabled name is logged and dropped.

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

### `install [--s4u] [--unregister] [--dry-run]`

Registers the two scheduled tasks via `daemon/install.ps1`. The daemon task
needs the Windows password of the task principal (Password logon = a real
profile: DPAPI and git credentials work unattended). The password reaches
the script on STDIN, never on argv:

```powershell
$pw = Read-Host -AsSecureString "Windows password"   # or however you hold it
[System.Net.NetworkCredential]::new('', $pw).Password | node cli\botcorp.mjs install
```

Piped stdin is used whenever stdin is not a terminal (the same detection as
`secrets set`); on a real TTY with nothing piped it prompts hidden. With no
TTY and nothing on stdin it exits 1 at once with the pipe hint (an elevated,
console-less install used to hang on the prompt). `-Password x` /
`--password x` on the command line are refused (process listings show argv).
S4U (no stored password, no profile) is only ever explicit: `--s4u`; a blank
password is an error, never a silent S4U. `--dry-run` collects the password
the same way, prints what would be registered (`LogonType Password`, the
password length only) and registers nothing. `--unregister` removes both
tasks. Missing script: `daemon/install.ps1 not present`, exit 1.

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

### `doctor [--json] [--host] [--no-accounts] [--no-tg-probe]`

One `PASS` / `WARN` / `FAIL` / `INFO` line per check, grouped under
`[core]`, `[bots]`, `[cockpit]`, `[host]` headings; exit 1 on any `FAIL`.
`--host` runs only the host group. `--no-accounts` skips the live account
logins, `--no-tg-probe` the Telegram slot probe.

- `claude --version` >= `botcorp.json.minClaudeCode`, node >= 20, python
  >= 3.11, pwsh >= 7, git present;
- `node_modules`: FAIL when the checkout's `node_modules` is missing, empty,
  or a junction whose target is gone, or a `package.json` dependency does not
  resolve (fix: `npm ci` in the checkout, after `cmd /c rmdir` of a dangling
  junction, which removes only the link). The CLI checks this before loading anything that needs it, so
  with a wiped `node_modules` every command answers with that fix and
  `doctor` prints this one check; the daemon's log then reads
  `bot.yaml unreadable: MODULE_NOT_FOUND '<package>'`;
- `worktree node_modules`: FAIL when another git worktree of the checkout has
  a `node_modules` that is a junction or symlink into the main (live)
  worktree's `node_modules`; a `git worktree remove` through that link empties
  the live one (fix: `cmd /c rmdir` of the link, then `npm ci` in that
  worktree);
- `harness/.claude-plugin/plugin.json` readable; `claude plugin validate
  harness --strict` passes;
- `python` / `pwsh` / `git` are reported with the absolute path they resolved
  to. Every system binary is spawned by absolute path (`%SystemRoot%\System32`
  for `powershell.exe`, `curl.exe`, `taskkill`, `icacls`, `wscript`; pwsh via
  `%ProgramFiles%\PowerShell\7`, PATH, then the WindowsApps alias; python via
  `BOT_PYTHON`, the `py -3` launcher, the `PythonCore` registry keys,
  `%LOCALAPPDATA%\Programs\Python`, then PATH): a Scheduled-Task / session-0
  shell has no usable PATH, and `python: FAIL not found: looked in …` names
  every place that was tried;
- scheduled tasks: `BotCorp-Daemon` and `BotCorp-Launch` present (WARN when
  absent: `botcorp install`); any OTHER `*Bot*` task is a WARN and is named
  (two supervisors fighting over one bot is what this catches) — unless it is
  allowlisted in `host.coexist_tasks` (exact names or `*` globs, shipped
  empty in `botcorp.json`, extended per machine by
  `<BOTCORP_HOME>/host.json` `{"coexist_tasks": ["<OtherBot>-*"]}`), which
  reports it as `INFO coexisting *Bot* tasks` instead. The reference host
  runs a second, independent bot supervisor and allowlists its task prefix
  that way;
- per bot: `bot.yaml` valid; vault readable (`unreadable` entries =>
  `vault unreadable - re-enter tokens`; no `oauth_token` => WARN);
  `<bot>: vault acl` — PASS when `.vault` (and every file in it) grants only
  the current user + SYSTEM with inheritance off, WARN otherwise (with
  `botcorp secrets acl <bot>` to fix it); `<bot>: vault isolation` — feeds
  the vault-guard hook a synthetic `Read` of a SIBLING bot's `.vault` and
  expects it to block (exit 2); FAIL if the hook lets it through or
  `harness/hooks/hooks.json` does not register it for
  `Read|Glob|Grep|Bash|Edit|Write|MultiEdit|NotebookEdit`; `<bot>: secrets
  scope` — declared (`bot.yaml` `secrets:`) vs. present vault keys, WARN on
  either a declared key missing from the vault or a vault key that's present
  but undeclared (never decrypted at launch); `<bot>: vault lock` — PASS
  (v2) / INFO (v1) when the vault's actual lock mode matches (or `bot.yaml`
  `vault.lock` is unset), WARN when it's operator-locked (the daemon will not
  start or restart the bot until `botcorp secrets unlock <bot>`) or when
  `bot.yaml` asks for a lock mode the vault isn't actually in;
  `<bot>: bypass disclaimer accepted` (with `permissions: bypass`, the config
  home's `settings.json` must carry `skipDangerousModePermissionPrompt`) and
  `<bot>: workspace trusted` (the config home's `.claude.json` must trust
  `bots/<bot>`), both FAIL with `botcorp sync <bot>` as the fix - a `--bg`
  launch refuses without them; no plugin ENABLED by
  `enabledPlugins` in `bots/<bot>/.claude/settings.json` or `<config
  home>/settings.json` (the `false` entry `claude plugin disable` writes is
  fine); `<bot>: oauth token` — the vault `oauth_token` must
  exist and must not be the machine-wide `CLAUDE_CODE_OAUTH_TOKEN` (compared
  on the last 4 characters only); FAIL means the bot would run on another
  bot's account, or (no vault entry) refuses to launch; `<bot>: secrets scope` - the keys `bot.yaml` `secrets:`
  injects into the session, WARN for a declared key with no vault entry, and
  the vault entries it leaves out (named, never injected); `<bot>: session
  secrets env` - the same names-only list as `status`'s `secrets env:` line,
  WARN when a declared key is not in the running session's env; `<bot>: google account` — with `integrations.google.account`
  set, Drive `about.user.emailAddress` for `bots/<bot>/token.json` must equal
  it; `bots/<bot>/.vault` ignored by the BotCorp checkout
  when it is a git repo (a bot folder is not a repo, so there is no per-bot
  ignore check unless the backup module made one: then `.vault` and
  `.claude-<bot>` must be ignored THERE or it is a FAIL);
  `<bot>: harness tools reachable` - every harness tool outside `tools/tg`
  has a sync shim or the bot's own copy in the bot folder (FAIL: missing, or
  a shim for a removed tool: `botcorp sync <bot>`; WARN: shims from another
  checkout);
  with telegram on: `pairing: policy=<p> allowlisted=<n> pending=<n>`, WARN
  when the policy is `pairing` and `allowFrom` is empty (nobody can talk to
  the bot without a code); `<bot>: telegram plugin installed` (FAIL: `botcorp
  sync <bot>` installs it); `<bot>: tg tools reachable` - every harness
  `tools/tg/*.py` is in the bot folder (a sync shim or the bot's own copy)
  and a relative `python tools/tg/tg_send.py --check` there runs, naming the
  file that ran and the default chat (FAIL: `botcorp sync <bot>`; WARN: no
  default chat, or shims from another checkout); `<bot>: telegram channel running`, the `status`
  measurement - PASS on `OWNED`, FAIL on `DEAD` with the plugin's last error
  from its MCP log (`%LOCALAPPDATA%\claude-cli-nodejs\Cache\<bot home
  slug>\mcp-logs-plugin-telegram-telegram`, e.g. `TELEGRAM_BOT_TOKEN
  required`) and `botcorp stop <bot>; botcorp start <bot>` as the fix, INFO
  when the bot is not running; `<bot>: foreign telegram owner-lock` - an
  owner-lock a launcher OUTSIDE BotCorp keeps in the bot folder
  (`host/.run/tg_owner.lock`, `.claude/.tg_owner.lock`; BotCorp's own lock is
  in the config home and cannot see these): FAIL when it names a live pid (a
  second launcher can start a second poller for the token), WARN when stale,
  PASS when absent; `<bot>: telegram slot` - when this bot's own poller is
  NOT the holder (not running, or `DEAD` / `FOREIGN` / `UNKNOWN`), up to 4
  `getUpdates?timeout=0&limit=1` probes 2 s apart, run inside the vault by
  `secrets.ps1 -Action tg-probe` (one audited decrypt, reason `doctor`; it
  prints only the HTTP codes) with the vault token (no
  offset: nothing queued is confirmed or dropped; the token never leaves the
  request URL): FAIL on any 409 (another process polls the token) or a
  rejected token, PASS when every probe answers 200, WARN when it could not
  tell, INFO `not probed` while the bot's own poller is `OWNED` (a 409 would
  say nothing there) or with `--no-tg-probe`; with `backup.git_remote` set:
  `<bot>: unpushed commits` - commits in the bot folder's repo that are on no
  `origin` ref (local remote-tracking refs, no fetch) with the newest
  `<BOTCORP_HOME>/state/<bot>/push.log` line: PASS at 0, WARN when some are
  younger than 24 h (the auto-commit hook pushes on the next Stop), FAIL when
  the oldest is 24 h or more; WARN for no repo / no origin (`botcorp backup
  <bot>`), a detached HEAD, or an origin other than `backup.git_remote`; bg bots: `<bot>: bg session pinned` - the
  recorded `bg_id` is in `<config home>/jobs/pins.json` (FAIL: unpinned, Claude
  Code retires an idle bg session after 60 min; the next daemon tick pins it)
  and `<bot>: session not blocked` - its `jobs/<bg_id>/state.json` is not
  blocked on a login / auth / usage limit / trust dialog (FAIL with the `claude
  attach <id>` hint) or on a question its last turn ended with (WARN), both INFO when the bot is not running (docs/daemon.md, "Idle
  retirement and the pin"); `integrations.access.team` set but the cockpit
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
  1, WARN); an enabled inbound allow rule with **`LocalPort 3389`** whose
  `RemoteAddress` covers `100.96.0.0/12` (`Any`, CIDR, the dotted-mask form
  `100.96.0.0/255.240.0.0`, or an `a-b` range all count; WARN when none: the
  mesh cannot reach RDP). A rule never matches on its name alone — the
  Remote Desktop group's Shadow rule and "Chrome Remote Desktop Host" are
  `LocalPort Any` and used to pass that way. Enumerating every port filter
  needs elevation, so the "Remote Desktop" group and rules named `*RDP*` /
  `*3389*` are checked first and the full per-rule scan (≈15 s per 230
  rules) runs only when none of those looks mesh-scoped;
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
| `BOTCORP_BOTS_DIR` | the bots dir (default `<checkout>/bots`), honoured by the CLI, cockpit, daemon and launcher alike |
| `COCKPIT_PORT` / `PORT` | cockpit port for `doctor` and the printed URL (default 4477) |
| `BOTCORP_PTY_COMMAND` | pty-host test seam: `start` hosts this command line instead of `launch.ps1` (tests only) |
| `BOT_NAME` | set inside a bot session by the launcher; `config set` records it as `requested_by`; `update --apply/--skip` refuses when it is set |
| `CLOUDFLARE_API_TOKEN` | `doctor`'s Workers Builds trigger check (`integrations.cloudflare`); env only, the daemon injects it |
| `BOTCORP_DEBUG` | print stack traces for unexpected errors |

## What the cockpit calls

`start|stop|restart <bot> [--fresh]`, `secrets list <bot> --json`,
`secrets set <bot> <key>` (value on stdin), `secrets unlock <bot>`
(passphrase on stdin), `status <bot> --json` (lock state for the vault
drawer), `pair <bot> <senderId>`, `pair <bot> --list --json`, `pair <bot>
--deny <senderId>`, `update [--json]`, `update --apply|--skip <tag>`. Output
is truncated to 4 KB and scrubbed of token shapes before it reaches the
browser (`cockpit/cli.mjs`).

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
