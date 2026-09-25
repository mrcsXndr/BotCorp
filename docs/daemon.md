# The daemon

One daemon per machine keeps every bot under `bots/<name>/` alive. It is the
single inherent BotCorp service: `install.ps1` registers exactly two Windows
scheduled tasks, and adding a bot adds a folder, never a task. Everything it
does is a short **tick** (a fresh `pwsh` process every few minutes), so there
is no long-lived supervisor of ours to die. The long-lived processes it
babysits are Claude Code's own background-session supervisor (one per user,
started by the first `claude --bg`), each bot's background session, the
cockpit, and, for `harness.session: pty` bots, a per-bot `pty-host`.

Why this model and not a Windows service or S4U: `docs/host-service.md`. How
to prepare the box (BIOS, power, WARP, RDP, no auto-login): `docs/host-setup.md`.

```
daemon/
  tick.ps1              the tick (mutex Global\BotCorpDaemon; always exit 0)
  launch.ps1            launches ONE bot (vault -> env, --plugin-dir, owner-lock); -Bg = claude --bg
  restart.ps1           wait-for-old-pid, then relaunch the same conversation (honours a fresh marker)
  launch-visible.ps1    action of the BotCorp-Launch task: `claude attach <id>` (bg) or a visible launch (pty)
  install.ps1           registers / removes the two tasks; writes state/install.json
  automations.ps1       per-bot automations scheduler + detached run waiter (docs/automations.md)
  update.ps1            hourly harness update CHECK (records releases + notes); admin-requested APPLY
  smoke.ps1             the harness smoke test (validate, pytest, bash -n, node --check, hooks, tick, bg-agents)
  pty-host.mjs          per-bot ConPTY owner (session: pty) and the cockpit's attach transport (--attach)
  botyaml.mjs           the ONE bot.yaml parser (defaults applied); every script consumes its JSON
  sync.mjs              bot.yaml -> generated .claude/settings.json + access.json
  vault.ps1 / secrets.ps1   DPAPI vault (per bot, per machine, per user)
  attach.ps1            opens an attach tab onto a running bg bot (elevated when needed, -WaitSec)
  tray.ps1              per-bot tray icon: status/context%/tick tooltip + Attach/Restart/Stop/cockpit/chat menu
  tray-register.ps1     HKCU Run entries for the tray and (--attach-at-login) the login-time attach tab
  chat.ps1              New-chat launcher: a plain interactive claude for an account, -InTab in its own WT tab
  accounts.ps1          the accounts registry (logins for `chat`, separate from bots) + its DPAPI vault
  _common.ps1           helpers shared by the .ps1 scripts: Claude Code specifics (Resolve-ClaudeExe,
                        Get-ClaudeEnv, Get-ClaudeArgv, Get-ClaudeHeadlessArgv, Test-ClaudeVersion),
                        bg helpers, the ownership guard (Get-ProcessOwnerRecord / Stop-BotProcessTree)
  hidden-launcher.vbs.template   the no-flash shim the daemon task runs (pwsh resolved at runtime)
```

Claude Code is the only CLI: its exe resolution, env names and argv live in
`_common.ps1`. (The earlier per-CLI driver folder is gone; there is no `cli:`
key in `bot.yaml`.)

Runtime root `BOTCORP_HOME` (default `~/.botcorp`) holds machine state only,
never secrets:

| Path | Written by | Meaning |
|---|---|---|
| `daemon.log` | every script | one line per event; `logs/<bot>/daemon.log` carries the per-bot copy |
| `logs/<bot>/launches.log` | launch.ps1 | per launch: mode, masked vault notes, `bg: id=... session=... claude_pid=...` |
| `state/<bot>.json` | launch.ps1 + tick + the SessionStart hook | the bot's process record: `service` (`bg`/`fg`), `bg_id` (short id for `claude attach`), `session_id` (full uuid, the `--resume` handle), `claude_pid`, `shell_pid` (pty/fg only), `status`, `started_by`, `poller`, `session_env` + `env_launcher_pid` (which launch's env the session got, below), `launcher_pid`, `launcher_started_at`, `triage_last_scan`, `janitor_at`, `harness_version` |
| `state/<bot>.pty.json` | pty-host | `{pid, ptyPid, port, token, startedAt, mode}`; `mode: attach` = an attach transport, not the session |
| `state/<bot>.paused` | the CLI (`botcorp stop`) | present = the daemon must NOT cold-start this bot |
| `state/<bot>/automations.json`, `runs.jsonl`, `events/`, `jobs/` | automations.ps1 | see docs/automations.md |
| `state/install.json` | install.ps1 | `{user_profile, user, logon_type, run_level, registered_at, botcorp_root, runtime_root, interval_min}` |
| `state/daemon.json` | tick | `cockpit_pid`, `cockpit_started_at`, `update_check_at` |
| `state/launch-request.json` | tick / restart.ps1 | `{bot, requested_at}` read by launch-visible.ps1 (ignored after 10 min) |
| `state/updates.json` | update.ps1 | `{checked_at, head, head_sha, releases:[{tag, sha, date, what[], why[], value[], status}]}`; status `pending` / `apply_requested` / `applied` / `skipped` / `failed` (+ `fail_reason`, `fail_detail`) |
| `state/harness.json` | update.ps1 -Apply | `{tag, sha, channel, applied_at, schema, migrations}` |
| `state/accounts.json` | usage tooling | `{"accounts":{"<account>":{"blocked_until":"<iso>","bots":[...]}}}` -> non-critical automations pause |
| `state/otel.json` | otel-sink.mjs (optional) | `{port, pid}`; the tick restarts a dead sink |
| `protect.json` | the operator | `{"pids":[...], "patterns":[...]}`: never killed by the daemon, whatever else says it is ours |
| `access.json` | the operator (`integrations.access`) | Cloudflare Access `{team, aud}`; without it the cockpit is loopback-only |
| `cockpit.json` | the operator | `{enabled, port, bind}`; default enabled on `127.0.0.1:4477` |
| `daemon-hidden.vbs` | install.ps1 | generated from the template |

Bot-side markers (all under `bots/<name>/.claude/`): `.botcorp_breakpoint`
(the bot declares a clean breakpoint; younger than `BOT_BREAKPOINT_TTL_MIN`
(30) reads as idle), `.botcorp_fresh_restart` (younger than 300 s = the next
launch starts FRESH: a new session id), `.botcorp_resume_prompt` (usage-limit
resume seed). The Telegram owner-lock lives in the bot's config home:
`bots/<name>/.claude-<name>/botcorp/tg_owner.lock` (the launcher's pid for a
pty/fg launch, the claude worker's pid for a bg launch).

## Two session kinds (`bot.yaml` `harness.session`)

| `session` | The bot process | Liveness | Stop | Seen through |
|---|---|---|---|---|
| `bg` (default) | a Claude Code background session: `launch.ps1 -Bg` runs `claude --bg [--resume <session_id>] --dangerously-skip-permissions --plugin-dir <harness> [--channels ... --settings <tg-enable>]` (channels LAST) and exits; the session runs under Claude Code's supervisor for the bot's config home (`<config home>/daemon.lock`) | `claude agents --json` (run with the bot's `CLAUDE_CONFIG_DIR`) lists the id / session id / cwd with a live `pid` or state `working`/`blocked`, OR the recorded `claude_pid` is alive | `claude stop <id>` (bounded 45 s; the conversation is kept), then the guarded tree-kill on the recorded pid if it lingers | `claude attach <id>` (BotCorp-Launch task, `botcorp attach`), the cockpit via `pty-host --attach` |
| `pty` | `pty-host.mjs` owns a ConPTY that runs `launch.ps1 -InPty`, which execs `claude --continue ...` | the launcher shell + its `claude.exe` child, or the claude pid | `pty-host --stop <bot>` (`taskkill /T /F` on the pty root, then the host) | the cockpit attaches to the pty-host; the BotCorp-Launch task opens a visible launch |

`harness.service: manual` (distinct key) means the daemon never cold-starts
the bot; it still heals a running one.

**One conversation across restarts.** A bg relaunch passes `--resume
<session_id>` from `state/<bot>.json` (the SessionStart hook and `launch.ps1`
both write it). `claude --bg --resume <id>` continues that session under the
same id on Claude Code >= 2.1.257, or starts a copy and prints a `note:`; the
launcher records whatever id the roster then shows. `--bg --continue` always
starts a COPY, so it is never used. No session id recorded (first launch, or
a fresh marker) = a fresh background session.

**Elevation (the admin-only pipe).** The supervisor pipe answers only callers
with the token that started the supervisor. The daemon task launches the bot,
so the tick's `claude agents` / `claude stop` always match. A human `claude
attach` must match too: with `install.ps1 -RunLevel Highest` (what the
reference host runs) every attach is elevated, and `launch-visible.ps1` opens
it with `-Verb RunAs` (UAC may prompt); a non-elevated `claude agents` then
prints `[]`, which is expected, not a dead bot. `smoke.ps1`'s `bg-agents` step
reports that case instead of failing. With the default `RunLevel Limited` a
normal shell should reach the pipe; this is not yet verified on a real host
(`docs/host-service.md`).

**What the supervisor does on its own.** It restarts a worker that exits
unexpectedly, keeps a working / blocked / attached process running, and stops
a finished, unattached process after about an hour (the roster row stays). The
tick reads a row without a live pid and outside `working`/`blocked` as dead
and relaunches with `--resume`, so the conversation survives either way.

**bg sessions and the daemon's env.** The supervisor (`claude daemon run`,
one per config home: `<config home>/daemon.lock` names its pid, `daemon.log`
its starts and stops) is started by the first `claude --bg` client and spawns
EVERY worker with that client's environment. A later client's environment
never reaches its session: probed on Claude Code 2.1.282, a session started
through an already-running daemon carried the first client's
`BOT_LAUNCHER_PID` and none of the new launcher's variables, so the
`TELEGRAM_BOT_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` the launcher had just read
from the vault were not there; the plugin printed `telegram channel:
TELEGRAM_BOT_TOKEN required` into its MCP log and exited before writing
`bot.pid` (no bun child, statusline TG red). The daemon exits 5 s after its
last worker and client are gone, so a stale one is alive only while another
session of the bot (a copy, an unrecorded earlier launch) or an attached
client holds it. Hence, before `claude --bg`, `launch.ps1 -Bg`:

- no live daemon -> the launch's own `claude --bg` starts one with the
  launch's env (the vault tokens stay in process memory, never on disk);
- a live daemon with no live session -> `claude daemon stop --any`, then the
  launch starts a fresh one (`bg: daemon pid <n> ... had no live session ->
  stopped` in `launches.log`);
- a live daemon WITH live sessions (after a 10 s settle wait) -> left alone
  and a `WARN ... inherits the DAEMON's env` line; `botcorp stop <bot>` stops
  every session in the bot's config home (whatever its cwd: the roster is per
  config home), after which the daemon exits and the next start is clean.

**Which env a session actually got.** Claude Code strips
`CLAUDE_CODE_OAUTH_TOKEN` from its hooks' environment (a `claude -p` run on a
token got a 401 from the API while its SessionStart hook saw no such
variable), so a session cannot report its OAuth token. It can report
`BOT_LAUNCHER_PID` and the Telegram token: the `session-env` SessionStart hook
writes their last 4 characters to `<config home>/botcorp/session-env.json`,
keyed by session id. Every launch writes what it injected (OAuth last 4 and
its source `vault` / `inherited` / `none`, Telegram last 4) to
`<config home>/botcorp/launch-env.json`, keyed by its pid. The session's
launcher pid names the env block it came from, so that launch's row is the
OAuth token the session runs on. `launch.ps1 -Bg` logs `env: OK` (this
launch's env), `STALE` (an earlier launch's: it started the daemon), `FOREIGN`
(no `BOT_LAUNCHER_PID`: the daemon was started by some other `claude` client)
or `UNKNOWN`; `botcorp status` prints an `env:` line and `botcorp doctor` a
`<bot>: session env` check that FAILs when the OAuth token came from the
environment or differs from the vault, when the Telegram token is missing or
differs although the launch passed `--channels`, or when the env is FOREIGN.

Not a way round it: the per-session dispatch record the daemon keeps
(`<config home>/daemon/roster.json` `workers.<id>.dispatch.env`, mirrored in
`jobs/<id>/state.json` `providerEnv`) forwards only a fixed allowlist of
provider / model routing variables from the client (`CLAUDE_CONFIG_DIR`,
`ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`,
`CLAUDE_CODE_SUBAGENT_MODEL`, `CLAUDE_CODE_USE_BEDROCK` / `_VERTEX`,
`AWS_REGION`, `CLOUD_ML_REGION` were seen); `TELEGRAM_BOT_TOKEN`,
`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `HTTPS_PROXY` and any
`BOT_*` are dropped. `session-env/<session id>/` is the `CLAUDE_ENV_FILE`
directory SessionStart hooks may write `VAR=value` lines into for the Bash
tool; it is empty for our sessions and never reaches an MCP server.

The plugin's stderr lands in `%LOCALAPPDATA%\claude-cli-nodejs\Cache\<bot home
slug>\mcp-logs-plugin-telegram-telegram\<start time>.jsonl` (outside the config
home), and in the session's debug log when `harness.debug` / `botcorp start
--debug` is on (`<config home>/debug/`).

After the launch it waits up to 30 s for the poller (`bot.pid` alive under
the new claude) and records `poller: OWNED` or `DEAD` in `state/<bot>.json`.
With `harness.telegram_token_file: true` the ACL'd `channels/telegram/.env` is
written just before the launch and deleted right after that wait (or on any
failure path; a foreground launch deletes it from a background job, and at
session exit at the latest), with a
`telegram: token file deleted ...` line; it is never left at rest.

## The two tasks

| Task | Principal | Triggers | Action |
|---|---|---|---|
| `BotCorp-Daemon` | the user, **LogonType Password** ("run whether user is logged on or not"; `-LogonType S4U` = fallback with no stored password), RunLevel Limited (`-RunLevel Highest` optional) | **At Startup** + every `-IntervalMinutes` (3); `MultipleInstances IgnoreNew`; 5 min time limit | `wscript.exe <rt>/daemon-hidden.vbs //B //Nologo` -> `pwsh -File daemon/tick.ps1` |
| `BotCorp-Launch` | Interactive, Limited | none (started by the tick) | `pwsh -File daemon/launch-visible.ps1` |

Why Password: it fires at the login screen after an unattended reboot AND is a
full logon (profile loaded, user-scope DPAPI unambiguous), which is what the
reference host proved across a power cut. S4U fires there too but loads no
profile, stores no password and "has no access to the network or encrypted
files" (Microsoft), and a probe on this project's build box never got a script
to run under it (`docs/cc-compat.md` vii); it stays available for a host where
no password may be stored, and the tick still pins
`USERPROFILE`/`LOCALAPPDATA`/`APPDATA`/`PATH` from `state/install.json` when it
detects the profile is not loaded. Both run in session 0: no desktop, so a
bg bot is attached to, never shown, and a pty bot's task-initiated launch is
hidden (the tick hands that launch to `BotCorp-Launch` whenever `explorer.exe`
shows a logged-in user, and migrates a hidden session-0 pty bot to the visible
path, idle-gated, when the user logs in later).

The VBS shim exists because a task that runs `pwsh.exe` directly flashes a
console every tick. It resolves `pwsh` at runtime (`%LOCALAPPDATA%` alias,
then the alias path captured at install, then PATH); a versioned path breaks
on every PowerShell update.

`install.ps1` prompts for the account password (or takes `-Password
<SecureString>`), self-elevates (`Start-Process -Verb RunAs`; the password
crosses to the elevated run through a DPAPI-protected one-shot file, never
argv), warns about, and never deletes, any other task named `*Bot*`
(`botcorp doctor` fails while one exists), and `-Unregister` removes both
tasks. It also sets the checkout's repo-local git identity
(`-GitUser`/`-GitEmail`, a noreply placeholder by default) and
`core.hooksPath .githooks`. Re-run it after the account password changes.

## The tick

```
mutex Global\BotCorpDaemon (another tick holds it -> exit 0)
machine steps
  cockpit keepalive     GET /healthz; down -> hidden `node cockpit/server.mjs`; capped 3 starts / 30 min;
                        LOOPBACK-ONLY unless <rt>/access.json exists (integrations.access), whatever cockpit.json's bind says
  otel-sink keepalive   if daemon/otel-sink.mjs exists and state/otel.json's pid is gone
  update check          hourly: daemon/update.ps1 -Check (records releases + What/Why/Value; never applies, never messages)
  update apply          only a release with status apply_requested (admin action via CLI/cockpit), and only when
                        EVERY bot is at a safe point (fresh breakpoint marker or idle per Test-SessionBusy);
                        update.ps1 -Apply -Tag <tag>; success -> every live bot restarts this tick (idle-gated)
per bot (bots/*/bot.yaml, folders starting with `_` skipped), each in its own try/catch
  config                node daemon/botyaml.mjs -> JSON; `_modules` gates every module tick; harness.session picks the kind
  liveness              bg : claude agents --json (bot config home) row by bg_id / session_id / cwd with a live pid
                             or state working|blocked, OR state.claude_pid alive as claude
                        pty: state.shell_pid alive as pwsh/powershell WITH a claude.exe child, OR state.claude_pid alive
  poller probe          telegram module only, only while alive:
                        python tools/v2/tg_watchdog.py --config-dir <config> --probe-only [--claude-pid N]
  decision              not alive              -> cold-start   (unless state/<bot>.paused or harness.service: manual)
                        alive + DEAD / STOLEN  -> restart      (idle-gated)
                        else                   -> none
  guards                session-0 stray sweep; launcher grace (LauncherGraceMin 4) / hung-launcher tree kill;
                        hidden session-0 pty bot + logged-in user -> restart into the visible path (idle-gated)
  isolated ticks        usage_resume: usage_monitor.py --resume-check (exit 10 -> relaunch, idle-gated)
                        alert_triage: alert_triage.py scan [--session-busy] every BOT_TRIAGE_EVERY_MIN (30)
                        breakpoint roll (action none): marker fresh -> update_restart.py --auto --claude-pid N
                        board: gh_projects.py poll -> tg_send.py per queued card
                        hub:   tools/infra/hub_push.py when present
                        janitor: tools/infra/resource_monitor.ps1 -Clean once a day per bot
                        automations: daemon/automations.ps1 -Bot <name> (always)
  act                   start cap: MaxStartsPerWindow (3) ACTION=START lines per WindowMin (30) in logs/<bot>/daemon.log
                        restart:    busy -> deferred; else spawn restart.ps1 -Bot -OldPid -OldShellPid, then
                                    bg: claude stop <id> (+ guarded kill if it lingers) / pty: Stop-Process claude (if ours)
                        cold-start: kill an orphan launcher shell (TOCTOU re-check, guarded), kill the bot.pid holder
                                    (bun/node, name-guarded, guarded), pty-host --stop a stale record, then
                                    bg: launch.ps1 -Bg (bounded) / pty: session 0 + logged-in user -> BotCorp-Launch task, else pty-host --continue
```

The process record is authoritative over the poller probe: a poller that
still answers 409 after the session died is an orphan and must never mask a
dead bot. Nothing in the tick holds the mutex across an unbounded call: every
child runs through `Invoke-Bounded` (hard timeout, tree kill), long work
(triage, automations) is spawned detached with its own waiter.

**Ownership guard (every kill).** `Stop-BotProcessTree` (and the two
`Stop-Process` sites in the tick and restart.ps1) call
`Get-ProcessOwnerRecord` first. A pid is ours only if it is recorded in
`state/<bot>.json` (`claude_pid`, `shell_pid`, `launcher_pid`) or
`state/<bot>.pty.json` (`pid`, `ptyPid`) for any bot, in `state/daemon.json`
(`cockpit_pid`) / `state/otel.json` (`pid`), or its command line names
`<BotCorp>\bots\<name>` for a bot that exists. Anything else is logged as
`SKIP not ours: <pid> <name> (<reason>) [<why>] <command line head>` and left
alone; so is anything matching `<rt>/protect.json` (`{"pids":[...],
"patterns":[regex...]}`, operator-maintained: `SKIP protected`). A daemon once
killed a process that merely looked like a launcher; this is why.

**Idle gate (`Test-SessionBusy`).** Busy = defer. Idle when the bot's
`.claude/.botcorp_breakpoint` is younger than `BOT_BREAKPOINT_TTL_MIN` (30),
else when the newest `*.jsonl` under `<config>/projects/<slug>/` (RECURSIVE:
subagents write under `<session>/subagents/**`) is quiet for 5 min, where
slug = the bot folder with every non-alphanumeric character replaced by `-`,
exactly as Claude Code derives it. Unsure (no dir, no transcript, any error)
= busy. Killing a busy session throws away in-flight context, which is worse
than any late heal.

**Fresh marker (restart.ps1).** A `.botcorp_fresh_restart` younger than 300 s
is honoured and re-touched (the launcher's window then counts from the
launch); a stale one is deleted; none = the same conversation (`--resume
<session_id>` for bg, `--continue` for pty). The daemon's own restart path
never creates one, so a heal always keeps the running context; only a roll
the bot declared itself starts fresh. `restart.ps1 -DryRun` prints `START
FRESH`, `--continue` or `--resume <id>`. `restart.ps1 -OldPid 0` is refused
(pid 0 is the System Idle Process and reads alive forever).

**Stop paths.** bg: `claude stop <id>` then the guarded tree-kill on the
recorded claude pid (`Stop-BgSession`). pty: `node daemon/pty-host.mjs --stop
<bot>` (`taskkill /T /F` on the pty root, then the host); `Stop-Process` on
the shell alone leaves `claude.exe` and the Telegram poller as orphans holding
the getUpdates slot, and the plugin's own stale-holder kill needs `ps`, which
does not exist on Windows. `pty-host --stop` on an attach-mode host kills only
the attach client, never the session.

## Environment every tool call gets

`BOT_HOME`, `BOT_NAME`, `BOT_MODULES`, `BOTCORP_HOME`, `BOTCORP_ROOT`,
`CLAUDE_CONFIG_DIR` (= `bots/<name>/.claude-<name>`), `CLAUDE_PLUGIN_ROOT`,
`PYTHONIOENCODING=utf-8`, `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`.
Python is resolved at runtime in this order: `BOT_PYTHON` (when set and it
exists) > the `py` launcher (`py -3 -c "import sys; print(sys.executable)"`) >
the `HKCU`/`HKLM` `Python\PythonCore` registry (newest version) >
`%LOCALAPPDATA%\Programs\Python\Python3*` (newest) > PATH. Claude Code is
`~/.local/bin/claude.exe` first, then PATH (a stale npm shim has shadowed the
native install before). System binaries (`powershell.exe`, `taskkill.exe`,
`icacls.exe`, `wscript.exe`) are always spawned by their absolute
`%SystemRoot%\System32` path, never a bare name - session-0 PATH is
unreliable and bare names have failed to spawn there.

Headless utility spawns (triage, debrief) use `Get-ClaudeHeadlessArgv`: `-p
--setting-sources user --dangerously-skip-permissions [--model M]
[--plugin-dir <harness>]`, prompt on stdin. There is deliberately no `--bare`:
it never reads OAuth (`docs/cc-compat.md` viii), so a token-authenticated bot
cannot use it.

Knobs: `BOT_BREAKPOINT_TTL_MIN` (30), `BOT_TRIAGE_EVERY_MIN` (30) and the
other `BOT_TRIAGE_*` read by `alert_triage.py`, `tick.ps1 -MaxStartsPerWindow
-WindowMin -LauncherGraceMin`, `install.ps1 -IntervalMinutes -LogonType
-RunLevel`.

Test seam: `BOTCORP_FAKE_NOW=<ISO>` overrides "now" for scheduling decisions
only (automations due/next_due, the account block check). Log stamps, process
ages and file mtimes stay real, so it can never make a live process look dead.
`BOTCORP_PTY_COMMAND` is pty-host's own seam (runs a command instead of
launch.ps1).

## Harness update (admin-applied, never automatic)

`update.ps1 -Check` (hourly from the tick) does a bounded `git fetch --tags`
(45 s, no credential prompts) and records EVERY `v*` tag on `origin/main`
newer than HEAD as a release in `state/updates.json`, with plain-language
notes read from that tag's own `CHANGELOG.md` section (`## <tag>` up to the
next `## `): bullets under `What` / `Why` / `Value` headings when present,
else the first three bullets become What and why/value read "see changelog".
An existing entry keeps its status; a tag HEAD has reached becomes `applied`.
It never applies and never messages; the operator sees the releases with
their notes in the cockpit and the weekly digest and presses **Apply** or
**Skip** there (`update.ps1 -Request -Tag <tag>` / `-Skip -Tag <tag>`
underneath). Not a git checkout -> `not a git checkout`, exit 0.

The tick applies a release only when its status is `apply_requested` AND
every bot is at a safe point (fresh breakpoint, or idle per `Test-SessionBusy`;
a bot that is not running is trivially safe): `update.ps1 -Apply -Tag <tag>`,
bounded to 3 minutes: refuse on a dirty tree (status `failed`, reason `dirty
tree`); `git checkout --detach <tag>`; `smoke.ps1`; pass -> `state/harness.json`,
`harness/migrations/NNN-*.ps1` newer than the recorded schema, `node
daemon/sync.mjs <bot>` for every bot, status `applied`, the cockpit restarted
onto the new code and `/healthz` polled; then every live bot restarts through
the normal (idle-gated) restart path, resuming its conversation on the new
harness. Fail -> `git checkout --detach <from>`, status `failed` with the
smoke tail, a Ready card `HARNESS UPDATE FAILED <tag>` for every bot whose
`board` module is on, else a `HUMAN:` line in `<BotHome>/memory/metrics/alerts.log`.
`launch.ps1` no longer applies anything.

## Smoke test

`smoke.ps1 [-Bot <name>]`: `claude plugin validate harness --strict`; `python
-m pytest harness/tests -q` (must collect > 0: zero collected reads green and
is a suite error); `bash -n` on every hook; `node --check` on statusline.js,
pty-host.mjs, cockpit/server.mjs, sync.mjs, botyaml.mjs; fake-stdin runs of
`session-start.sh` and `session-end.sh` against a throwaway `BOT_HOME`;
`tick.ps1 -ProbeOnly`; `bg-agents` (`claude agents --json` parses: REPORT
only, since a non-elevated shell against an elevated supervisor legitimately
sees `[]`); with `-Bot`, `launch.ps1 -Bot <name> -DryRun`. Exit 1 names the
failing step. `BOT_TG_MUTE=1` on every child.

## Running it by hand

```
pwsh -File daemon/tick.ps1 -ProbeOnly        # state lines only, no writes
pwsh -File daemon/tick.ps1 -DryRun           # decisions logged, nothing launched
pwsh -File daemon/tick.ps1                   # act (what the task does)
pwsh -File daemon/launch.ps1 -Bot x -Bg -DryRun     # the exact claude --bg argv, secrets masked
pwsh -File daemon/restart.ps1 -Bot x -OldPid <claude pid> -DryRun
pwsh -File daemon/update.ps1 -Check
pwsh -File daemon/update.ps1 -Request -Tag v1.2.0   # admin: apply at the next safe point
pwsh -File daemon/update.ps1 -ParseChangelog CHANGELOG.md -Tag v1.2.0   # what the notes will say
pwsh -File daemon/smoke.ps1 -Bot x
pwsh -File daemon/install.ps1 [-Unregister]
claude attach <bg id>                        # with the daemon's elevation; CLAUDE_CONFIG_DIR = the bot's config home
```

The logs answer "why did it (not) act": `daemon.log` for the machine,
`logs/<bot>/daemon.log` for one bot (`ACTION=START` lines are the start cap's
input; `state:` lines are the liveness sample with `bg=<id> roster=<state>`;
`DEFERRED` lines name the gate; `SKIP not ours` / `SKIP protected` name a
kill the guard refused).
