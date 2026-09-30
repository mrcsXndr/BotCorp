# Engine contract — what's shared, what's yours, how changes flow

One BotCorp checkout runs every bot on a machine. The load-bearing invariant:
**every bot runs the same harness, but no bot's individuality lives in a file
BotCorp tracks.** That is what makes `git pull`/`botcorp update` safe for
every bot at once, and what makes a bot's own state safe from being
overwritten by one. Violating it in either direction either gets a bot's
state clobbered by the next update, or leaks one bot's private state into
this public repo.

## The three zones

| Zone | Paths | Tracked by this repo? | Who writes it |
|---|---|---|---|
| **BOTCORP (tracked, read-only to every bot)** | everything at the repo root not listed below — `harness/`, `cockpit/`, `daemon/`, `cli/`, `templates/`, `docs/`, `scripts/`, `.github/`, `bots/README.md`, `bots/_example/`, `bots/_canary/bot.yaml` | YES | upstream only, via a merged `suggest/*` PR (`docs/improvement-cycle.md`) |
| **`bots/<name>/`** (a bot's own soul) | `bot.yaml`, `CLAUDE.md`, `memory/`, the bot's own `tools/`, `.claude/{rules,agents,skills,settings.local.json}` | NO (`bots/*` is whitelist-ignored — only `README.md`, `_example/` and `_canary/bot.yaml` are re-included) | that bot, freely |
| **RUNTIME** | `bots/<name>/.claude-<name>/` (Claude Code's own config home), `bots/<name>/.vault/` (DPAPI secrets), `~/.botcorp/` (daemon state, logs, `access.json`, `tunnel.token`) | NO | the daemon, the CLI, and Claude Code itself |

`bots/<name>/.claude/settings.json` sits in the middle: it is **generated**
(`botcorp sync`, from `bot.yaml`) and carries a `_generated_by` header saying
so. Treat it like a build artifact, not a place to hand-edit — the next sync
overwrites it. `settings.local.json` next to it is never touched by sync and
is where a bot's own hooks/permissions live (Claude Code merges local over
project).

## Rules for every bot

1. **Treat BOTCORP files as read-only.** `botcorp update` may replace any
   tracked file at the next safe restart. Hand-editing one in place means
   your change is either lost at the next update, or silently blocks that
   update (see the dirty-tree refusal below) until you undo it.
2. **Everything that makes a bot itself goes under `bots/<name>/`.** New
   tools → the bot's own `tools/`; behavior changes → the bot's own
   `.claude/rules/` (instance rules can override an imported harness rule);
   scheduled work → `bot.yaml` `automations:`; knowledge → `memory/`. None of
   this is tracked by BotCorp, so an update can never touch it and it can
   never leak upstream.
3. **Want the harness itself changed?** That is the one path for a bot to
   change a tracked file: a `suggest/<topic>` branch, a commit containing
   ONLY the harness change (no bot files, no secrets — the pre-commit guard
   and CI back this up, but they are backstops, not the plan), a PR against
   this repo. **Merging is human-only** (branch protection,
   `enforce_admins` — see `docs/improvement-cycle.md`) — that is the trust
   anchor, since every bot eventually updates onto `main`.
4. **Git-backing a bot's memory is opt-in, and must never target the BotCorp
   origin.** A bot's folder is a plain gitignored directory, not a nested git
   repo, by default. The `backup.git_remote` module (`bot.yaml` `backup:
   {git_remote: <url>}`), off by default, is the path that versions
   `memory/` — and it always points at the bot's OWN remote, never at this
   repo. (The `memory_sync` module, also off by default, is the other one: on
   Stop it commits `memory/`, pulls with rebase and pushes to `origin main`
   whenever the bot folder is its own git repo whose origin is not BotCorp,
   whatever `backup` says.) Moving a bot between machines goes through `botcorp export` /
   `botcorp import` instead (vault excluded; tokens re-entered on the new
   box) — see `docs/adopt-existing-bot.md`.
5. **A pull conflicting with a local edit to a tracked file is the signal you
   broke rule 1.** Move the change into `bots/<name>/` (or a `suggest/*` PR),
   then `git checkout` the tracked file back to upstream.
6. **Never point a bot at the operator's own `~/.claude`.** Every bot gets
   its own `CLAUDE_CONFIG_DIR` at `bots/<name>/.claude-<name>/`
   (`daemon/launch.ps1` sets it); nothing a bot does should ever write to the
   real `~/.claude`.

## Modules

`bot.yaml` `harness.modules.<name>: true|false` switches a piece of the
harness on or off for one bot (`daemon/botyaml.mjs` DEFAULTS holds the list and
the defaults). The launcher turns the enabled ones into `BOT_MODULES`; a hook
gated on a module is skipped by `harness/hooks/run.mjs` before bash starts, and
the daemon tick runs a module's job only for bots that have it on.

| Module | Default | What it gates |
|---|---|---|
| `telegram` | off | the Telegram plugin at launch (`--channels`, the token), the tick's poller check and heal, the generated `channels/telegram/access.json`, the boot prompt. Written either way: `botcorp/telegram.json` (default chat, quiet hours) and the `tools/tg` shims; `user-prompt-submit` runs either way and acts only on a Telegram-tagged prompt |
| `board` | off | the GitHub Projects board poll on the tick |
| `cost_meter` | on | the `cost-meter` Stop hook (one `sessions.csv` row per session) |
| `usage_resume` | on | the tick's `usage_monitor.py warn` (one `alerts.log` line per 5h / 7d window at 98%) and `usage_monitor.py --resume-check`; the `stop-failure` and `notification` hooks |
| `alert_triage` | off | the tick's headless fix-or-card pass over `alerts.log` |
| `hub` | off | the tick's status push (`integrations.hub`) |
| `janitor` | on | the tick's hygiene pass (`report`: scan and log, touch nothing) |
| `lessons` | on | the lessons index in the session-start context |
| `debrief` | off | the `session-debrief` Stop hook (a headless run, real spend) |
| `auto_commit` | on | the `auto-commit` Stop hook |
| `memory_sync` | off | the `memory-sync` Stop hook |
| `sound` | off | the `play-sound` Stop hook |
| `telemetry` | on | the OpenTelemetry env at launch, the hub push's subagent rollup. `cost_meter` meters what the sink records, so with `telemetry` off it records nothing. The machine's OTel sink (`daemon/otel-sink.mjs`) is kept alive by the tick only while some bot has `telemetry` on |
| `review_board` | off | `review_board.py` and the board line in the session-start context |
| `auto_roll` | off | the tick's fresh restart at a declared breakpoint once the last-turn context passes `harness.roll_tokens` (`docs/daemon.md` "Auto-roll") |
| `context_warn` | off | one line the `user-prompt-submit` hook adds to the prompt when the last turn's context (the statusline's `status.json`) passes 90% of `harness.roll_tokens`: finish the step, update journal and TDL, declare a breakpoint; at most once per 30 min per session |
| `session_summarize` | on | the `session-summarize` Stop hook (a disk snapshot per turn in `memory/sessions/<stamp>.md`) |
| `timeline_summary` | off | the built-in `timeline-summary` automation: every 60 min, `timeline.py summarize-stale` with the vault `oauth_token` (real spend). It is the only timeline LLM distill (session timelines and the current week's roll-up): the `precompact-timeline` hook builds structurally either way |
| `backup` | `backup.git_remote` set | `botcorp backup` and the push in `auto-commit` |

A hook with no module (`-` in `hooks.json`) runs for every bot; any hook but
`vault-guard` and `operator-guard` can still be switched off by name with
`harness.hooks_disable` (the names are the `run.mjs` names in `hooks.json` plus
the tool guards).

Every hook run that starts (a `run.mjs` hook, or `guard.mjs pre|post` as
`guard-pre` / `guard-post`) appends `{ts, hook, ms, rc, timed_out?}` to
`<rt>/state/<bot>/hooks-timing.jsonl` (the last 2000 lines are kept once it
passes 256 KB). `run.mjs` stops a script 1 s before its `hooks.json` timeout
and records it as `timed_out`. `botcorp doctor` (`<bot>: hook timing`) and
`botcorp observe <bot>` report p50/p95 per hook over the last 24 h, WARN when a
p95 is over half that hook's timeout.

## Override precedence: harness vs. the bot's own

| Kind | Harness copy | Bot's own | Which one runs |
|---|---|---|---|
| Rules | `harness/rules/*.md`, `@`-imported by the bot's `CLAUDE.md` | `.claude/rules/*.md` | Both load; nothing merges them, the model reads both. A bot rule that changes a harness rule says so. To drop a harness rule, remove its `@` import. |
| Skills | `botcorp:<name>` (plugin) | `.claude/skills/<name>` | Both exist under different names. `harness.skills` (an allowlist) or `harness.disable: [skill:<name>]` hides the harness one (`disabledSkills`). A Telegram `/<name>` runs the bot's own first. |
| Agents | `botcorp:<name>` (plugin) | `.claude/agents/<name>.md` | Both exist; a bare `<name>` is the bot's. `harness.agents` (an allowlist) or `harness.disable: [agent:<name>]` denies `Agent(botcorp:<name>)`. |
| Tools | `harness/tools/<dir>/<file>` | `tools/<dir>/<file>` | `botcorp sync` writes a shim (first line `# botcorp-shim: generated by botcorp sync`) that runs the harness tool. A file without that line is the bot's own: sync never overwrites it, so the bot's wins. |
| Hooks | `harness/hooks/hooks.json` (plugin) | `.claude/settings.local.json` | Both run; Claude Code runs every matching hook. A harness hook is switched off by its module or `harness.hooks_disable`, never by the bot's settings (config-guard blocks an `env` or `disableAllHooks` edit). |

## Active tripwires (defense in depth)

- **Whitelist `.gitignore`** — `bots/*` then `!bots/README.md` /
  `!bots/_example/` / `!bots/_canary/bot.yaml` — a bot's state cannot be staged into this repo even by
  a careless `git add -A`.
- **`config-guard.sh`** (`PreToolUse` on `Edit|Write|MultiEdit|NotebookEdit`)
  — FAIL-CLOSED (exit 2): blocks a bot from directly editing its own
  `bot.yaml`, its generated `settings.json`, anything under `.vault/`, or its
  Telegram `access.json`. Those go through the guarded writers
  (`botcorp config set`, `botcorp secrets set`, the cockpit pairing panel)
  instead, so widening changes (new allow-listed sender, loosened policy, a
  new secret) can be gated on operator approval. An edit of
  `.claude/settings.local.json` or the config home's `settings.json` is
  blocked only when it changes `env` or `disableAllHooks` (either can switch
  the guards off); the bot's own hooks there stay editable.
- **`vault-guard.sh`** (`PreToolUse` on `Read|Glob|Grep|Bash|PowerShell|Monitor|mcp__*|Edit|Write|MultiEdit|NotebookEdit`; cannot be turned off with `hooks_disable`)
  — FAIL-CLOSED (exit 2): blocks any tool call that touches a bot vault
  (`.vault/`, any bot's — its own included), `secrets.ps1`/`vault.ps1`/
  `accounts.ps1`, the vault functions (`Get-VaultSecret`, `Read-VaultStore`, ...),
  the `ProtectedData` DPAPI API, the `secret-access.jsonl`
  audit log, the cockpit's `cockpit-approve-token` file, or the secrets CLI's mutating verbs (`botcorp secrets
  get|unlock|lock|import-bundle|export-bundle|migrate`); `secrets
  set|list|delete|audit` stay open since that's the operator flow.
- **`operator-guard.sh`** (`PreToolUse` on `Bash|PowerShell|Monitor|mcp__*`; cannot be
  turned off with `hooks_disable` either) — FAIL-CLOSED (exit 2): blocks the
  operator-only verbs in a command: `botcorp approve|reject`, `accounts
  add|remove|seed|use|backups`, `secrets set|delete`, `pair <bot> <id>`,
  `update --apply|--skip|--rollback|--cancel`, and `start|stop|restart` of
  another bot. An admin bot (`role: admin`, judged by `botcorp whoami` on the
  session's own env) passes those; `cockpit expose|unexpose|pair|unpair`,
  `accounts rename` and `accounts seed --link` stay blocked for every bot.
- All the tool guards run in ONE `node guard.mjs pre|post` process (exec-form
  hooks, 15 s timeout; the `.sh` names are thin wrappers for tests and doctor),
  and fail closed on a payload they cannot parse.
- **`core-guard.sh`** (`PostToolUse` on `Edit|Write|MultiEdit|NotebookEdit`) — warn-only: tells
  the bot the moment it edits a TRACKED harness file outside a `suggest/*`
  branch, before the divergence becomes a silent one.
- **pre-commit + CI secret scan** (`scripts/secret-scan.sh`) and
  **`scripts/debrand-lint.py`** — a credential or an identity string cannot
  land in a commit even if every guard above is bypassed.
- **`botcorp update` refuses on a dirty tree** — `git -C <BotCorp>
  status --porcelain` non-empty (someone hand-edited a tracked file) means
  the update is refused and carded rather than silently stomping or silently
  skipping the edit.

## Why whitelist-gitignore instead of trust

`bots/*` is ignored with explicit re-includes for the shipped example, the
README and the canary bot's `bot.yaml` only. So even a careless `git add -A` from inside a BotCorp checkout
cannot stage a bot's identity, memory, vault, or config home. If a future
change ships a new tracked file under `bots/`, it must be whitelisted in
`.gitignore` in the same `suggest/*` PR — otherwise no bot ever receives it.
