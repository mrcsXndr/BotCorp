# Claude Code compatibility record

Every behaviour the harness leans on that Claude Code's docs do not pin down,
checked against a real binary. A row is either `confirmed <date> <version>` or
`NOT confirmed -> fallback kept`. Re-run the probe when `minClaudeCode` in
`botcorp.json` moves. Probe method: a throwaway config home (`CLAUDE_CONFIG_DIR`)
with `settings.json` hooks that save their stdin verbatim, a statusline command
run with `--dump`, an OTLP sink (`daemon/otel-sink.mjs`), headless runs
(`claude -p ... --setting-sources user`) and interactive runs driven through a
ConPTY (node-pty). Paths below are shortened to `<config>`, `<bot>`.

## The ten checks (plan step 1b)

| # | Claim | Result | Consequence |
|---|---|---|---|
| i | Statusline stdin carries `rate_limits.five_hour.used_percentage`, `.resets_at`, `context_window`, `cost`, `version` | **confirmed 2026-09-24 2.1.281** (captured below) | `status_footer.py` and `hub_push.py` read `<config>/botcorp/status.json` written by `statusline.js`; the banner-regex usage probe stays only behind `modules.legacy_usage` |
| ii | `StopFailure` matcher `rate_limit` and `Notification` matcher `quota_auto_resume_*` fire | **NOT confirmed -> fallback kept.** Both hook names and all three `quota_auto_resume_{fired,stale,disabled}` strings exist in the 2.1.281 binary and the hooks register without a validation error, but no limit was hit during the probe and the payload is not documented well enough to replay | `usage_monitor.py record-block` (banner text) and `record-notification` both stay; `stop-failure.sh` / `notification.sh` are wired and log what they receive |
| iii | The Telegram plugin takes `TELEGRAM_BOT_TOKEN` from the process env with no `channels/telegram/.env` | **NOT confirmed live -> fallback kept.** Code evidence only: plugin 0.0.7 `server.ts:33-44` loads `.env` into `process.env` *without overriding existing keys* ("Real env wins") and then reads `process.env.TELEGRAM_BOT_TOKEN`. No throwaway bot token was available for a live ALIVE probe | `launch.ps1` passes the vault token as env; `harness.telegram_token_file: true` writes the ACL'd `.env` instead |
| iv | Shift+Tab (`ESC [ Z`) through ConPTY cycles the permission mode | **confirmed 2026-09-24 2.1.281.** Three sends produced `accept edits on` -> `plan mode on` -> `auto mode on (shift+tab to cycle)` in the captured terminal output | The cockpit mode button sends `\x1b[Z`; no `\x1bm` fallback needed |
| v | `SessionEnd` runs on `/exit` and on `taskkill /T` | **/exit confirmed** (`"reason":"prompt_input_exit"`); **kill NOT confirmed -> fallback kept**: after `taskkill /T /F` of a session that had completed one turn (its `Stop` payload was captured) no `SessionEnd` file appeared | The tick keeps its stale-lock reclaim (owner-lock pid dead => reclaim); `session-end.sh` is best-effort |
| vi | Plugin 0.0.7 relays permission prompts | **confirmed 2026-09-24**: `grep -c permission server.ts` = 21 (permission request/response handling present) | Nothing dropped |
| vii | `claude --bg` works under the S4U daemon task and `claude agents --json` lists it | **NOT confirmed -> fallback kept.** A throwaway S4U task (`BotCorp-BgProbe`, removed) was tried with three action shapes (pwsh Store alias, wscript shim, Windows PowerShell 5.1); the probe script never produced output (LastTaskResult 0x1 / 0x0). `claude agents --json` from the desktop returned `[]` | The daemon starts bots through `daemon/pty-host.mjs` (detached, `taskkill /T` stop) — unchanged |
| viii | A `--bare` spawn in a config home with the Telegram plugin installed writes no `bot.pid` | **confirmed 2026-09-24 2.1.281** — and a second fact: `--bare` **never reads OAuth** (`Not logged in · Please run /login` with `CLAUDE_CODE_OAUTH_TOKEN` set; `--help` says auth is strictly `ANTHROPIC_API_KEY`/apiKeyHelper). A plain `-p --setting-sources user` run with the plugin installed-but-disabled also wrote no `bot.pid`, and so did one with the plugin enabled via `--settings` but no `--channels` | `Get-DriverHeadlessArgv` keeps `$Bare` off for token-authenticated bots; M9 (installed, disabled, enabled only via `--settings`) holds |
| ix | OTel `api_request` events carry `agent_id`, `parent_agent_id`, `cost` > 0, and `claude_code.token.usage` has `query_source=subagent` | **partly confirmed 2026-09-24 2.1.281.** `api_request` carries `cost_usd`, `model`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `duration_ms`, `query_source` (`sdk` for `-p`, `main` in the metric, `agent:builtin:<type>` for a subagent) and `agent.name` — but **no `agent_id` / `parent_agent_id`**. `claude_code.token.usage` datapoints carry `query_source=subagent|main` and `type=input|output|cacheRead|cacheCreation`. One `claude_code.subagent_completed` event per `Agent()` call (`agent_type`, `total_tokens`, `duration_ms`, `model`) | `cost_meter.py` counts subagents from `subagent_completed` rows and classifies subagent spend by `query_source LIKE 'agent:%'`; the sink keeps every attribute in `attrs_json` |
| x | `SubagentStart` / `SubagentStop` hook payloads | **confirmed 2026-09-24 2.1.281** (verbatim below). `SubagentStop` carries `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message` | `subagent.sh` records `agent_id`, `agent_type`, duration; the prompt summary uses `last_assistant_message` (first 200 chars) |
| xi | A project skill in `bots/<name>/.claude/skills/<x>/` beats the plugin skill of the same name (`botcorp:<x>`) | **NOT confirmed -> designed around.** No probe; resolution order between a project skill and a same-named plugin skill is undocumented | `bot.yaml` `harness.skills: [...]` lists the core skills to keep; `sync` writes every other harness skill into `disabledSkills` as `botcorp:<name>`, so a bot that ships its own `launch` simply leaves `launch` out of the list and the plugin one is hidden (the first bot does this for `launch`, `prd`, `weekly`) |

## Facts found on the way (each changed the code)

| Fact | Evidence | Where it landed |
|---|---|---|
| A fresh config home + env token still runs first-run onboarding **in interactive mode**: theme picker, then a login picker that opens a browser. `-p` mode is unaffected | ConPTY run 1: `Choose the text style...` then `Select login method ... Opening browser to sign in` | `botcorp new` seeds `<config>/.claude.json` with `hasCompletedOnboarding: true`, `theme` |
| The workspace trust dialog blocks an interactive session too, and its per-project key uses **forward slashes** (`projects["C:/Users/<u>/.../bots/<bot>"].hasTrustDialogAccepted`); a backslash key is ignored | run 3 (backslash key) showed the dialog; run 4 (forward slashes) did not | same seed |
| A child started from inside a Claude Code session inherits `CLAUDE_CODE_CHILD_SESSION` and runs with **"Transcript saving is off"** | banner `⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker · restart with CLAUDE_CODE_FORCE_SESSION_PE…` | `pty-host.mjs` and `launch.ps1` strip `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SSE_PORT` |
| `claude plugin marketplace add anthropics/claude-plugins-official` (owner/repo shorthand) clones over **SSH** and fails without a GitHub key; the `https://github.com/anthropics/claude-plugins-official` form works. A config home deeper than ~150 characters made the clone's checkout fail (Windows path length) | `git@github.com: Permission denied (publickey)` vs `Successfully added marketplace` | `botcorp new --telegram` uses the https URL; keep `bots/<name>/.claude-<name>` short |
| `-d` placed before a `plugin` subcommand turns the rest of argv into a prompt | `claude -d plugin marketplace add ...` answered the "prompt" | never pass `-d`/`--debug` before a subcommand |
| Hooks from `<config>/settings.json` fire in `-p` mode (`SessionStart`, `UserPromptSubmit`, `SubagentStart/Stop`, `Stop`, `SessionEnd` with `"reason":"other"`) | six payload files from one headless run | headless utility runs get the plugin hooks only when `--plugin-dir` is passed |
| The transcript project slug is the cwd with every non-alphanumeric character replaced by `-` (drive colon included) | `transcript_path` = `<config>\projects\C--Users-...-home\<session>.jsonl` | `Test-SessionBusy` / `update_restart.py` derive the slug that way |

## Captured payloads (2.1.281, paths shortened)

Statusline stdin (one line of the `--dump` file):

```json
{"session_id":"<uuid>","transcript_path":"<config>\\projects\\<slug>\\<uuid>.jsonl","cwd":"<bot>","scratchpad_dir":"...","effort":{"level":"high"},"model":{"id":"claude-sonnet-5","display_name":"Sonnet 5"},"workspace":{"current_dir":"<bot>","project_dir":"<bot>","added_dirs":[]},"version":"2.1.281","output_style":{"name":"default"},"cost":{"total_cost_usd":0.183939,"total_duration_ms":29480,"total_api_duration_ms":2150,"total_lines_added":0,"total_lines_removed":0},"context_window":{"total_input_tokens":45738,"total_output_tokens":4,"context_window_size":1000000,"current_usage":{"input_tokens":2,"output_tokens":4,"cache_creation_input_tokens":45736,"cache_read_input_tokens":0},"used_percentage":5,"remaining_percentage":95},"rate_limits":{"five_hour":{"used_percentage":1,"resets_at":1790278200},"seven_day":{"used_percentage":0,"resets_at":1790546400}}}
```

`resets_at` is a unix epoch (seconds). `rate_limits` is absent for API-key sessions.

SubagentStart:

```json
{"session_id":"<uuid>","transcript_path":"<config>\\projects\\<slug>\\<uuid>.jsonl","cwd":"<bot>","prompt_id":"<uuid>","agent_id":"a1e12105483f28961","agent_type":"general-purpose","hook_event_name":"SubagentStart"}
```

SubagentStop:

```json
{"session_id":"<uuid>","transcript_path":"...","cwd":"<bot>","prompt_id":"<uuid>","permission_mode":"bypassPermissions","agent_id":"a1e12105483f28961","agent_type":"general-purpose","effort":{"level":"high"},"hook_event_name":"SubagentStop","stop_hook_active":false,"agent_transcript_path":"<config>\\projects\\<slug>\\<uuid>\\subagents\\agent-a1e12105483f28961.jsonl","last_assistant_message":"pong","background_tasks":[],"session_crons":[]}
```

Stop:

```json
{"session_id":"<uuid>","transcript_path":"...","cwd":"<bot>","prompt_id":"<uuid>","permission_mode":"bypassPermissions","effort":{"level":"high"},"hook_event_name":"Stop","stop_hook_active":false,"last_assistant_message":"DONE","background_tasks":[],"session_crons":[]}
```

SessionEnd (`/exit`): `{"...","hook_event_name":"SessionEnd","reason":"prompt_input_exit"}`; headless end: `"reason":"other"`.

OTel `api_request` attributes (resource attrs `service.version`, `bot.name` from `OTEL_RESOURCE_ATTRIBUTES`, `user.id`, `session.id` alongside):

```json
{"event.name":"api_request","event.timestamp":"...","event.sequence":22,"model":"claude-sonnet-5","input_tokens":2,"output_tokens":4,"cache_read_tokens":0,"cache_creation_tokens":20886,"cost_usd":0.052259,"cost_usd_micros":52259,"duration_ms":1284,"ttft_ms":1221,"request_id":"req_...","client_request_id":"<uuid>","speed":"normal","query_source":"agent:builtin:general-purpose","effort":"high","agent.name":"general-purpose"}
```

`subagent_completed`: `{"agent_type":"general-purpose","agent.source":"built-in","is_built_in":true,"is_async":false,"total_tokens":20892,"total_tool_uses":0,"duration_ms":1526,"model":"claude-sonnet-5","final_model":"claude-sonnet-5","model_swapped":false}`.

Other event names seen in one session: `user_prompt`, `assistant_response` (`response` is `<REDACTED>` by CC), `tool_decision`, `tool_result`, `hook_registered`, `hook_execution_start/complete`, `plugin_loaded`, `managed_settings_resolved`, `retention_sweep`. Metrics: `claude_code.session.count`, `claude_code.cost.usage`, `claude_code.token.usage`, `claude_code.active_time.total`.
