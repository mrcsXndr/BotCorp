# Automations

A bot's recurring jobs are first-class objects declared in its `bot.yaml`
under `automations:` and run by the ONE machine daemon
(`daemon/automations.ps1`, called for every bot on every tick). There are no
per-bot scheduled tasks: adding a job is a YAML entry, never a task.

```yaml
automations:
  - name: issue-triage                 # slug [a-z0-9][a-z0-9_-]{0,63}; also the log folder name
    trigger: {cron: "*/30 * * * *"}    # cron | interval_min: N | event: <name>
    command: "python tools/triage.py scan"   # run with cwd = this bot folder (BOT_HOME)
    secrets: [gitlab_token]            # vault keys injected as env for this run only
    timeout_min: 20                    # hard limit; the whole process tree is killed on overrun
    backoff: {base_min: 10, max_min: 240}   # after a failure: 10, 20, 40, ... capped; reset on success
    max_per_day: 12                    # 0 / absent = unlimited
    idle_gated: true                   # only while this bot's session is idle (same gate as every restart)
    critical: false                    # true = keeps running while the bot's Claude account is usage-blocked
    verify: {fresh: memory/triage.md, max_age_min: 30}   # optional, kind: command only: see Records
    enabled: true                      # `botcorp automations pause <bot> <name>` flips this
  - name: incident-watch
    trigger: {interval_min: 5}
    command: "python tools/incidents.py tick --alert"
    timeout_min: 5
    critical: true
  - name: morning-standup
    kind: prompt                       # typed into the bot's live session instead of running a command
    prompt: "/standup"
    trigger: {cron: "37 8 * * 1-5"}
```

`kind` is `command` (the default, so an entry without `kind` is a command) or
`prompt`. A `prompt` entry needs `prompt:` and must not have `command:`; a
`command` entry must not have `prompt:`. `bot.yaml` validation rejects both
mixes.

## Built-in automations (harness modules)

A module can bring its own job. It runs exactly like a `bot.yaml` entry
(schedule, account-aware vault token, timeout, `runs.jsonl`, failure alerts)
but is defined in `daemon/automations.ps1` (`Get-BuiltinAutomations`), not in
`bot.yaml`; a `bot.yaml` entry of the same name replaces it.

| module | job | what it does |
|---|---|---|
| `timeline_summary` | `timeline-summary`, every 60 min, `secrets: [oauth_token]`, 10 min | `timeline.py summarize-stale`: LLM-distils the current session's timeline when it is missing or structural, then the current ISO week's `memory/timelines/<week>.md` when the PreCompact hook left it concatenated. Hooks get no Claude credentials, so every hook-built timeline is structural; this run has the vault token. Model: the workhorse tier of `harness/models.json`. Exit 1 when the distill fell back, so three misses in a row reach alerts.log. |

## Prompt automations (`kind: prompt`)

A prompt automation puts one prompt into the bot's running Claude Code session
on a schedule, as if the operator had typed it in the cockpit. It uses the
cockpit chat's own path, the bot's inbox: the run is `botcorp send <bot>
--wait --source automation` (docs/cli.md "send"), whose drainer types the
prompt through the bot's pty-host as a bracketed paste plus Enter.

- `session: pty`: the pty-host is the session.
- `session: bg`: the pty-host is only the attach transport. When none is up,
  the drainer starts one (`pty-host --attach`), which stays up for the next
  message and exits on its own after `BOTCORP_ATTACH_IDLE_MIN` with no client.
  It only ever holds the `claude attach` client; the session keeps running.

The run counts as **sent** when the inbox reports the item delivered: the
prompt showed up as a user turn in the session transcript within 30 s.
Anything else is **failed**, with the inbox's status and reason (`failed:
expired <id>: waited past its ttl (300s)`). The item's ttl is half the run's
`timeout_min`, between 15 s and 5 min, so a prompt queued behind another
message never lands late, and an expiry is recorded before the run times out.

A due fire is **skipped**, with the reason recorded, when the session's phase
(a fresh `botcorp observe <bot>`, docs/daemon.md "State file") is not `idle`:

1. the session is down (`down` or `stopped`): no live pty-host and no live
   claude pid;
2. the session is `blocked` on a login, usage-limit or trust dialog, because
   typed text plus Enter could answer it. A session whose last turn merely
   ended asking something is not blocked: it takes the prompt;
3. the session is busy (`working`, `starting` or `unknown`: the transcript
   was written in the last 5 min and no breakpoint is declared, the same
   semantics as `Test-SessionBusy`), or observe could not run (`session state
   unknown (observe failed)`);
4. the account is usage-blocked and the entry is not `critical`;
5. `max_per_day` has been reached.

A skipped or failed fire is **dropped, never held**. It is not queued, not
retried each tick, and gets no backoff. The next scheduled fire is the next
chance, because a morning prompt typed at noon would land out of context. An
`event:` trigger's queue file is consumed by the skip too. `idle_gated` makes
no difference here: gate 3 always applies.

The prompt is operator config and treated as trusted. It reaches `botcorp
send` on stdin, never on a command line. Logs show only its first 60
characters; the inbox file (`<rt>/state/<bot>/inbox.jsonl`) keeps it whole.

## Triggers

| trigger | due when |
|---|---|
| `cron: "m h dom mon dow"` | the first matching minute after the last run (or after the entry was first seen; it never fires immediately on creation). Fields: `*`, `*/n`, `a,b`, `a-b`, `a-b/n`; `dow` 0-7 with 7 = Sunday; when both `dom` and `dow` are restricted either one matching counts (standard cron) |
| `interval_min: N` | immediately on first sight, then N minutes after each successful run |
| `event: <name>` | a file `<rt>/state/<bot>/events/<name>.queue` exists and is non-empty. Hooks and the daemon drop these (`alerts_log`, `board_ready`, `tg_inbound`, `session_stop`, `harness_updated`); the queue file is consumed when the run starts |

After a failure the next due time is `end + backoff` regardless of trigger,
with backoff = `min(base_min * 2^(streak-1), max_min)`; a success resets the
streak and the interval/cron schedule resumes from the end of that run.

## Gates, in order

1. `enabled: false` -> skipped (logged once per change, not every tick).
2. A run of this automation is still in progress -> skipped.
3. Not due -> skipped.
4. The bot's Claude account is usage-blocked (`<rt>/state/accounts.json`
   names the bot with a future `blocked_until`) and the entry is not
   `critical` -> skipped. The `bots` lists there follow the ACTIVE account, so
   a bot that failed over to a clear account keeps its non-critical jobs
   running (docs/daemon.md, "Failover and failback").
5. `max_per_day` reached (counter resets at local midnight) -> skipped.
6. `idle_gated` and the session is busy (its observed phase is `working`,
   `starting` or `unknown`, or observe could not run) -> skipped (retried
   next tick).

A `kind: prompt` entry has its own gates (see above), and a prompt that is
gated there is dropped until the next fire instead of being retried.

The cockpit's "Run now" and `botcorp automations <bot> run <name>` only
append the name to `events/run-now.queue`; the next pass runs it regardless
of its schedule, but it still obeys `max_per_day`, the account usage block,
`idle_gated` and `timeout_min`, and it is dropped when the job is disabled
or still running. Only calling `automations.ps1 -RunNow <name>` directly also
skips `max_per_day`. `-DryRun` logs what would run.

## How a run executes

- cwd = `BOT_HOME`; the command goes through `cmd.exe /d /s /c` verbatim, with
  stdout+stderr redirected to the run's log file by cmd itself, the command
  grouped (`cmd /d /s /c "(<command>) > <log> 2>&1"`) so every part of a
  chained `a & b` / `a && b` reaches the log; the exit code is the group's
  (its last command's). An unquoted `)` in the command ends the group early:
  quote it. Before that, `${PY}` becomes the quoted python path, `${HARNESS}`
  `<BotCorp>/harness` and `${BOTCORP}` the checkout root.
- env = the bot env (`BOT_HOME`, `BOT_NAME`, `BOT_MODULES`, `BOTCORP_HOME`,
  `CLAUDE_CONFIG_DIR`, `CLAUDE_PLUGIN_ROOT`, `PYTHONIOENCODING`) plus
  `BOT_AUTOMATION=<name>`, `BOT_RUN_ID=<run id>`, `BOT_TG_SCHEDULED=1` (so a
  `tg_send.py` inside `integrations.telegram.quiet` goes to alerts.log
  instead of the phone), and every key listed in
  `secrets:` decrypted in-process from the bot's DPAPI vault and injected as
  `<KEY>` (env names are case-insensitive on Windows; `hub_token` ->
  `HUB_TOKEN`; `oauth_token` also as `CLAUDE_CODE_OAUTH_TOKEN`, the session's
  name for it). That `oauth_token` follows the session's ACTIVE account: state
  `account_active.id` while it is still in the bot's chain, else `bot.yaml`
  `account`. An inherited `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`
  (a machine-wide one is another account's) is removed from every job's env.
  Secrets never touch a command line or a log. Every key an
  automation lists must also be in the bot's top-level `secrets:` list
  (`bot.yaml` validation rejects it otherwise); that list is also what the
  launcher injects into the SESSION env (docs/daemon.md, "Session secrets").
- `timeout_min > 0.5` -> the run is spawned DETACHED with its own waiter
  (`automations.ps1 -Bot <bot> -ExecJob <job file>`, internal) so the daemon
  mutex is never held across it; shorter runs execute inline. On overrun the
  waiter tree-kills it (`taskkill /T /F`) and records exit `124`.
- Adding a `secrets:` key by chat is a widening change: the guarded config
  writer queues it for operator approval.

## Records

Every run appends one line to `<rt>/state/<bot>/runs.jsonl`:

```json
{"automation":"issue-triage","run_id":"20260101-070000-3f2a","start":"...","end":"...","exit":0,"duration_s":12.4,"summary":"SUMMARY: 3 issues triaged","log":"<rt>/logs/<bot>/issue-triage/20260101-070000-3f2a.log"}
```

`summary` = the first output line starting with `SUMMARY:` (print one; it is
what the cockpit and the hub show), else the last non-empty line, 200 chars.
`exit` is the command's exit code, `124` on timeout, `127` when it could not be
launched.

Exit 0 alone is not success when the entry has `verify: {fresh: <file>,
max_age_min: N}` (the file relative to the bot folder, or absolute): after a
run that exited 0 the file must exist and be at most N minutes old. The
record carries `verify: ok` or `verify: miss: <missing | M min old>`, and a
miss appends one line to the bot's `memory/metrics/alerts.log`, which alert
triage reads. A failure streak reaching 3 appends ONE alerts.log line for
that streak; a success re-arms it (`streak_alerted` in the state below).

A prompt automation's record also carries `result`: `sent`,
`failed: <why>`, or `skipped: <reason>`. A skip writes a record with
`exit: null` and `log: null`. The daily rollup and the hub leave skips out,
because nothing ran. `botcorp status` and `botcorp automations <bot> list`
show each entry's `last_result`. The cockpit's runs drawer shows the outcome
in place of the exit code.

Per-automation state lives in `<rt>/state/<bot>/automations.json`:
`failure_streak`, `next_due`, `backoff_min`, `backoff_history` (last 10
`{at, streak, gap_min, next_due}`), `runs_today` / `runs_today_date`,
`last_ok`, `last_start`, `last_end`, `last_exit`, `last_run_id`,
`last_summary`, `running_run_id` / `running_pid` while a run is in progress,
`last_skip` (why it was last skipped), `last_result` (prompt automations),
`streak_alerted` (when the current failure streak was reported). Health for the cockpit and `hub_push`
(`name, last_ok_age_s, failure_streak, runs_today`) is read from here.

Retention: per-automation logs are kept 14 days or 50 MB (oldest deleted
first); `runs.jsonl` is rotated at 10 MB (one previous file kept); once a day
the previous day's rows are appended to the bot's tracked
`memory/metrics/automations.csv` (`date,automation,runs,failures,avg_s`) so a
bot's own history survives a runtime-state wipe.

## Writing a good automation

- Print `SUMMARY: <one line>` as the first line of output; keep the rest as
  detail for the log.
- Exit non-zero only for a real failure: it triggers backoff and counts in the
  rollup. A "nothing to do" run is a success.
- Self-alert through the bot's own channel (`tools/tg/tg_send.py --alert`),
  not through the daemon; the daemon records, it does not message.
- Keep `timeout_min` a backstop against a hang, not a cap on normal work:
  measure a few runs before tightening it.
- Set `idle_gated: true` for anything that commits in the bot's tree or
  spawns a headless model run; the bot's live session is the one writer.

## Test seam

`BOTCORP_FAKE_NOW=<ISO timestamp>` overrides "now" for scheduling (due,
`next_due`, the daily counter's date, run start/end stamps). Process ages,
file mtimes and the daemon log stamps stay real. Six ticks one fake minute
apart exercise an `interval_min: 1` entry six times in a few real seconds.
