# Changelog

All notable changes to BotCorp. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versions follow SemVer.

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
