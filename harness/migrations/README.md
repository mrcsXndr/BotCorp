# harness/migrations/

One-off scripts that bring an existing bot's `bot.yaml` (and anything else a
harness update needs restructured) up to date with a new
`botcorp.json.botYamlSchema`. Not for harness code itself — `git pull`
already handles that; migrations exist only for the shape of what a bot
owns.

## Naming

`NNN-<slug>.ps1`, zero-padded, one number per schema bump —
e.g. `002-rename-hooks-disable-key.ps1`. The number must match the
`botYamlSchema` value it migrates a bot **onto**, so `botcorp update` can
tell which migrations a given bot still needs by comparing its recorded
schema version against `botcorp.json`.

## Idempotent, always

A migration runs against every bot on the machine at `botcorp update -Apply`
time, and must be safe to run twice: check the state it wants before
changing it, and no-op cleanly if the target state already holds. Bots are
not guaranteed to migrate in lockstep — one bot mid-task keeps its old
harness loaded until its own next restart (`docs/engine-contract.md` /
`README.md` → "harness self-update"), so a migration can run against a bot
that's already several schema versions ahead of another.

## What a migration receives

Each script is invoked per bot as:

```powershell
pwsh -NoProfile -File harness/migrations/NNN-slug.ps1 -Bot <name> -BotHome <path>
```

`-BotHome` is `bots/<name>/` — the migration touches only files under there
(`bot.yaml`, that bot's `.claude/`, its `memory/`); it never touches the
harness itself. After every migration in the range runs clean,
`botcorp update` calls `botcorp sync <bot>` to regenerate `settings.json`
from the now-current `bot.yaml`.

## Gating

`botcorp.json`'s `botYamlSchema` is the ceiling: `botcorp update -Apply` runs
every migration numbered above a bot's last-recorded schema version and at or
below the new `botYamlSchema`, in order, then stamps the new version into
`~/.botcorp/state/<bot>.json`. A migration that throws stops the update for
that bot and leaves its schema version unstamped, so the next `update -Apply`
retries it rather than skipping ahead.
