# How the daemon runs on the host (the service model)

Decision record for the question "what keeps a bot alive on a Windows box
that reboots without anyone logging in?". Judged on six things: **boot before
login**, **user profile + DPAPI** (the vault is user-scope DPAPI), **crash
restart**, **session-0 limits**, **install friction**, and **remote visibility
of the running session** (can an operator see and type into the conversation
from another machine). Sources at the end; dated facts are from this project's
own probes.

## Verdict (implemented)

1. **`BotCorp-Daemon` is a Scheduled Task running as the user with
   LogonType Password** ("run whether user is logged on or not", the password
   stored by the Task Scheduler), triggers At Startup + every N minutes,
   RunLevel Limited by default. `install.ps1` registers it; `-LogonType S4U`
   keeps the no-stored-password model as the documented fallback.
2. **The bot process is a Claude Code background session** (`claude --bg ...
   --channels ... LAST`) started by the tick through `launch.ps1 -Bg`, resumed
   by session id on every restart (`--resume <session id>`, one conversation),
   supervised by Claude Code's own per-user supervisor in session 0; the tick
   checks it with `claude agents --json` and stops it with `claude stop <id>`.
3. **Operators attach with `claude attach <id>`** (the `BotCorp-Launch` task
   opens that window; the cockpit uses `pty-host --attach` as its transport).
   Both must run with the daemon's elevation: the supervisor pipe answers only
   callers with the same token, so `RunLevel Highest` forces elevated attaches.

### Facts from the reference host (2026-09-24)

- The user environment carries a machine-wide `CLAUDE_CODE_OAUTH_TOKEN` (the
  first bot's account). Every bot launches with its own vault token:
  `launch.ps1` takes the vault first and only inherits the environment when
  the vault has no entry; `botcorp doctor` compares the last 4 characters and
  FAILs on a match.
- Each bot runs under its own `CLAUDE_CONFIG_DIR`
  (`bots/<name>/.claude-<name>`); the Telegram plugin keeps one token per
  config home.
- The background-session daemon pipe is admin-only: `claude attach` runs
  elevated (`BotCorp-Launch` opens it through `wt.exe` with the daemon's
  RunLevel); a non-elevated `claude agents` lists nothing, which is expected.
- The generated `settings.json` sets `worktree.bgIsolation: none`: a `--bg`
  session must run in the bot folder, not an isolated worktree.
- agent-browser must use one pinned, seeded Chrome profile per bot; fresh
  profiles on every run locked the Windows account on 2026-09-23.
- Windows Update can reboot the box while nobody is logged in; the At
  Startup trigger brings the daemon and the bots back (`docs/host-setup.md`
  section 2 sets active hours / no-auto-restart-with-users; it cannot stop an
  unattended restart, so a reboot is a normal event, not an incident).
- Toolchain on the reference host: pwsh 7.6.6, node 25.2.1, python 3.14.2,
  claude 2.1.282 (2.1.281 at the first install; nothing pins a version,
  `botcorp.json.minClaudeCode` is the only floor).
- From a Scheduled Task the shell's PATH is not the user's: bare
  `powershell`, `python` and `curl.exe` spawned ENOENT there. Everything now
  resolves system binaries absolutely (`docs/cli.md` → `doctor`).
- The reference host runs a second, independent bot supervisor whose
  Scheduled Tasks are also named `*Bot*`; its `<BOTCORP_HOME>/host.json`
  allowlists that prefix in `coexist_tasks`, so `doctor` reports them as
  INFO instead of WARN.

Nothing in the survey below is strictly better on the six axes, so the
reference host's proven model stands.

## The evidence that decided it

- **The reference host runs exactly this and survived a reboot test**
  (2026-09-24): daemon task as the user, LogonType Password, At Startup +
  every 3 min; the bot as `claude --bg --resume <id> --dangerously-skip-permissions
  --channels plugin:telegram@...` (`--channels` last); auth from the user env
  `CLAUDE_CODE_OAUTH_TOKEN`; power cut, BIOS power-on, bot up one minute after
  boot with nobody logged in; logging in or out did not affect it. The same
  host showed that a non-elevated `claude agents` sees nothing when the
  supervisor was started elevated, so its attach runs elevated.
- **S4U could not even run a probe script on this project's build box**
  (`docs/cc-compat.md` row vii, 2026-09-24): a throwaway S4U task was tried
  with three action shapes and produced no output at all. Whatever the cause,
  a model that cannot be debugged from the outside is not the default.
- **Microsoft's definition of S4U**: "When an S4U logon is used, no password
  is stored by the system and there is no access to either the network or
  encrypted files." (Principal.LogonType, TASK_LOGON_S4U). The user profile is
  not loaded either, which is why the old tick had to pin
  `USERPROFILE`/`LOCALAPPDATA` from `install.json`.
- **DPAPI under S4U is contested, and the safe reading is "do not rely on
  it"**: this project's own S4U DPAPI probe decrypted CurrentUser blobs
  (plan assumptions, 2026-09-24), while another project's fleet probe found
  "user-scope DPAPI fails under S4U and works under a stored-password logon"
  (agent_persona PR #68) and Tavis Ormandy traced years of "things signing
  out or losing state" to that same checkbox. A Password logon is a full
  logon: profile loaded, DPAPI unambiguous.

## The alternatives, on the six axes

| Model | Boot before login | Profile + DPAPI | Crash restart | Session 0 | Install friction | Remote visibility |
|---|---|---|---|---|---|---|
| **Task, LogonType Password (chosen)** | yes (At Startup) | full logon: profile + user DPAPI | the tick relaunches; Claude Code's supervisor also restarts a crashed worker ("Exited unexpectedly while the supervisor is running: the supervisor restarts the process") | yes: no desktop, no clipboard, no screen capture; the bot is seen via `claude attach` | admin once to register; the password is stored by the Task Scheduler and must be re-entered when it changes | `claude attach <id>` from any shell with the daemon's elevation, RDP or local |
| Task, LogonType S4U (fallback) | yes | no profile loaded; no stored password; DPAPI contested (see above); "no access to the network or encrypted files" per Microsoft | same tick | same | admin once; no password stored (the one advantage) | same, once the pipe elevation matches |
| Task, Interactive logon | no: "User must already be logged on. The task will be run only in an existing interactive session." | yes | same | none: a real desktop | none | a window on the desktop |
| Windows service via WinSW / shawl / servy, running as the user | yes (Automatic start) | the SCM "automatically loads the user profile" of a service account; DPAPI works for that account; needs "Log on as a service" | the wrapper restarts on failure (WinSW `onfailure`, shawl `--restart`, servy monitoring) | yes, and stricter: a service token cannot interact with the desktop at all | a third-party binary + XML/CLI config + the account password in the SCM; `sc config` for the account | only if the wrapped program exposes its own channel; `claude --bg` under a service would need the supervisor pipe reachable from the operator's token (unverified) |
| Virtual service account (`NT SERVICE\<name>`) or gMSA | yes | its own profile, not the operator's: the vault (user-scope DPAPI of the operator) would have to be re-keyed; the OAuth token would live in that account | wrapper-dependent | yes | gMSA needs a domain; virtual accounts are local-only and "can't be used on a Domain Controller due to DPAPI issues" | none of the operator's sessions can see it without extra plumbing |
| Claude Code `claude --bg` alone (no task) | no: the supervisor is started on demand by a user command and does not survive a reboot on its own ("Claude Code starts it the first time you background a session") | n/a | the supervisor restarts a crashed worker and stops an idle unattached one after about an hour | runs wherever it was started | none | `claude attach` |

What the `--bg` row adds to the task row, and why the two are combined
rather than either alone: the supervisor gives a *restart of the same
conversation* and a *remote attach* for free (`claude agents --json` lists
`id`, `sessionId`, `pid`, `state`, `status`; `--resume <session id>` "either
continues that session under the same ID, or starts a copy under a new ID and
prints a `note:`", so the daemon records the id it is given), while the task
gives the *boot before login* the supervisor lacks and the *liveness loop* that
re-creates the supervisor after a reboot. The supervisor's "stop an idle,
unattached process after about an hour" rule is the one behaviour to watch: a
bot with a Telegram channel is never "waiting for your next message" from the
supervisor's point of view while the plugin keeps the session busy, and the
tick treats a roster row whose process is gone and whose state is not
`working`/`blocked` as dead and relaunches with `--resume`.

## What is verified and what is not

- Verified on the reference host: Password task + `--bg --resume` across a
  reboot; the admin-only pipe under an elevated supervisor.
- Verified on the build box (2026-09-24): `claude agents --json` output shape
  (`pid`, `cwd`, `kind`, `startedAt`, `sessionId`, `name`, `status`), the roster
  being per user rather than per config home, `--help` text for `--bg`,
  `attach`, `stop`.
- NOT verified: that a `RunLevel Limited` Password task yields a supervisor
  pipe reachable from a normal (non-elevated) shell. The reference host ran
  Highest. `install.ps1` records `run_level` in `install.json` and
  `launch-visible.ps1` elevates the attach when it is Highest; if Limited turns
  out to need elevation too, set `-RunLevel Highest` and the rest follows.
- NOT verified: `claude --bg` under an S4U task (cc-compat vii never ran the
  script at all).

## Sources

- Claude Code CLI reference, `--bg`, `attach`, `logs`, `stop`, `rm`, `agents --json`, `daemon status`: https://code.claude.com/docs/en/cli-reference
- Claude Code agent view: supervisor lifecycle, idle stop after about an hour, `--bg --resume` semantics, `agents --json` fields: https://code.claude.com/docs/en/agent-view
- Microsoft, Principal.LogonType (TASK_LOGON_PASSWORD / S4U / INTERACTIVE_TOKEN definitions): https://learn.microsoft.com/en-us/windows/win32/taskschd/principal-logontype
- Microsoft, Service User Accounts (the SCM loads the profile, password handling, special accounts): https://learn.microsoft.com/en-us/windows/win32/services/service-user-accounts
- S4U vs stored password and user-scope DPAPI, a fleet probe (agent_persona PR #68): https://github.com/SApplefeld/agent_persona/pull/68
- Tavis Ormandy on the S4U "do not store password" checkbox and lost state: https://x.com/taviso/status/1310619805301399557
- WinSW v3 (service wrapper, service account, `onfailure`): https://winsw.github.io/v3/
- shawl (Rust service wrapper, restart policy, account via `sc config`): https://github.com/mtkennerly/shawl
- servy (service wrapper with monitoring; account restrictions on restart actions): https://github.com/aelassas/servy
- Virtual accounts / gMSA limits (Entra Connect service account notes): https://learn.microsoft.com/en-us/entra/identity/hybrid/connect/concept-adsync-service-account
- Session 0 isolation (no desktop, clipboard or input; UI0Detect removed): https://www.firedaemon.com/post/microsoft-windows-interactive-services-and-session-0-isolation
