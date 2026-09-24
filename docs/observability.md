# Observability: telemetry, cost, subagents, automations

Every bot's cost/usage/subagent picture is built from a small set of
supported surfaces — no more transcript-JSONL parsing as the primary source,
because it is slow, unbounded, and undocumented. Transcript parsing survives
only as an explicit, flagged fallback.

## Sources

| Signal | Source | Status |
|---|---|---|
| Per-request model, tokens, cost, duration, `agent_id`/`parent_agent_id`, `query_source` | Claude Code's OpenTelemetry export -> `daemon/otel-sink.mjs` -> `<BOTCORP_HOME>/state/<bot>/telemetry.db` | primary |
| Subagent spawned/stopped: type, start/stop, exit | `SubagentStart`/`SubagentStop` hooks -> `<BOTCORP_HOME>/state/<bot>/subagents.jsonl` | primary |
| Main-session context %, model, cost, rate-limit windows | `tools/infra/statusline.js` -> `<config_home>/botcorp/status.json` | primary |
| Per-session totals (`memory/metrics/sessions.csv`) | `tools/v2/cost_meter.py` on the `Stop` hook, reading `telemetry.db` | primary |
| Per-day per-agent-type totals (`memory/metrics/subagents.csv`) | `cost_meter.py --rollup`, reading `telemetry.db`'s `rollup_hourly` | primary |
| Anything the above don't carry for an OLD session | transcript JSONL parse, module `legacy_transcript_parse` only | fallback, flagged |

## Why OTel replaces transcript parsing

The transcript gives token counts but not real cost (that was a guessed
price table), not `agent_id`/`parent_agent_id` (subagent counting scanned for
`Agent`/`Task` tool_use blocks — an approximation), and grows without bound
as a session runs. Claude Code's own OTel export carries the real numbers
per request. `daemon/launch.ps1` points every telemetry-enabled bot at the
sink:

```
CLAUDE_CODE_ENABLE_TELEMETRY=1
OTEL_LOGS_EXPORTER=otlp
OTEL_METRICS_EXPORTER=otlp
OTEL_EXPORTER_OTLP_PROTOCOL=http/json
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:<port>
OTEL_RESOURCE_ATTRIBUTES=bot.name=<bot>
```

Prompt/response/tool-argument content is never exported — Claude Code only
sends that when the `OTEL_LOG_*` content gates are set, and nothing here
sets them. `daemon/otel-sink.mjs` also drops, on top of that, any attribute
whose key contains `prompt`, `content`, `input.`, `tool_input` or
`arguments`, before it is ever written to disk.

## Attribute names are not pinned by docs

Claude Code's OTel attribute names for a given field are not guaranteed by
published docs, so the sink accepts several spellings for each typed column
(see `FIELD_ALIASES` in `daemon/otel-sink.mjs`) and ALSO keeps the full,
filtered attribute bag in `attrs_json` on every row. That is deliberate: the
step that first runs a real bot against the sink and inspects `attrs_json`
confirms which spelling Claude Code actually sends, and that observation
should update `FIELD_ALIASES` (and `docs/cc-compat.md`, if this checkout has
one) rather than staying tribal knowledge.

## `telemetry.db` schema (one file per bot)

```
events(id, ts, name, session_id, agent_id, parent_agent_id, query_source,
       agent_name, model, input_tok, output_tok, cache_read_tok,
       cache_creation_tok, cost_usd, duration_ms, attrs_json)

metrics(id, ts, name, value, attrs_json)

rollup_hourly(hour, session_id, agent_type, model,
              n_requests, in_tok, out_tok, cache_tok, usd)
  PRIMARY KEY (hour, session_id, agent_type, model)
```

`rollup_hourly` is maintained incrementally as each `api_request` /
`claude_code.api_request` event lands (see `updateRollup` in
`daemon/otel-sink.mjs`) so `cost_meter.py` never has to re-scan raw events to
answer "how much did this session/day cost, broken down by agent type".
`agent_type` is the event's `query_source` (falls back to `main`) — not a
separate concept.

## Retention and caps

Per bot, enforced by the sink every 10 minutes and once at startup:

- raw `events` older than 30 days: deleted
- `rollup_hourly` rows older than 400 days: deleted
- if `telemetry.db` exceeds 200 MB: oldest events deleted in 10k-row
  batches (with `PRAGMA incremental_vacuum` after each batch) until back
  under the cap; what was dropped is logged to stderr as one line

`subagents.jsonl` and `runs.jsonl` retention (90 days / 14 days-or-50MB) is
the automation scheduler's job, not the sink's — see `harness/automations.yaml`.

## `cost_meter.py`

- `--stdin` (wired on the `Stop` hook): reads the Stop payload's
  `session_id`, sums that session's priced events from `telemetry.db`, and
  upserts one row into `memory/metrics/sessions.csv` (same 11-column shape
  the original tool shipped, so history stays continuous). `subagent_count` = the number
  of DISTINCT `agent_id`s seen with `query_source=subagent` or a non-null
  `parent_agent_id` — not a count of requests.
- If the DB is missing or the session has no rows: falls back to transcript
  parsing ONLY when `module_enabled("legacy_transcript_parse")` is true, and
  marks that row's `model_mix` with a `|source=transcript` suffix so it is
  never mistaken for a metered figure. Otherwise it writes nothing and
  prints `cost_meter: no telemetry for session <id>` (fail-open — this must
  never block session end).
- `--rollup`: refreshes `memory/metrics/subagents.csv` from the last 2 days
  of `rollup_hourly`, across every session — the safety net for a session
  whose own Stop hook never ran (crash, kill -9).

## Cockpit / hub surfaces

The cockpit's per-bot Activity/Usage tabs and `tools/infra/hub_push.py`'s
`activity`/`usage` payloads (see `docs/hub-ingest-api.md`) are read from
these same files — `sessions.csv`, `subagents.csv`, `subagents.jsonl`,
`runs.jsonl`, `status.json` — never from a live telemetry.db query at
request time, so a dashboard render never depends on SQLite lock contention
with the sink.
