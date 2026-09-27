# Adopting an existing bot into BotCorp

Checklist for moving a hand-grown, v2-pattern bot (its own hooks, three-
channel memory, supervisor scripts) into `bots/<name>/` under this BotCorp
checkout. The harness becomes shared machinery under `harness/`; everything
that makes the bot itself moves into `bots/<name>/` — its `bot.yaml`,
`CLAUDE.md`, `memory/`, and any bot-specific rules/tools.

**Model:** `botcorp adopt <path> --as <name>` COPIES the existing folder into
`bots/<name>/` (the source is left untouched; its `.git`, `.vault`, config
homes, `.env*` and token files stay behind), deletes the copies that are
byte-identical to a shared harness file, and generates `bot.yaml` from the old
`.claude/settings.json` only. It never edits the bot's own application code,
its rules or its scheduled ticks: converting rules into harness imports and
old supervisor ticks into `automations:` entries is yours to do by hand after
the copy. Like any bot, the result is a
plain gitignored folder, not a nested git repo — if you want the old bot's
memory versioned going forward, turn on the `backup.git_remote` module
(`docs/engine-contract.md`) rather than keeping an ad hoc repo around. Moving
an already-adopted bot to another machine later is `botcorp export <bot>` /
`botcorp import <zip>` (vault excluded, tokens re-entered), not `adopt`
again.

## Always dry-run first

```powershell
node cli/botcorp.mjs adopt C:\path\to\old-bot --as mybot --dry-run
```

This prints the plan without touching anything: what is copied and what is
left behind (top level), each file that duplicates a harness file
(`identical` = deleted after the copy, `differs` = kept), the `bot.yaml` it
would generate, the old `settings.json` hooks (harness vs bot-own), and the
NAMES of the keys in the old `.env` with where each belongs (never a value).
Confirm before the real run:

- [ ] `memory/` is copied wholesale.
- [ ] No token is carried over (see below — none is migrated).
- [ ] The rules you plan to keep vs. fold into imports (by hand, after the
      copy) match what you expect for a bot with genuinely bot-specific
      behaviour beyond the shared harness rules (`coding`, `security`,
      `memory-loop`, `session-lifecycle`, `task-board`, `telegram`, `browser`,
      `tools` are all importable from `harness/rules/`; only the bot-specific
      remainder is worth keeping).

## What `adopt` does for real

1. **Copies the folder** to `bots/<name>/`, refusing if that exists. `.git`
   (the history stays in the source), `.vault`, `.claude-*` config homes,
   `node_modules`, `.env*`, `*.oauth_token`, `token.json`,
   `credentials.json`, `channels/telegram/.env` and the old
   `.claude/settings.json` are left behind.
2. **Deletes harness duplicates**: a file under `.claude/hooks`, `tools`,
   `.claude/agents`, `.claude/rules`, `.claude/skills` or `.claude/commands`
   that is byte-identical to its `harness/` counterpart is removed; one that
   differs is kept and listed.
3. **Writes `bot.yaml`** (only when the bot has none) with `name`, the default
   `persona`, and `model`, `effort`, `permissions` read from the old
   `.claude/settings.json`, plus `harness.modules.telegram` (on when a
   `tg-enable.settings.json` exists). Nothing else is inferred: other modules
   and `automations:` are yours to add.
4. **Moves bot-specific hooks to `settings.local.json`**: the old
   `settings.json` hook entries whose script is not a harness file are
   written there (only when it has no `hooks` yet), never into the generated
   `settings.json` — see `docs/engine-contract.md` — so a future
   `botcorp sync` can't silently drop them.
5. **Syncs** and seeds `<config home>/.claude.json`.
6. **Copies only the Telegram allow-list**
   (`channels/telegram/access.json`) into the bot's new
   `.claude-<name>/channels/telegram/`, when `--config-dir <old
   CLAUDE_CONFIG_DIR>` is given. Nothing else from the old config home is
   copied — transcripts and plugin state are regenerated fresh.

## No token is migrated — ever

`adopt` stops at "enter the OAuth token and the Telegram token for
`<name>`", by hand, through `botcorp secrets set <name> oauth|telegram` or
the cockpit's vault form. It does not read, copy, or infer either token from
the old bot's `.claude/.oauth_token`, its `channels/telegram/.env`, or
anywhere else — the operator mints or re-enters each one, per bot, every
time. This is deliberate: nothing about credentials is ever automatic in
BotCorp (`README.md` → Secrets), and re-entering by hand is also the moment
to decide whether this bot should bill to a different Claude account.

## Audit the old config home for strays

A hand-grown bot tends to leave state in whatever `CLAUDE_CONFIG_DIR` it used
to run under. Before calling the migration done, check that config home for
anything that should have moved with the bot instead of staying behind:

- [ ] Auto-memory under its old `projects/<slug>/memory/` — copy into the new
      `bots/<name>/memory/` if it wasn't already tracked there.
- [ ] Bot-specific env/hooks/permissions that ended up in a shared
      `settings.json` rather than the bot's own — move to
      `bots/<name>/.claude/settings.local.json`.
- [ ] `channels/telegram/.env` — superseded by the vault; delete it once the
      new bot's poller is confirmed alive (do not copy the token from it).
- [ ] Any `commands/`, `skills/`, or `agents/` the bot authored for itself —
      move into `bots/<name>/.claude/{commands,skills,agents}/`.
- [ ] Bot-specific instructions that leaked into a shared `CLAUDE.md` —
      fold into `bots/<name>/CLAUDE.md`'s own (non-imported) section.

## Verify before declaring the cutover done

- [ ] `botcorp sync <name>` runs clean and twice in a row produces an
      identical `settings.json` (idempotent).
- [ ] The cockpit shows the bot's terminal answering a prompt.
- [ ] If `harness.modules.telegram: true`: the poller is ALIVE for this
      bot's token, and a message round-trips.
- [ ] `botcorp doctor` reports no `FAIL` lines for this bot.
- [ ] The old bot's scheduled tasks/supervisor are stopped (never delete them
      until a soak period passes clean — see below).
- [ ] `bots/<name>/` has no `.git` (a bot folder is not a nested repo; the
      old history stays in the source folder).

## Rollback

The old repo and its scheduled tasks are only stopped, not deleted, until a
soak period (recommend 24h+) passes with no issues. Rollback = re-enable the
old tasks, stop the new bot, delete `bots/<name>/` (the source was never
touched). Any memory written by the new bot since cutover must be copied back by
hand — keep the trial window short.
