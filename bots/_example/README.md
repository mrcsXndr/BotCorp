# _example — reference only, not a bot to run

This folder shows the shape a real bot takes: `bot.yaml` (the only file a bot
edits about its harness) and a `CLAUDE.md` rendered from
`templates/bot/CLAUDE.md` with the persona filled in. It is tracked in
BotCorp on purpose — it is the one exception to `bots/*` being
whitelist-ignored (see `bots/README.md`) — precisely so there is always a
working example to diff a real `bot.yaml` against.

Do not `botcorp start example`: it has no vault entries (no OAuth token, no
Telegram token), so there is nothing for it to launch with. To make a real
bot, run `botcorp new` instead — it asks for one thing (an OAuth token from
`claude setup-token`) and creates a proper `bots/<name>/`.

If you do experiment inside this folder, anything it writes at runtime
(`.claude-example/`, `.vault/`, `memory/`) is already gitignored — see the
root `.gitignore` — so it can never be accidentally committed here.
