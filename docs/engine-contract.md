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
| **BOTCORP (tracked, read-only to every bot)** | everything at the repo root not listed below — `harness/`, `cockpit/`, `daemon/`, `cli/`, `templates/`, `docs/`, `scripts/`, `.github/`, `bots/README.md`, `bots/_example/` | YES | upstream only, via a merged `suggest/*` PR (`docs/improvement-cycle.md`) |
| **`bots/<name>/`** (a bot's own soul) | `bot.yaml`, `CLAUDE.md`, `memory/`, the bot's own `tools/`, `.claude/{rules,agents,skills,settings.local.json}` | NO (`bots/*` is whitelist-ignored — only `README.md` and `_example/` are re-included) | that bot, freely |
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
   {git_remote: <url>}`), off by default, is the only path that versions
   `memory/` — and it always points at the bot's OWN remote, never at this
   repo. Moving a bot between machines goes through `botcorp export` /
   `botcorp import` instead (vault excluded; tokens re-entered on the new
   box) — see `docs/adopt-existing-bot.md`.
5. **A pull conflicting with a local edit to a tracked file is the signal you
   broke rule 1.** Move the change into `bots/<name>/` (or a `suggest/*` PR),
   then `git checkout` the tracked file back to upstream.
6. **Never point a bot at the operator's own `~/.claude`.** Every bot gets
   its own `CLAUDE_CONFIG_DIR` at `bots/<name>/.claude-<name>/`
   (`daemon/launch.ps1` sets it); nothing a bot does should ever write to the
   real `~/.claude`.

## Active tripwires (defense in depth)

- **Whitelist `.gitignore`** — `bots/*` then `!bots/README.md` /
  `!bots/_example/` — a bot's state cannot be staged into this repo even by
  a careless `git add -A`.
- **`config-guard.sh`** (`PreToolUse` on `Edit|Write|MultiEdit|NotebookEdit`)
  — FAIL-CLOSED (exit 2): blocks a bot from directly editing its own
  `bot.yaml`, its generated `settings.json`, anything under `.vault/`, or its
  Telegram `access.json`. Those go through the guarded writers
  (`botcorp config set`, `botcorp secrets set`, the cockpit pairing panel)
  instead, so widening changes (new allow-listed sender, loosened policy, a
  new secret) can be gated on operator approval.
- **`vault-guard.sh`** (`PreToolUse` on `Read|Glob|Grep|Bash|Edit|Write|MultiEdit|NotebookEdit`)
  — FAIL-CLOSED (exit 2): blocks any tool call that touches a bot vault
  (`.vault/`, any bot's — its own included), `secrets.ps1`/`vault.ps1`/
  `accounts.ps1`, the `ProtectedData` DPAPI API, the `secret-access.jsonl`
  audit log, or the secrets CLI's mutating verbs (`botcorp secrets
  get|unlock|lock|import-bundle|export-bundle|migrate`); `secrets
  set|list|delete|audit` stay open since that's the operator flow.
- **`core-guard.sh`** (`PostToolUse` on the same matcher) — warn-only: tells
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

`bots/*` is ignored with explicit re-includes for the shipped example and
README only. So even a careless `git add -A` from inside a BotCorp checkout
cannot stage a bot's identity, memory, vault, or config home. If a future
change ships a new tracked file under `bots/`, it must be whitelisted in
`.gitignore` in the same `suggest/*` PR — otherwise no bot ever receives it.
