# BotCorp

One shared core, N private bots, one checkout per machine.

BotCorp is the harness for a long-running Claude Code bot: journal/timeline/
recall memory, Telegram intake, a secrets vault, a host daemon that keeps
sessions alive across reboots, and a browser cockpit to watch and steer any
of them. You clone it once per machine; every bot you run lives in its own
gitignored folder, `bots/<name>/`, which is that bot's own private space —
its persona, its memory, its tokens. The harness itself
(`harness/`: hooks, agents, skills) is a **Claude Code plugin**, loaded in
place with `--plugin-dir` — nothing about it is installed into your global
Claude Code config, and nothing about a bot's own state ever needs to be.

## 60-second quickstart

```powershell
git clone <your BotCorp remote URL> C:\Users\<you>\Code\BotCorp
cd C:\Users\<you>\Code\BotCorp
npm install
node cli/botcorp.mjs install                 # registers the host daemon (one-time, per machine)
node cli/botcorp.mjs new                     # asks for ONE thing: a token from `claude setup-token`
```

`claude setup-token` (run on any machine with a browser, on the Claude
account this bot should bill to) prints a token — paste it when `botcorp new`
asks. Everything else defaults: bot name `bot-1`, a generic persona,
Telegram off. Then open the cockpit:

```
http://127.0.0.1:4477
```

Your bot is answering prompts in its terminal within about a minute. See
`docs/onboarding.md` for attaching Telegram, renaming the bot, and every
other first-run step.

## Layout

```
BotCorp/                     PUBLIC repo, ONE checkout per machine (e.g. C:\Users\<you>\Code\BotCorp)
  botcorp.json                engine version + schema ranges
  harness/                    the Claude Code plugin: --plugin-dir <BotCorp>/harness
    hooks/  agents/  skills/  rules/  lessons/  tools/{v2,tg,infra,browser}/  tests/
  daemon/                     host daemon: tick, launch, restart, install, update, smoke,
                               pty-host.mjs, secrets.ps1 (DPAPI vault), sync.mjs
  cockpit/                    browser UI (express+ws+xterm) — attaches to pty-hosts, never owns one
  cli/botcorp.mjs             new | adopt | sync | secrets | pair | config | status | update | suggest | doctor
  templates/bot/               CLAUDE.md, bot.yaml, .gitignore, settings.local.json, tg-enable.settings.json
  bots/                        GITIGNORED whitelist-style (only bots/README.md + bots/_example/ are tracked)
    <name>/                    = BOT_HOME, this bot's own private space
      bot.yaml  CLAUDE.md  memory/  tools/  .claude/{settings.json(generated), settings.local.json, rules/, agents/, skills/}
      .claude-<name>/          = CLAUDE_CONFIG_DIR (gitignored): Claude Code's own transcripts, plugin state, access.json
      .vault/secrets.json      this bot's DPAPI-encrypted OAuth + Telegram tokens (gitignored, secret-scan covered)
  docs/  .github/workflows/ci.yml  .githooks/pre-commit  scripts/
~/.botcorp/                   machine-local RUNTIME only, never secrets: daemon.log, state/<bot>.json, access.json
```

## Catalogue

Nothing in the harness is on by default beyond the memory loop and the
safety hooks. A bot opts into the rest through `bot.yaml`:

| Catalogue | Entries | Opt in via |
|---|---|---|
| Hooks | session start/end, inbound-prompt guard, precompact extract + timeline, memory sync, cost meter, auto-commit, block-dialogs, config-guard, core-guard, stop-failure, notification, subagent start/stop | loaded from the plugin automatically; `bot.yaml` `harness.hooks_disable: [...]` turns any off |
| Agents | `planner`, `senior-coder`, `coder`, `one-shot`, `critic`, `fable` | all available; a same-named file in the bot's own `.claude/agents/` overrides one |
| Skills | `review-artifact`, `morning`, `standup`, `weekly`, `tasks`, `notes`, `prd`, `launch` (+ the `/critic` command) | `harness.skills: all` or a list; the rest are hidden |
| Modules | `telegram`, `board`, `cost_meter`, `usage_resume`, `alert_triage`, `hub`, `janitor`, `remote_control`, `lessons`, `debrief`, `auto_commit`, `memory_sync`, `sound`, `telemetry`, `backup` | `harness.modules.<x>: true` in `bot.yaml` → env for the launched session + which daemon ticks run for this bot |
| Ticks / automations | board poll, worklist, janitor, hub push, harness-update check (records pending releases only — see Admin-gated harness updates below), plus any bot-declared job | per module, or declared directly under `bot.yaml` `automations:` — run by the one host daemon, with backoff, daily caps and idle-gating |
| Integrations | Telegram (the official Claude Code plugin), a GitHub Projects (v2) board, a generic status hub (`integrations.hub`, optional), Cloudflare Tunnel + Access for cockpit exposure (`integrations.access`, optional — loopback stays the default until you run `botcorp cockpit expose`), a bot's own tools for anything else | the matching `integrations.<x>` block in `bot.yaml`; credentials live in `.vault/`, never in the file itself |

## Moving a bot between machines

A bot's folder is a plain gitignored directory, not a nested git repo.
`botcorp export <bot>` writes a zip (the vault is excluded — DPAPI keys are
per machine); `botcorp import <zip> --as <name>` unpacks it on the new box,
and you re-enter its OAuth/Telegram tokens by hand, same as onboarding a new
bot. If you want a bot's own memory versioned for backup, turn on the
`backup.git_remote` module (`bot.yaml` `backup: {git_remote: <your own
remote URL>}`) — off by default, and it always points at a remote you own,
never at this repo. `botcorp new` shows the full feature catalogue above as
a checklist at first setup.

## Secrets

Every bot's OAuth token and Telegram token are DPAPI-encrypted at rest,
current-user scope, in `bots/<name>/.vault/secrets.json`
(`botcorp secrets set <bot> oauth|telegram`) — a copied vault file cannot be
decrypted on another machine or account, which is intentional. Nothing is
hard-coded, pre-seeded, or copied between bots: each token is entered by
hand, once, per bot. Reaching Claude Code, a token exists only as a
child-process environment variable — never on a command line, never printed,
never logged beyond a masked `****last4`.

**The vault ceiling, stated plainly:** "encrypted at rest" covers the
BotCorp vault above. It does **not** cover anything Claude Code itself
writes under a bot's own config home (`.claude-<name>/`) — that stays under
Claude Code's own control. `.credentials.json` is Claude Code's own plaintext
OAuth file, written only if a bot ever runs an interactive `/login` (needed
for Remote Control, below). If the Telegram plugin's env-only path is ever
unavailable, the fallback is a plaintext `channels/telegram/.env` it reads
directly. Both are ACL-restricted to the current Windows user and gitignored
— but neither one is encrypted by BotCorp.

## The cockpit is loopback-only, forced-Access otherwise

Exposing the cockpit at all is the optional `integrations.access` module —
loopback stays the default even on a machine with other integrations turned
on. Turning it on is one command, `botcorp cockpit expose --team <team>
--aud <aud> --yes`, which writes the machine-level
`<BOTCORP_HOME>/access.json` (a Cloudflare Access `team` + `aud`). Once that
file exists, forced Access applies unconditionally: every request — HTTP and
WebSocket alike — must carry a verified `Cf-Access-Jwt-Assertion` or it gets
a 401. **There is no flag, env var, or setting that disables this once
configured — removing `access.json` is the only way back to loopback-only.**
A LAN-only operator uses loopback plus SSH/RDP to reach the machine instead
of exposing the cockpit. Full model: `docs/cockpit.md` and
`docs/tunnel-cf-access.md`.

## Remote Control

Optional, per bot, **off by default** (`harness.modules.remote_control:
false`). Turning it on requires an interactive `/login` in that bot's own
config home — a `claude setup-token` cannot enable it — surfaced from the
cockpit as an "Enable Remote Control" action. Transcripts of any Remote
Control session are stored on Anthropic's servers, not on this machine; the
cockpit never wraps that login in anything but Claude Code's own flow.

## Admin-gated harness updates

The hourly check only *records* pending releases — nothing applies itself.
Each one carries plain-language notes generated from its changelog (**What
changed** / **Why** / **Value to you**) and shows up in the cockpit's
Releases panel and the weekly digest with **Apply** / **Skip** buttons.
Apply is an admin action: it queues the harness update, which lands at that
bot's next safe restart behind the existing smoke test and automatic
rollback on failure.

## Requirements

- Windows 11
- Claude Code >= 2.1.280 (needed for `--plugin-dir` / `CLAUDE_CODE_PLUGIN_DIRS`)
- Node.js 20+
- Python 3.11+
- PowerShell 7+ (`pwsh`)
- Git

`botcorp doctor` checks all of the above, plus the forced-Access and
single-poller invariants, on demand.

## The improvement cycle, in three lines

A bot proposes a generic harness upgrade as a `suggest/<bot>/<topic>` PR;
other bots cross-review it (never their own, never twice, capped, no bot
merges); the operator alone merges, from one weekly digest instead of
per-PR pings. Full detail: `docs/improvement-cycle.md`.

## What this is not

- Not a multi-tenant SaaS — one operator, one machine (or a few), full
  control of every bot's credentials and data.
- Not a way to run two bots on the same Telegram token — one poller per
  token, always; `botcorp doctor` enforces it.
- Not a place to keep bot-specific product logic — that lives in
  `bots/<name>/`, never in a tracked BotCorp file (`docs/engine-contract.md`).
- Not encryption for whatever Claude Code itself writes to a config home —
  see the vault ceiling above.
- Not a public exposure tool by default — the cockpit is loopback-only until
  you deliberately configure Cloudflare Access, and there is no way to skip
  that step.
- Not the first public template we shipped — the earlier one is sunset (not
  archived), with a pointer here.

## Documentation

- [`docs/cockpit.md`](docs/cockpit.md) — the browser UI, its auth model, pty-host contract
- [`docs/daemon.md`](docs/daemon.md) — the host daemon, its tick, Scheduled Tasks
- [`docs/automations.md`](docs/automations.md) — per-bot cron/interval/event jobs
- [`docs/cli.md`](docs/cli.md) — every `botcorp` subcommand
- [`docs/onboarding.md`](docs/onboarding.md) — first-run walkthrough, Telegram pairing, the guarded config writer
- [`docs/observability.md`](docs/observability.md) — subagent + usage telemetry, retention, caps
- [`docs/hub-ingest-api.md`](docs/hub-ingest-api.md) — the generic status-hub push format
- [`docs/engine-contract.md`](docs/engine-contract.md) — the three zones, what's shared vs. yours, the tripwires
- [`docs/tunnel-cf-access.md`](docs/tunnel-cf-access.md) — Cloudflare Tunnel + Access, forced-Access model
- [`docs/improvement-cycle.md`](docs/improvement-cycle.md) — suggest PRs, cross-review, human-only merge, digest
- [`docs/adopt-existing-bot.md`](docs/adopt-existing-bot.md) — moving a hand-grown bot into `bots/<name>/`
- [`harness/migrations/README.md`](harness/migrations/README.md) — `bot.yaml` schema migrations

## License

MIT — see [`LICENSE`](LICENSE).
