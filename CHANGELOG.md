# Changelog

All notable changes to BotCorp. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versions follow SemVer.

## v0.2.11

v0.2.10 plus the v0.1.13 release below: bg sessions are pinned in
`<config home>/jobs/pins.json` so Claude Code's supervisor stops retiring
them after 60 min idle; the tick's poller verdict is the one `status` uses;
a daemon cold-start after a host reboot seeds `harness.boot_prompt` once per
boot, and every other unattended bg launch seeds `harness.resume_prompt`;
blocked sessions are logged and FAIL doctor; the launch line names the
conversation and the worker's live id separately. `secrets:` scoping was
already on this line (v0.2.0); v0.2.11 adds the names-only `status` `secrets
env:` line, doctor `<bot>: session secrets env`, and the injected-key count
on the bg `env: OK` line. Upgrading: check out `v0.2.11`, then `botcorp
sync <bot>`. No restart for the pin or the poller verdict.

## v0.2.10

v0.2.9 plus the v0.1.12 release below: doctor's `<bot>: bun resolvable for
telegram plugin` runs the launcher's own `Resolve-BunExe` without this
shell's PATH, so a bun in `%USERPROFILE%\.bun\bin` that is also on the
shell's PATH is a PASS, not a WARN. Doctor-only; upgrading: check out
`v0.2.10`.

## v0.2.9

v0.2.8 plus the v0.1.11 release below: `sync` shims every `.py` / `.sh` /
`.ps1` of every `harness/tools/<dir>/`, a test fails on any relative
`tools/<dir>/<file>` reference no shim covers, and doctor adds `<bot>:
harness tools reachable`. Upgrading: check out `v0.2.9`, then `botcorp sync
<bot>`. No restart.

## v0.2.8

v0.2.7 plus the v0.1.10 release below: `sync` writes `tools/tg` forwarding
shims so a bot's relative `python tools/tg/tg_send.py` runs the harness copy,
`bot.yaml` `integrations.telegram.chat_id` (else the one allowlisted id) is
the tools' default chat, the media senders take the session's token, and
doctor adds `<bot>: tg tools reachable`. Upgrading: check out `v0.2.8`, then
`botcorp sync <bot>`. No restart.

## v0.2.7

v0.2.6 plus v0.1.9 below: the same code, with the v0.1.8 test that failed
on the Linux CI runner made platform-neutral. Upgrading: as for v0.2.6, from
`v0.2.7`.

## v0.2.6

v0.2.5 plus the v0.1.8 release below: the launcher puts bun's folder first on
the session's PATH (the Telegram plugin runs a bare `bun`), a bg session the
roster holds resumes with no flags (flags started a copy that never came up),
a launch with no live claude process exits 3 instead of 0, stray roster rows
are removed, and doctor adds `session alive` and `bun resolvable for telegram
plugin`. Upgrading: check out `v0.2.6`, `botcorp sync <bot>`, `botcorp stop
<bot>`, `botcorp start <bot> --fresh`, `botcorp doctor`.

## v0.2.5

v0.2.4 plus the v0.1.7 release below: `botcorp status` / `doctor` show which
env the running session got (OAuth last 4 + source, Telegram last 4, and
whether it came from a BotCorp launch at all), and `botcorp stop` stops every
session in the bot's config home. On this line an UNATTESTED launch injects no
vault secrets, so its session shows `oauth ... (inherited)` or `none` and
doctor's `session env` FAILs the inherited case. Upgrading: check out
`v0.2.5`, then per bot `botcorp stop <bot>` and `botcorp start <bot>`.

## v0.2.4

v0.2.3 plus the v0.1.6 release below: `botcorp start|restart <bot> --debug`
or `bot.yaml` `harness.debug: true` writes a Claude Code debug log (the
plugin's stderr included) to `<config home>/debug/`, and `docs/daemon.md`
records where a `--bg` session's env and the plugin's stderr go. Upgrading:
check out `v0.2.4`; nothing to migrate.

## v0.2.3

v0.2.2 plus the v0.1.5 hotfix below: a `claude --bg` session now gets the
Telegram token from the vault (the config home's Claude Code daemon is
stopped before the launch when it has no live session, because every session
inherits the env of the client that started that daemon); `status` / `doctor`
measure the poller (`OWNED` only with `bot.pid` alive under the bot's
claude); the roster parse is flat; `botcorp sync` installs a missing Telegram
plugin; `harness.telegram_token_file` is transient. Upgrading: check out
`v0.2.3`, then per Telegram bot `botcorp sync <bot>`, `botcorp stop <bot>`,
`botcorp start <bot>`.

## v0.2.2

- **The `auto_commit` Stop hook only commits inside the bot's own home.** It
  used to act on `_guard.sh`'s BOT_HOME fallback (the session cwd), so a
  `--plugin-dir` smoke run from another repo landed `chore(auto)` checkpoint
  commits there. It now requires the launcher's `BOT_HOME`/`BOT_NAME` (a
  `bots/<name>` folder), a session cwd inside that folder, and the folder
  being the root of its own git work tree; anything else is a no-op
  (`harness/tests/test_hooks_auto_commit.py`).
- **`secrets import-bundle --dry-run` previews the whole plan.** It marks
  targets that already exist with `(EXISTS)` and reports which of
  `--allow-home` / `--force` the real run would need, instead of refusing at
  the first gate. Unsafe targets still refuse. A real run is unchanged.
- Tests for the two home-scope rulings: unknown extra keys on a manifest
  `files[]` entry are ignored, and `~/.ssh` / `~/.config` paths import under
  `--allow-home` (only `.claude` / `.claude-*`, plus `.botcorp` and any
  `.vault`, are refused). No behaviour change.

## v0.2.1

v0.2.0 plus the v0.1.4 hotfix below (`sync` accepts the `--bg` bypass
disclaimer and workspace trust in the config home; `doctor` checks both;
`status` measures liveness). Upgrading from v0.1.x: the v0.2.0 step (add the
`secrets:` line) and the v0.1.4 step (`botcorp sync <bot>`) both apply.

## v0.2.0

Secret-access hardening: scoping, an audit trail, an ACL check, launch
attestation, an operator lock mode, and an encrypted bundle for moving a
bot's vault between machines. None of this is an OS boundary - every bot
still runs as the same Windows user - it is what BotCorp enforces instead
(`docs/secrets.md` has the full threat model).

- **Per-bot secret scoping.** `bot.yaml` gets a top-level `secrets:` list
  naming every vault key the launcher may inject (default `[oauth_token,
  telegram_token]`). `daemon/launch.ps1` decrypts ONLY the declared keys, into
  the child env under a fixed name for the two harness secrets or else its
  UPPERCASE form (`Get-SecretEnvName`: `hub_token` -> `HUB_TOKEN`).
  `automations[].secrets` must be a subset of the bot's own `secrets:` list -
  `daemon/botyaml.mjs --validate` rejects an automation that names an
  undeclared key. `botcorp doctor`'s `<bot>: secrets scope` line reports
  declared vs. actually-present keys.
- **The vault-guard `PreToolUse` hook cannot be disabled.** It blocks every
  `Read`/`Glob`/`Grep`/`Bash`/`Edit`/`Write`/`MultiEdit`/`NotebookEdit` call
  that touches a `.vault/` directory (any bot's), the vault scripts, the
  secrets CLI's mutating verbs, `ProtectedData`, or the audit log itself;
  `harness.hooks_disable` refuses `vault-guard` by name no matter what a
  bot's own config asks for.
- **Append-only audit log.** Every decrypt (`Get-VaultSecret`) appends one
  line to `state/secret-access.jsonl` - bot, key, reason, pid, ok, ts, never a
  value - readable with `botcorp secrets audit [bot] [--tail N] [--json]` and
  the cockpit's "Secret access" panel. `secrets list` no longer decrypts
  anything: `Set-VaultSecret` now stores each entry's `last4` alongside the
  DPAPI blob, so listing masked entries is a plain read.
- **Vault ACL + isolation checks.** `botcorp secrets acl <bot>` re-applies the
  `.vault` directory ACL (current user + SYSTEM only, inheritance off) without
  touching any entry. `botcorp doctor` adds `<bot>: vault acl` (PASS/WARN on
  the ACL state) and `<bot>: vault isolation` (feeds the vault-guard hook a
  synthetic `Read` of a SIBLING bot's vault and expects it to block).
- **Launch attestation.** A trusted start path (the daemon's cold-start,
  `restart.ps1`, `launch-visible.ps1`, `botcorp start`) mints a 32-byte
  nonce; only its sha256 lands in `state/<bot>.json` `launch`, and the raw
  nonce reaches `launch.ps1` in the environment, never on disk. `-Reason
  launch` decrypts refuse without a nonce that matches, is unconsumed, and is
  under 120 s old. A `launch.ps1` started any other way still runs, but
  WITHOUT secrets and without the Telegram poller, and says so in
  `launches.log`. It proves which recorded path launched the bot; it is not
  an OS boundary.
- **Lock mode.** `botcorp secrets migrate <bot>` moves a v1 vault (bot-name
  DPAPI entropy) to v2 (a random per-bot key `K`, wrapped either `dpapi` or
  `operator`). `botcorp secrets lock <bot>` (passphrase on stdin) removes the
  DPAPI wrap, so the vault is LOCKED now and after every reboot until
  `botcorp secrets unlock <bot> [--permanent]` (or the cockpit) unwraps `K`
  and caches it, boot-bound, until the next reboot. While locked: the daemon
  will not cold-start or restart the bot (`state/<bot>.json status: locked`),
  `botcorp start` refuses, `botcorp status` and `botcorp doctor` report it.
  The cockpit's vault drawer shows the lock state and, when locked, a
  passphrase field that posts to `/api/bots/:name/unlock` - never from a
  chat message.
- **Encrypted secrets bundle.** `botcorp secrets export-bundle <bot> --out
  <dir> [--files a,~/b]` / `import-bundle <bot> <bundle.enc>` move a bot's
  vault entries (and chosen files) between machines: AES-256-GCM +
  PBKDF2-SHA256, passphrase always on stdin. A file's `scope: bot | home`
  decides whether it restores relative to the bot folder or the operator's
  `USERPROFILE` (`~/`-prefixed, only with `--allow-home`, never into a bot
  folder or the BotCorp runtime home, never over an existing file without
  `--force`). Every import target is printed before anything is written, and
  every write is appended to the audit log with reason `import`.

**Upgrading a bot from v0.1.x:** add a top-level `secrets:` list to
`bot.yaml` naming every vault key the launcher may inject (default
`[oauth_token, telegram_token]`); a bot whose automations use other keys
must list them there too, e.g.:

```yaml
secrets: [oauth_token, telegram_token, aws_access_key_id, aws_secret_access_key, hcloud_token]
```

`botcorp doctor` (`<bot>: bot.yaml` / `<bot>: secrets scope`) reports what is
missing. `secrets.ps1 -Action get -IAmTheLauncher` is replaced by `-Nonce
<launch nonce>`. Existing v1 vaults keep working unchanged until you run
`botcorp secrets migrate <bot>`.

## v0.1.13

Found in a reboot test on the reference host: the bot died every ~63 min
and was cold-started again, the tick logged `poller=UNKNOWN` all night, and
after the reboot nothing visible said the bot was back.

- **Idle bg sessions are pinned.** Claude Code's bg supervisor retires a
  settled (idle, or blocked on input) unpinned worker 60 min after its job
  last changed; the roster row ends `done`/`failed` and the next tick
  cold-starts it (60 + 3 = 63). Nothing in BotCorp had that period
  (measured on the build box: the unpinned probe was retired "idle-prompt,
  idle 61m", the pinned one ran on past two hours). The
  launcher now adds the session to `<config home>/jobs/pins.json` (the file
  the fleet view's ctrl+t writes, re-read by the supervisor every sweep) and
  drops the id it replaced; every tick re-pins a live session that is
  missing, which heals a running bot without a restart. Doctor: `<bot>: bg
  session pinned`.
- **No fork chain; the log says what the id is.** The per-wake `session=`
  values (`d1329bd4`, `fe30a774`, ...) were the woken WORKER's live roster
  id; the transcript, the SessionStart hook and the settled roster row stay
  on the resumed conversation. The launch line is now `bg: id=<short>
  conversation=<resumed id> worker_session=<live id> ...` and `session_id`
  keeps the resumed id (recording the worker's would make the next resume
  miss the roster row and start a copy).
- **Tick poller = the status verdict.** The tick asked `tg_watchdog.py
  --probe-only`, which needs the bot token that is deleted after launch and
  absent from the tick's env, so it always said UNKNOWN. It now uses
  `Get-PollerVerdict` (bot.pid alive under the recorded claude -> OWNED, the
  same rule as `status`). A DEAD poller restarts the bot only once its launch
  is older than `LauncherGraceMin`.
- **Boot kick-off.** A daemon cold-start after a host reboot
  (`LastBootUpTime` later than the bot's previous start) seeds the session
  with `harness.boot_prompt`: by default a telegram bot sends ONE "back
  online after reboot, <time>, all checks OK / <what failed>" line via
  `tools/tg/tg_send.py` and carries on. `''` disables it. At most once per
  boot per bot (`boot_kick_boot` / `boot_kick_at` in `state/<bot>.json`);
  routine relaunches never kick.
- **Resume seed.** Every other unattended bg launch (daemon cold-start /
  restart) seeds `harness.resume_prompt`: one short turn that re-arms the
  background watchers the bot's rules describe (they die with the old
  session), picks up an interrupted task or replies "ok"; never a message,
  never scheduled. `''` disables it. The boot prompt re-arms them too.
- **Blocked sessions are reported.** A bg job blocked on a login /
  permission / question logs `BLOCKED: session <id> waits on '<needs>'` in
  `daemon.log` (once per change); doctor: `<bot>: session not blocked`.
  "idle - send a prompt to start" is Claude Code's plain idle, not a block.
- **The pin is BotCorp's own, and checked.** The write is atomic and read
  back; BotCorp unpins only an id it pinned (`pinned_bg_id`), never the
  operator's; a pins.json that is not a JSON array of short ids is left
  alone and FAILs the launch line and doctor ("format may have changed").
- **`secrets:` reaches the session env** (backport of v0.2.0's scoping,
  without attestation or the lock mode). `bot.yaml` `secrets:` (default
  `[oauth_token, telegram_token]`) lists the ONLY vault keys a launch
  decrypts; each goes into the session env under its fixed name
  (`CLAUDE_CODE_OAUTH_TOKEN`, `TELEGRAM_BOT_TOKEN`) or its UPPERCASE form.
  Undeclared vault keys are named in `launches.log`, never valued; the bg
  `env: OK` line counts and names the injected keys.
  `automations[].secrets` must be a subset (validation). Doctor: `<bot>:
  secrets scope`; names-only view of what the running session got: `botcorp
  status` `secrets env:` and doctor `<bot>: session secrets env`.

Upgrade: check out `v0.1.13`, run `botcorp doctor` (a bot whose automations
name keys missing from its `secrets:` list is now an invalid bot.yaml, and
the tick skips an invalid bot), then `botcorp sync <bot>`. The pin and the
poller verdict need no restart (the next tick pins the running session); new
`secrets:` keys reach the session only with `botcorp stop <bot>; botcorp
start <bot>` (a fresh Claude Code daemon). The boot kick-off applies from the
next reboot.

## v0.1.12

Doctor-only. On the reference host `<bot>: bun resolvable for telegram
plugin` WARNed "found only on this shell's PATH" for a bun that lives in
`%USERPROFILE%\.bun\bin`: that folder was also on the shell's PATH, PATH
wins the lookup, and the verdict judged the source of the SHELL's hit. A
daemon launch finds it through the `~/.bun/bin` fallback. The check now
runs the launcher's own `Resolve-BunExe` (daemon/_common.ps1) with an empty
PATH: PASS naming its source (`harness.bun_path` / `~/.bun/bin`), WARN only
when nothing but this shell's PATH has bun, FAIL when nothing does. No
change to what a launch does. Upgrade: check out `v0.1.12`; nothing else.

## v0.1.11

v0.1.10 shimmed `tools/tg` only; the rules, skills, agents and hook nudges
also run `tools/v2/recall.py`, `journal.py`, `gh_projects.py`,
`tools/infra/sanitize.py`, `tools/browser/ab.sh`, ... relative to the bot
folder.

- **Every harness tool folder is shimmed**: each `.py`, `.sh` and `.ps1` of
  every `harness/tools/<dir>/` (not `_`-prefixed private modules), so a new
  tool or folder needs no code change. `.sh` shims `exec bash <harness copy>
  "$@"`; `.ps1` shims run `& <harness copy> @args` and exit with its code. A
  `.py` shim imported by a bot's own script is the harness module (its CLI
  does not run). A shim in a folder the harness dropped is removed.
- **Regression test**: every relative `tools/<dir>/<file>` reference in the
  harness and the bot template must resolve to a shim of a real harness file
  in a synced bot folder. The Google tools (`tools/google/*.sh`, used by the
  morning / standup / tasks skills) are not in the harness; those skills now
  say they are the bot's own and to skip the step without them.
- Doctor: `<bot>: harness tools reachable`. `sync` reports unchanged shims
  as one `tools/ shims (<n>)` line.

Upgrade: check out `v0.1.11`, then `botcorp sync <bot>`. No restart.

## v0.1.10

A field failure on the reference host: the bot's `CLAUDE.md` and rules run
`python tools/tg/tg_send.py`, relative to the bot folder, but the tool ships
at `harness/tools/tg/`, so the call failed and the bot fell back to a
plaintext plugin reply. The same held for the media senders.

- **`sync` writes `tools/tg` shims.** One forwarding shim per
  `harness/tools/tg/*.py` in `bots/<bot>/tools/tg/`, marked by its first line;
  it runs the harness copy (argv, stdin, exit code pass through), found
  relative to the shim or at the checkout sync ran from, never a plugin-cache
  version path. A bot's own file is never touched; an orphan shim is removed.
- **The default chat is wired.** `bot.yaml` `integrations.telegram.chat_id`
  (documented as the `tg_send.py` default, read by nothing) now reaches the
  tools through `<config home>/botcorp/telegram.json`; without it, the one
  allowlisted id is the default; several ids and no `chat_id` = no default,
  with an error that says so. Resolved at send time: no restart.
- **The media senders** (`tg_send_photo/document/video.py`) resolve the token
  and chat like `tg_send.py` (they read only `<bot>/.env` before, so the
  session's `TELEGRAM_BOT_TOKEN` was ignored) and honour `BOT_TG_MUTE=1`.
- `tg_send.py --check`: the file that ran, token last 4, the chat and where
  each came from; no network.
- Doctor: `<bot>: tg tools reachable` (the shims are there and a relative
  `tg_send.py --check` in the bot folder runs).

Upgrade: check out `v0.1.10`, then `botcorp sync <bot>`. No restart.

## v0.1.9

v0.1.8 with its CI green: one v0.1.8 test forced Windows path handling and
failed on the Linux runner; it now runs on the host's platform. No code
change. Upgrade: as for v0.1.8, from `v0.1.9`.

## v0.1.8

Two field failures on the reference host, where a Telegram bot came up with
no poller and a `start` reported success with no claude process at all.

- **bun is on the session's PATH.** The Telegram plugin's `.mcp.json` runs a
  bare `bun`; a bg / session-0 launch's PATH lacked `%USERPROFILE%\.bun\bin`,
  so the plugin's MCP log said `Server stderr: 'bun' is not recognized as an
  internal or external command`. `launch.ps1` now resolves bun (`bot.yaml`
  `harness.bun_path` when it names a file, else PATH, else
  `%USERPROFILE%\.bun\bin`), puts its folder first on the PATH the session
  and the daemon get, and logs `bun: <path> (<source>)`; the plugin's files
  are never patched. Doctor's new `<bot>: bun resolvable for telegram plugin`
  resolves the installed plugin's `.mcp.json` command the same way (FAIL:
  nothing resolves; WARN: only this shell's PATH has it).
- **A bg resume never starts a copy.** `claude --bg --resume <id>` of a
  session the roster holds, WITH flags, "started a copy" that never came up.
  A roster session now resumes with no flag at all (its saved options apply);
  a session the roster does not hold resumes from its transcript with flags.
  Changed flags (channels, settings: `state/<bot>.json` `bg_flags`) or an
  explicit `--debug` refuse a CLI start with exit 4 and "botcorp start <bot>
  --fresh"; an unattended start goes fresh instead. `botcorp start --fresh` =
  a new session with the new flags; the old conversation stays on disk. A
  session started with `--debug` keeps its debug log when it is resumed
  (until the next `--fresh`); a `harness.debug` change takes effect with
  `--fresh`.
- **No silent success.** A bg launch after which no live claude process runs
  the session logs `bg: FAIL` and exits 3 (it exited 0 with `claude_pid=0`).
  The launch guard no longer reads a `blocked` roster row with no process as
  a running bot.
- **Stray roster rows go.** `stop` and every bg start `claude rm` the rows
  that are neither the recorded session nor alive (a copy that never came up,
  old sessions; `rm` keeps the conversation on disk).
- **Doctor sees a dead bot.** New `<bot>: session alive` FAILs a bot whose
  state says running, or whose last launch failed, with no claude process;
  `telegram channel running` then FAILs too instead of "bot not running", and
  quotes the plugin's newest MCP-log line (falling back to the newest log of
  any session when the recorded one has none).

Upgrade: check out `v0.1.8`, `botcorp sync <bot>`, `botcorp stop <bot>`,
`botcorp start <bot> --fresh` (a session saved by an older launcher may carry
options from a bad launch), then `botcorp doctor`.

## v0.1.7

- **`status` / `doctor` show which env the running session got.** Claude Code
  strips `CLAUDE_CODE_OAUTH_TOKEN` from its hooks, so a new `session-env`
  SessionStart hook records the session's `BOT_LAUNCHER_PID` and Telegram
  token (last 4) in `<config home>/botcorp/session-env.json`, and every launch
  records what it injected (OAuth last 4 + source, Telegram last 4) in
  `<config home>/botcorp/launch-env.json`; the launcher pid ties the two, so
  the OAuth token a session runs on is known without it ever being read back.
  `launch.ps1 -Bg` logs `env: OK | STALE | FOREIGN | UNKNOWN`, `status` prints
  `env: OK  env of the latest launch: oauth ****xxxx (vault), telegram
  ****yyyy`, and doctor's new `<bot>: session env` FAILs a session whose OAuth
  came from the environment (a machine-wide token) or is not the vault's,
  whose Telegram token is missing or wrong although it launched with
  `--channels`, or whose env did not come from a BotCorp launch at all.
- **`botcorp stop` stops every session in the bot's config home**, not only
  those whose cwd is the bot folder: the roster is per config home, and any
  live session there keeps the daemon (and its env) alive for the next start.

Upgrade: check out `v0.1.7`, then per bot `botcorp stop <bot>` and `botcorp
start <bot>` (the session-env hook runs from the next session on; until then
doctor's `session env` is WARN `UNKNOWN`).

## v0.1.6

- **Opt-in debug log for a launch.** `botcorp start <bot> --debug` /
  `restart --debug` (bg bots), or `bot.yaml` `harness.debug: true` for every
  launch (the daemon's and pty bots' included), runs the session with
  `--debug-file <config home>/debug/<stamp>.txt`. Claude Code's debug log
  carries every MCP server's stderr, so a Telegram poller that never came up
  says why (`MCP server "plugin:telegram:telegram" Server stderr: telegram
  channel: TELEGRAM_BOT_TOKEN required`). Off by default; the newest 10 are
  kept; `launches.log` names the file. Doctor's `telegram channel running`
  fix hint now says `botcorp start <bot> --debug`.
- **docs/daemon.md: where the env goes.** The daemon's per-session dispatch
  record (`daemon/roster.json`, `jobs/<id>/state.json` `providerEnv`) forwards
  only an allowlist of provider / model routing variables from the client;
  tokens and `BOT_*` are dropped, so it is not a hand-off path.
  `session-env/<session id>/` is the SessionStart hooks' `CLAUDE_ENV_FILE`
  directory for the Bash tool. The plugin's stderr is also kept outside the
  config home, in `%LOCALAPPDATA%\claude-cli-nodejs\Cache\<bot home
  slug>\mcp-logs-plugin-telegram-telegram\`.

Upgrade: check out `v0.1.6`; nothing to migrate (the v0.1.5 steps still
apply if you skipped that release).

## v0.1.5

Hotfix (branched from v0.1.4): on the reference host a `botcorp start` of a
Telegram bot came up (`claude_pid` set, doctor clean) with no Telegram
poller - no bun child under the bot's claude, no `bot.pid`, statusline TG
red - while `botcorp status` said `poller=OWNED`.

Root cause, reproduced on Claude Code 2.1.282 with a dummy token: a `claude
--bg` session is spawned by the config home's Claude Code daemon (`claude
daemon run`, `<config home>/daemon.lock`), and every session gets the
environment of the client that STARTED that daemon. When one was already
running, the launcher's `TELEGRAM_BOT_TOKEN` (and `CLAUDE_CODE_OAUTH_TOKEN`)
never reached the session; the plugin logged `telegram channel:
TELEGRAM_BOT_TOKEN required` to its MCP log and exited before writing
`bot.pid`.

- **`launch.ps1 -Bg` refreshes the daemon's env.** Before `claude --bg`: no
  live daemon -> the launch starts one with its own env (tokens stay in
  process memory, never on disk); a live daemon with no live session ->
  `claude daemon stop --any` first; a live daemon that still runs sessions of
  the bot -> left alone with a `WARN ... inherits the DAEMON's env` line in
  `launches.log`. After the launch it waits up to 30 s for the poller and
  records `poller: OWNED` or `DEAD` in the state file.
- **`botcorp stop` stops every session of the bot**, not only the recorded
  one (a copy a `--resume` started, an unrecorded earlier launch): each kept
  the daemon, and its old env, alive for the next start.
- **The roster parse was broken.** `claude agents --json` came back nested
  as one element, so no row ever matched by id and `Test-BgAgentAlive` was
  always false (duplicate guard, tick liveness, the launcher's pid lookup).
  Flat now, on pwsh 7 and Windows PowerShell 5.1.
- **`status` / `doctor` measure the poller.** `poller=OWNED` only when
  `bot.pid` is alive and descends from the bot's claude (bg) or pty root,
  otherwise `DEAD` (`FOREIGN` / `UNKNOWN` / `none` / `ORPHAN` as documented);
  `--json` adds `poller_pid`. Doctor: `<bot>: telegram channel running`
  (FAIL with the plugin's own last error for that session, e.g. `TELEGRAM_BOT_TOKEN
  required`, and `botcorp stop <bot>; botcorp start <bot>` as the fix) and
  `<bot>: telegram plugin installed`. The `enabledPlugins` check no longer
  FAILs on the `false` entry `claude plugin disable` writes.
- **`botcorp sync` installs the Telegram plugin** into the config home when
  the module is on and it is missing (`new` always did; `import` and `adopt`
  never did, so `--channels` started nothing).
- **`harness.telegram_token_file` is transient.** The ACL'd `.env` is deleted
  as soon as the plugin has read it (`bot.pid` under the session's claude),
  when the 30 s wait runs out, on every failure path and at the latest at
  session exit, with a `telegram: token file deleted ...` line in
  `launches.log`. Its ACL grant is fixed: `"$env:USERNAME:F"` expanded to an
  empty user name, so the grant never applied.

Upgrade: check out `v0.1.5`, then per Telegram bot `botcorp sync <bot>`,
`botcorp stop <bot>`, `botcorp start <bot>`; `botcorp status <bot>` should
show `poller=OWNED bot.pid=<pid>`.

## v0.1.4

Hotfix (branched from v0.1.3): the first `botcorp start` of a bot on the
reference host failed - `claude --bg` exited 1 with `--bg with
bypassPermissions requires accepting the disclaimer first`, and a second
gate sits behind it (`Workspace not trusted`). Both acceptances live in the
bot's CONFIG HOME (`bots/<name>/.claude-<name>/`), which a fresh bot has
never had a chance to accept interactively.

- **`botcorp sync` (and so `new`, `import`, `adopt`) now writes both**, merged
  into whatever is already there: `skipDangerousModePermissionPrompt: true` in
  the config home's USER `settings.json` - only when `bot.yaml` already opts
  the bot into `permissions: bypass`, and only there (Claude Code ignores the
  key in the project `.claude/settings.json`) - and
  `projects[<bot home>].hasTrustDialogAccepted: true` in the config home's
  `.claude.json`. Verified with a real fresh-config-home `--bg` launch:
  `claude_pid > 0`, the session listed by `claude agents`, no interactive step.
- **`botcorp doctor`**: `<bot>: bypass disclaimer accepted` and `<bot>:
  workspace trusted`, FAIL with `botcorp sync <bot>` as the fix.
- **`botcorp status` measures liveness** instead of echoing the state file:
  `running`, `claude_pid` and `poller` come from a live claude / pty process
  (`poller=none` when none is alive, `ORPHAN` when only the Telegram poller's
  `bot.pid` is), `status=stopped` for a dead record - a bot whose worker died
  no longer shows a stale `poller=OWNED`.

Upgrade: check out `v0.1.4`, run `botcorp sync <bot>` once per bot, then
`botcorp start <bot>`.

## v0.1.3

Hotfix for the reference host's install step (branched from v0.1.2):

- **`botcorp install` takes the password from piped stdin.** `install
  -Password <pw>` was silently ignored and the hidden prompt then hung an
  elevated, console-less shell with nothing registered. Now: piped stdin when
  stdin is not a terminal (`$pw | node cli\botcorp.mjs install`), a hidden
  prompt only on a real TTY, and with neither a fast exit 1 that says how to
  pipe it. A password on argv is refused outright. S4U is only ever explicit
  (`--s4u`); a blank password is an error, never a silent S4U fallback (the
  Password logon is what gives the daemon DPAPI and git credentials). New
  `--dry-run` prints what would be registered without registering.
- **Generated bot settings turn off Claude Code UI noise**: `feedbackSurveyRate:
  0`, `feedbackDrafts: off`, `spinnerTipsEnabled`, `promptSuggestionEnabled`,
  `showTurnDuration: false` and `env.CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1`
  in every bot's `.claude/settings.json` (a bot's config home does not inherit
  the operator's `~/.claude/settings.json`). `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`
  is deliberately not set: it also disables auto-update.

## v0.1.2

Findings from the first `botcorp doctor` run on the reference host, fixed
before its install:

- **System binaries by absolute path everywhere.** From a Scheduled-Task /
  session-0 shell, bare `powershell` spawned ENOENT and `python` / `curl.exe`
  were not found. The CLI, daemon, tray, hooks and python tools now resolve
  `powershell.exe`, `curl.exe`, `taskkill`, `icacls`, `wscript`, `reg` and
  `powercfg` under `%SystemRoot%\System32`; pwsh via `%ProgramFiles%\
  PowerShell\7`, then PATH, then the WindowsApps alias; python via
  `BOT_PYTHON`, the `py -3` launcher, the `PythonCore` registry, the per-user
  install dir, then PATH (never the WindowsApps alias); git via PATH then
  `Program Files\Git`. The launcher exports the resolved `BOT_PYTHON` to every
  bot child so hooks inherit it. `doctor` prints the resolved path per tool and
  a `python: FAIL not found: looked in …` that names every location tried.
- **`host.coexist_tasks`.** Other `*Bot*` scheduled tasks are a WARN (was
  FAIL) and, when allowlisted — `botcorp.json` `host.coexist_tasks` (shipped
  empty) plus the machine-local `<BOTCORP_HOME>/host.json` `coexist_tasks`,
  names or `*` globs — an INFO line instead. A second supervisor that
  coexists by design no longer fails the doctor.
- **`RDP firewall (mesh)` no longer passes on a rule's name.** It matched
  "Chrome Remote Desktop Host" (`LocalPort Any`). A rule now counts only with
  `LocalPort 3389` on its port filter (Remote Desktop group + `*RDP*`/`*3389*`
  names first, full per-rule scan when none looks mesh-scoped), and the
  dotted-mask `RemoteAddress` form `Get-NetFirewallAddressFilter` actually
  prints (`100.96.0.0/255.240.0.0`) is parsed, so a real mesh-only rule is
  recognised.
- Nothing pins Claude Code `2.1.281`; `minClaudeCode` `2.1.280` stays the only
  floor (the reference host is on `2.1.282`).

## v0.1.1

- **CI fixed forward on the first public run**: the `secret-scan` job now
  resolves its diff range on a root commit (`git rev-parse --verify -q`, empty
  tree as the fallback base — a bare `rev-parse` echoed the bad revision into
  `GITHUB_OUTPUT`), and the four scripts run by path (`.githooks/pre-commit`,
  `scripts/secret-scan.sh`, `harness/tools/browser/ab.sh`,
  `harness/tools/infra/orphan_rescue.sh`) are executable in the index (a
  Windows checkout had committed them 100644). `claude plugin validate
  --strict` was confirmed to run unauthenticated in CI, so its UNVERIFIED
  note is gone.
- **`export` is state-free by default**: `memory/index/` (recall index),
  `memory/metrics/`, `.claude/.current_session_id` and `.claude/.debrief_*`
  are left out unless `--include-state` (a real migration). Real memory stays
  in.

## v0.1.0

First public pre-release (1.0.0 follows the reboot test on the target host):
one shared core, N private bots, one checkout per machine.

### What changed
- **Harness plugin** (`harness/`) loaded in place with `--plugin-dir`: hooks
  (session start/end, inbound-prompt guard, precompact extract + timeline,
  memory sync, cost meter, auto-commit, block-dialogs, core-guard,
  config-guard, stop-failure, notification, subagent start/stop), six tiered
  agents (`planner`, `senior-coder`, `coder`, `one-shot`, `critic`, `fable`),
  skills (`review-artifact`, `morning`, `standup`, `weekly`, `tasks`,
  `notes`, `prd`, `launch`), the `/critic` command, and the three-channel memory loop
  (journal, timeline, cross-session recall with trust scoring).
- **Host daemon** (`daemon/`): one Scheduled-Task pair per machine
  (`BotCorp-Daemon` S4U tick + `BotCorp-Launch` visible relaunch), a per-bot
  `pty-host` process so a cockpit restart never kills a session, idempotent
  `bot.yaml` → generated-settings sync, and bounded pre-steps on every launch.
  A bot's `harness.session` (default `bg`) runs it as a background Claude
  Code session that the cockpit *attaches* to rather than owning;
  `harness.service: daemon` (default) lets the daemon supervise it.
- **DPAPI secrets vault**, per bot: OAuth token and Telegram token encrypted
  at rest (current-user scope), never written to argv or logs, injected into
  the child process as env only.
- **Bot portability**: `botcorp export <bot>` / `botcorp import <zip>` move a
  bot between machines as a plain gitignored folder — no nested git repo,
  vault excluded (DPAPI is per machine), tokens re-entered on the new box.
  Git-backing a bot's own memory is the optional `backup.git_remote` module,
  off by default. `botcorp new` shows the full feature catalogue as a
  checklist at first setup.
- **Cockpit** (`cockpit/`): browser terminal/chat, vault panel (masked),
  Telegram pairing (policy, allowlist, pending senders, Approve/Deny — never
  from a chat message), a Releases panel for pending harness updates (What
  changed / Why / Value to you, with Apply/Skip as an admin action),
  automation run history, background-session attach mode, forced Cloudflare
  Access on any non-loopback bind — no flag disables it.
- **CLI** (`cli/botcorp.mjs`): `new`, `adopt`, `export`, `import`, `sync`,
  `secrets`, `pair`, `config`, `status`, `update`, `suggest`, `doctor`.
- **Per-bot automations**: cron/interval/event-triggered jobs with backoff,
  daily run caps, idle-gating and retained run history — the generic
  replacement for hand-rolled supervisor ticks.
- **Subagent + usage observability** via OpenTelemetry export to a local
  sink, `SubagentStart`/`SubagentStop` activity logging, and a cost-meter
  rewrite over the telemetry store.
- **Admin-gated harness updates**: the hourly check only records pending
  releases with plain-language What/Why/Value notes; nothing applies itself.
  Apply happens at each bot's next safe restart, behind the existing smoke
  test and automatic rollback on failure.
- **Improvement cycle**: weekly per-bot "suggest" PRs against this repo,
  cross-bot review with loop guards (no self-review, one review per bot per
  PR, weekly cap), human-only merge via branch protection, one weekly digest
  instead of per-PR pings.
- **Public safety**: fresh, squashed history assembled by file copy (no
  `git fetch`/merge from any private source), zero identity strings enforced
  by `scripts/debrand-lint.py` in pre-commit and CI, secret scanning on push
  and pull request, noreply-only commit authorship enforced at commit time.
- CI (`ci.yml`): plugin validation, pytest, hook/script syntax checks,
  `node --check`, debrand lint, secret scan, PowerShell parse check.
- **Host setup**: `docs/host-setup.md` and `docs/host-service.md` cover
  boot-before-login (WARP pre-login connect, no auto-login, BIOS
  power-on-after-power-loss) and the Scheduled-Task service model, including
  the alternatives it was checked against.
- **New-chat launcher, accounts registry, attach + tray**: `botcorp accounts`
  keeps Claude logins (setup tokens in a per-account DPAPI vault, seedable
  from the bots); `botcorp chat` opens a plain interactive Claude for any
  account in a generic or codebase workspace, in its own Windows Terminal tab
  with a per-account config dir; `botcorp attach <bot>` pulls a background
  bot up in a tab; `botcorp tray <bot> on` adds a per-bot tray icon (status
  tooltip, Attach / Restart / Stop / Open cockpit / New chat) that starts at
  login.
- **Bot-level Telegram commands, validated hook opt-outs, real `adopt`**: a
  bot adds slash commands by exporting `HANDLERS` from
  `tools/tg_commands_local.py` (bot wins on a name clash); `harness.hooks_disable`
  names are validated against the hooks that exist; `botcorp adopt` copies a
  hand-grown bot in (no repo, no token, no `.env`); `doctor` asserts each bot
  runs on its own vault OAuth token (last 4 characters, never the
  machine-wide one) and that a Google `token.json` belongs to the account
  `bot.yaml` names.

### Why
Running more than one long-lived Claude Code bot by hand — one hooks folder,
one supervisor script, one set of credentials, copy-pasted and drifting per
bot — does not scale past the first bot and cannot survive a reboot
unattended. BotCorp separates what every bot shares (hooks, agents, the
memory loop, the daemon, the cockpit) from what makes each bot itself
(persona, memory, credentials), and keeps every write to shared state behind
a guarded writer or a human-reviewed PR.

### Value to you
One checkout, any number of bots, each one credentialed and isolated from
the others; a browser you can reach from a phone to watch, chat with, or
restart any of them; secrets that are never plaintext at rest or on the
wire; and a harness that improves itself through reviewed PRs instead of
hand-editing N copies of the same hook.
