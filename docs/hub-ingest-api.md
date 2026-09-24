# Hub ingest API

`tools/infra/hub_push.py` pushes one bot's status to ANY hub configured in
its `bot.yaml`:

```yaml
integrations:
  hub:
    url: https://your-hub.example/api/ingest
    interval_s: 300
```

The token lives in the bot's vault (`hub_token`) and reaches the tool as the
`HUB_TOKEN` environment variable — the daemon injects it at launch; the tool
itself never reads the vault.

**Numbers and short enums only. Never a token, a filesystem path, or free
text.** Every payload is built from an explicit key whitelist (not
sanitised after the fact) and capped at 4 KB; if the `activity` item list
would exceed the cap, the oldest items are dropped first.

## Request

```
POST <integrations.hub.url>
Authorization: Bearer <hub_token>
Content-Type: application/json
```

One HTTP POST per `kind`, sent back-to-back on the same tick (self-throttled
per bot by `interval_s`, tracked in `<BOTCORP_HOME>/state/<bot>/hub_push.json`
so a scheduler that ticks more often than `interval_s` doesn't over-push).

### `kind: "bots"`

```json
{
  "kind": "bots",
  "ts": 1732450000.0,
  "box": "DESKTOP-EXAMPLE",
  "bots": [
    {
      "name": "bot-1",
      "harness_version": "1.0.0",
      "cc_version": "2.1.281",
      "session_id": "8f3c...",
      "model": "Sonnet 5",
      "ctx_pct": 62,
      "rate_limits": { "five_h_pct": 12.0, "seven_d_pct": 40.5, "resets_at": "2026-09-24T22:00:00Z" },
      "tg_poller": "owned",
      "last_turn_age_s": 45,
      "board_ready": false,
      "usd_today": 3.42,
      "alerts_open": 0,
      "last_update": 1732450000.0
    }
  ]
}
```

One array entry per bot (`hub_push.py` runs per bot, so today that array has
exactly one element per push; a hub aggregating several boxes/bots merges
across pushes by `name`+`box`).

### `kind: "activity"`

```json
{
  "kind": "activity",
  "ts": 1732450000.0,
  "box": "DESKTOP-EXAMPLE",
  "bot": "bot-1",
  "items": [
    { "ts": 1732449800.0, "kind": "session", "name": "bot-1", "model": "claude-sonnet-5", "duration_s": 812.0, "usd": 1.20, "outcome": "ok" },
    { "ts": 1732449700.0, "kind": "subagent", "name": "coder", "model": "", "duration_s": null, "usd": null, "outcome": "ok" },
    { "ts": 1732449600.0, "kind": "automation", "name": "board_poll", "model": "", "duration_s": 1.4, "usd": null, "outcome": "ok" }
  ]
}
```

`items` holds at most the 50 most recent entries, newest first, drawn from
`subagents.jsonl` (kind `subagent`), `runs.jsonl` (kind `automation`) and
`sessions.csv` (kind `session`). `outcome` is always `ok` or `error` — never
a message string.

### `kind: "usage"`

```json
{
  "kind": "usage",
  "ts": 1732450000.0,
  "box": "DESKTOP-EXAMPLE",
  "usd_today": 3.42,
  "usd_7d": 21.10,
  "subagent_usd_7d": 6.55,
  "windows": { "five_h_pct": 12.0, "seven_d_pct": 40.5, "resets_at": "2026-09-24T22:00:00Z" }
}
```

`subagent_usd_7d` sums `memory/metrics/subagents.csv` rows over the last 7
days where `agent_type != "main"` — the cost attributable to subagent work,
separate from the main session.

## Response

```json
{ "interval_s": 300 }
```

`hub_push.py` does not currently read `interval_s` back from the response
(the push cadence is `bot.yaml`'s own `integrations.hub.interval_s`); a hub
may still return it for a future client that adapts to a server-set cadence.

## What is never sent

No absolute path, no token/secret value, no prompt or response text, no
raw `attrs_json` blob from `telemetry.db`. Every payload is assembled field
by field from a hardcoded whitelist (`BOTS_ITEM_KEYS`, `ACTIVITY_ITEM_KEYS`,
`USAGE_KEYS` in `hub_push.py`) — a new field is invisible to the hub until
someone deliberately adds it to that whitelist and this document.
