# Onboarding a bot

Three steps. The first needs one token; the other two are things you do
once and then let the bot drive its own configuration through a guarded
writer. Full command reference: `docs/cli.md`.

## 1. One token to start

```
botcorp new
```

(or the cockpit's "New bot" form.) On a terminal it first shows the BotCorp
feature catalogue as one numbered checklist, defaults pre-marked: modules,
skills, agents and integrations (telegram, board, hub, backup), each with a
one-line description. Toggle by number, Enter to accept; the choices that
differ from the defaults are what ends up in `bot.yaml`. `--yes` keeps the
defaults, `--modules a,b` / `--no-modules c` set them without a terminal.

Then it asks for ONE thing: the Claude Code OAuth token. Get it by running
`claude setup-token` on any machine with a browser and pasting the printed
token into the hidden prompt (`--oauth-stdin` pipes it instead; blank skips
it and the session will need `/login`). Everything else defaults: name
`bot-1` (`--name` to choose), a generic persona (`--persona`), Telegram off.

What you get: `bots/<name>/` with `bot.yaml`, a generated
`.claude/settings.json`, `CLAUDE.md`, `memory/`, the vault entry
`oauth_token` (DPAPI, this Windows account on this machine only), and a
running session hosted by `daemon/pty-host.mjs`. The folder is a plain
folder, not a git repo: BotCorp's `.gitignore` keeps everything under
`bots/` out of the public repo, and `.vault/` / `.claude-<name>/` never leave
the machine. Open the cockpit (`npm run cockpit`, `http://127.0.0.1:4477`)
and talk to it in the chat or terminal view; the bot is usable within a
minute.

Optional at any time: a Telegram bot token from BotFather (`/newbot`).
`botcorp new --telegram` (or the telegram item in the checklist) prompts for
it and for YOUR Telegram user id (`--telegram-owner <id>`; message
`@userinfobot` to read it), which goes straight into
`integrations.telegram.allow_from`, so you never need a pairing code
yourself. Or later:

```
echo <token> | botcorp secrets set <name> telegram
botcorp config set <name> harness.modules.telegram true
botcorp pair <name> <your id>
botcorp restart <name>
```

`new` with telegram on also installs the official Telegram plugin into the
bot's own config home and leaves it DISABLED there: only the launcher's
`--settings tg-enable.settings.json` enables it, on the one launch that owns
the poller lock. A plain `claude` in the bot folder never starts a second
poller. Two bots can never share a Telegram token (the vault refuses the
duplicate, exit 3): one bot, one BotFather token, one config home.

Moving a bot to another machine: `botcorp export <name>` writes a zip
without the vault and without the config home (except the Telegram
allow-list); `botcorp import <zip> [--as <name>]` on the other side, then
`botcorp secrets set` for the tokens. A versioned copy of `memory/` on a
private remote is the optional backup module: set `backup.git_remote` and
run `botcorp backup <name>` (see `docs/cli.md`).

Seeding from a folder (not a zip): `botcorp adopt <folder> --as <name>`
copies it in and runs sync; or copy it by hand into `bots/<name>/`, write
`bot.yaml`, then `botcorp sync <name>`. Either way the tokens are entered
afterwards with `botcorp secrets set`.

## 2. Pairing via "latest senders"

Telegram access is the official plugin's pairing flow, unchanged. With
`dm_policy: pairing` (the default) an unknown sender who messages the bot
gets a one-time code back; their text never reaches the session; at most
three senders can be pending. `allowlist` is the stricter option: unknown
senders are dropped silently and never appear as pending, so nothing can be
approved from the cockpit; switch to it once the allow-list is final. In
either policy, nothing ever approves a pairing from inside a chat; the
operator's own id is pre-allowed at `new` (`--telegram-owner`), and `doctor`
warns when a pairing-mode bot has an empty allow-list (nobody can talk to
it without a code).

"Latest senders" is the cockpit's pairing panel, or on the command line:

```
botcorp pair <name> --list
```

It reads `<config home>/channels/telegram/access.json` `pending` and shows
each sender's id, chat id and age. The plugin stores no username and BotCorp
never calls `getUpdates` itself to look one up (that would 409 the live
poller), so ask the person for the code they received, or have them message
`@userinfobot` on Telegram to read their own id. Then approve, at the machine
or in the cockpit, never from a chat message and never by the bot:

```
botcorp pair <name> 123456
```

That writes `allowFrom`, clears the pending entry, creates the
`approved/123456` marker exactly as the plugin's own access skill does, and
adds the id to `integrations.telegram.allow_from` in `bot.yaml` so `sync` and
the file agree. The first message from that sender now reaches the session.
`botcorp pair <name> --deny 123456` drops a pending request instead.

## 3. Chat-driven config with an approval queue

After that the bot configures itself by talking to you. The only path it has
to `bot.yaml` is the guarded writer:

```
botcorp config set <name> <dotted.path> <value>
```

The harness's `config-guard` PreToolUse hook blocks direct `Edit`/`Write`
on `bot.yaml`, the generated `settings.json`, `access.json` and the vault, so
the writer is the only way in. Two classes of change:

- **Applies immediately** (written, then `sync`; effective at the next
  session roll): `model`, `effort`, `persona`, `harness.modules.*`,
  `harness.hooks_disable`, `automations.<name>.enabled`, `suggest.*`,
  `integrations.hub.interval_s`, and anything else that does not widen.
- **Widening changes wait for you.** Adding to
  `integrations.telegram.allow_from`, loosening `dm_policy`
  (`disabled` -> `allowlist` -> `pairing`), `permissions: bypass`, turning on
  `harness.modules.remote_control`, or adding a vault key to an automation's
  `secrets` are queued in `<BOTCORP_HOME>/state/<name>.approvals.json` and NOT
  applied. The bot sees `queued for operator approval: botcorp approve <name>
  <id>` and tells you. You decide:

  ```
  botcorp approve <name> --list
  botcorp approve <name> <id>        # or --all
  botcorp reject <name> <id>
  ```

  Approval applies the change, syncs, and for a new Telegram id also performs
  the pairing write. Nothing in a Telegram message can approve anything;
  the queue is answered at the machine or in the cockpit.

Every queue, approve and reject is logged to
`<BOTCORP_HOME>/logs/<name>/approvals.log` with who asked (`bot:<name>` from a
session, `operator:<user>` from a terminal).

## Where the secrets are, and where the ceiling is

The vault, `bots/<name>/.vault/secrets.json`, holds `oauth_token`,
`telegram_token` and `hub_token` DPAPI-protected for this Windows account on
this machine (a copied vault is useless anywhere else; on a new machine you
re-enter the tokens). The launcher decrypts in-process and hands them to
Claude Code as child-process environment only; they are never on a command
line and `secrets list` shows `****last4`.

The ceiling: "encrypted by BotCorp" covers that vault and nothing else.
Whatever Claude Code writes under the bot's own config home
(`bots/<name>/.claude-<name>/`) is Claude Code's own plaintext:

- `.credentials.json`, present only after an interactive `/login` in that
  config home (which Remote Control needs; a setup-token cannot do RC), and
- `channels/telegram/.env`, only if the env-only token path is unavailable
  on a box and `harness.telegram_token_file: true` is set - and then only for
  the seconds between the launch and the plugin reading it: the launcher
  deletes it right after (or when the wait runs out, or at session exit) and
  logs the delete in `launches.log`.

Both are ACL-restricted to the user and gitignored (`.claude-*/`); neither is
encrypted by BotCorp. `botcorp doctor` checks the ignores and the vault's
readability on every host.

## Optional integrations

- **Cockpit exposure** (`integrations.access`) is machine-wide: one cockpit
  per box, loopback-only by default; `botcorp cockpit expose --team <t>
  --aud <a> --yes` puts it behind Cloudflare Access, `cockpit unexpose`
  takes it back. A bot's `integrations.access` only records which app it
  expects.
- **Hub** (`integrations.hub`, module `hub`): status push to any hub URL,
  token in the vault (`hub_token`).
- **Backup** (`backup.git_remote`): git backup of `memory/`, off by default.
- **Harness updates** are admin actions: `botcorp update` lists pending
  releases with What / Why / Value notes; `--apply <tag>` or `--skip <tag>`
  is your call, applied at each bot's next safe restart.
