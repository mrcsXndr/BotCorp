# This bot's folder

This is one bot's private configuration and memory, seeded from the BotCorp
`templates/bot/` template. It is a plain folder that BotCorp's own
`.gitignore` keeps out of the public repo — not a nested git repository.

To move it to another machine: `botcorp export <bot>` (a zip without
`.vault/` and without the config home, except the Telegram allow-list) and
`botcorp import <zip>` on the other side, then re-enter the tokens with
`botcorp secrets set`. To keep a versioned copy of `memory/` on a private
remote, set `backup.git_remote` in `bot.yaml` and run `botcorp backup <bot>`
(the `.gitignore` next to this file keeps `.vault/` and `.claude-*/` out of it).
