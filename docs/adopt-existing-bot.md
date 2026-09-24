# Adopting an existing bot into BotCorp

Checklist for moving a hand-grown, v2-pattern bot (its own hooks, three-
channel memory, supervisor scripts) into `bots/<name>/` under this BotCorp
checkout. The harness becomes shared machinery under `harness/`; everything
that makes the bot itself moves into `bots/<name>/` — its `bot.yaml`,
`CLAUDE.md`, `memory/`, and any bot-specific rules/tools.

**Model:** `botcorp adopt <path> --as <name>` relocates the existing clone
into `bots/<name>/`, removes files now duplicated by the shared harness,
generates `bot.yaml` from what it can read out of the old repo's settings/
`.env`/scheduled ticks, and leaves everything genuinely bot-specific alone.
It never edits the bot's own application code — it only reorganises the
harness-adjacent files and adds BotCorp's own. Like any bot, the result is a
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

This prints the full file plan — every move, every deletion, every
generated file — without touching anything. Confirm before the real run:

- [ ] It touches no path under `memory/` (memory moves wholesale, untouched).
- [ ] It doesn't try to read a token from anywhere (see below — none is
      migrated).
- [ ] The rules it plans to keep vs. fold into imports match what you expect
      for a bot with genuinely bot-specific behaviour beyond the shared
      harness rules (`coding`, `security`, `memory-loop`, `session-lifecycle`,
      `task-board`, `telegram`, `browser`, `tools` are all imported from
      `harness/rules/`; only the bot-specific remainder is worth keeping).

## What `adopt` does for real

1. **Moves the clone** to `bots/<name>/` (its git history and remote, if any,
   travel with it — `adopt` does not touch the bot's own repository).
2. **Writes `bot.yaml`** from what it can infer: model/effort from the old
   settings, `harness.modules.*` from which features were wired, and each
   recurring supervisor tick becomes an `automations:` entry with the same
   command and cadence (`idle_gated: true` carried over wherever the old
   supervisor idle-gated it too).
3. **Converts mixed instance+harness rules**: bot-specific remainder stays
   under the bot's own `.claude/rules/`; anything that duplicates a harness
   rule is dropped in favour of the `@../../harness/rules/<x>.md` import in
   the bot's `CLAUDE.md`.
4. **Moves bot-specific hooks to `settings.local.json`** (never into the
   generated `settings.json` — see `docs/engine-contract.md`), so a future
   `botcorp sync` can't silently drop them.
5. **Copies only the Telegram allow-list**
   (`channels/telegram/access.json`) into the bot's new
   `.claude-<name>/channels/telegram/`, if that module is on. Nothing else
   from the old `CLAUDE_CONFIG_DIR` is copied — transcripts and plugin state
   are regenerated fresh.

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
- [ ] `git -C bots/<name> status --porcelain` (if the bot has its own repo)
      shows only the expected adoption commit.

## Rollback

The old repo and its scheduled tasks are only stopped, not deleted, until a
soak period (recommend 24h+) passes with no issues. Rollback = re-enable the
old tasks, stop the new bot, move the folder back if it was relocated in
place. Any memory written by the new bot since cutover must be copied back by
hand — keep the trial window short.
