# bots/

Every bot on this machine lives here as its own folder. Only this file and
`_example/` are tracked in BotCorp — everything else under `bots/` is
**whitelist-ignored** (`.gitignore`: `bots/*` then `!bots/README.md` and
`!bots/_example/`), so a real bot's memory, transcripts, vault and config home
can never be staged into this public repo, even by an accidental `git add -A`.

## A bot folder is a plain folder, not a nested git repo

`bots/<name>/` = `BOT_HOME`. It holds `bot.yaml`, `CLAUDE.md`, `memory/`,
the bot's own `tools/`, and `.claude/` (generated `settings.json` +
bot-owned `settings.local.json`, `rules/`, `agents/`, `skills/`). Nothing in
here is required to be its own git repository — BotCorp does not manage a
bot's version history. A bot moves between machines with `botcorp export
<name>` / `botcorp import <zip>` (the vault is never in the zip; tokens are
re-entered). A versioned copy of `memory/` on a private remote is the optional
`backup:` module (`backup.git_remote` in `bot.yaml`, run by `botcorp backup
<name>`), off by default; a bot whose `BOT_HOME` is itself a clone of another
project is covered by `docs/adopt-existing-bot.md`. Either way it stays
outside the `bots/*` whitelist.

`botcorp new` creates the folder, `botcorp sync <name>` (also run
automatically after a harness update and whenever `bot.yaml` changes) writes
the generated files; see `docs/engine-contract.md` for exactly which files
are harness-owned vs. bot-owned.

## `.claude-<name>/` and `.vault/` — why they never leave the machine

Two more subfolders live inside every bot folder, both gitignored by the
per-bot `.gitignore` template AND by BotCorp's own `.gitignore` (belt and
braces):

- **`.claude-<name>/`** — the bot's `CLAUDE_CONFIG_DIR`: Claude Code
  transcripts (`projects/`), installed plugin state, and
  `channels/telegram/access.json` (the pairing allow-list). It holds
  `.credentials.json` only if the bot ever ran an interactive `/login` (e.g.
  to enable Remote Control) — see the vault ceiling in the README's Secrets
  section. None of this is meaningful outside this machine and this
  `CLAUDE_CONFIG_DIR`.
- **`.vault/secrets.json`** — the bot's DPAPI-encrypted OAuth and Telegram
  tokens, current-user scope on this machine. A copy of this file on another
  machine, or under another Windows account, cannot be decrypted — that is
  the point, not a bug. A bot moved to another machine re-enters its tokens
  by hand (`botcorp secrets set <bot> oauth|telegram`).

## `_example/`

A minimal, non-running reference bot (`bot.yaml`, a rendered `CLAUDE.md`,
its own `README.md`) showing the shape a real bot takes. See
`bots/_example/README.md`.
