# harness/migrations/

One-off scripts that bring an existing bot's `bot.yaml` (and anything else a
harness update needs restructured) up to date with a new
`botcorp.json.botYamlSchema`. Not for harness code itself — `git pull`
already handles that; migrations exist only for the shape of what a bot
owns.

## Naming

`NNN-<slug>.ps1`, zero-padded, one number per schema bump —
e.g. `002-rename-hooks-disable-key.ps1`. The number must match the
`botYamlSchema` value it migrates the bots **onto**, so `update.ps1 -Apply`
can tell which migrations the machine still needs by comparing the schema
recorded in `~/.botcorp/state/harness.json` against its number.

(No migration exists yet: this folder holds only this README.)

## Idempotent, always

A migration runs once per machine at `update.ps1 -Apply` time and has to
handle every bot itself. It must be safe to run twice: check the state it wants before
changing it, and no-op cleanly if the target state already holds. Bots are
not guaranteed to migrate in lockstep — one bot mid-task keeps its old
harness loaded until its own next restart (`docs/engine-contract.md` /
`README.md` → "harness self-update"), so a migration can run against a bot
that's already several schema versions ahead of another.

## What a migration receives

Each script is invoked once, with no arguments, from the BotCorp root:

```powershell
pwsh -NoProfile -NonInteractive -File harness/migrations/NNN-slug.ps1
```

with `BOTCORP_ROOT` (the checkout) and `BOTCORP_HOME` (`~/.botcorp`) in its
environment, bounded by what is left of the apply's 3-minute budget. It finds
the bots itself (`bots/<name>/`) and touches only files under them
(`bot.yaml`, a bot's `.claude/`, its `memory/`); it never touches the harness
itself. After the migrations, `update.ps1` runs `daemon/sync.mjs <bot>` for
every bot to regenerate `settings.json` from the now-current `bot.yaml`.

## Gating

`update.ps1 -Apply` runs, in name order, every migration numbered above the
schema recorded in `~/.botcorp/state/harness.json`. There is no upper bound:
a migration numbered above the new `botYamlSchema` runs too. A migration that
exits non-zero (or runs out of the budget) fails the apply: no later
migration runs, the checkout goes back to the previous release, the release
is marked `failed` (reason `migration failed`, the migration's name, exit and
output tail in `fail_detail`) and `harness.json` keeps its old schema, so the
next apply runs that migration again. The migrations that passed before it
are not undone, which is why each must be idempotent.
