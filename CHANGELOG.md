# Changelog

All notable changes to BotCorp. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versions follow SemVer.

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
