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
    enabled: true                      # `botcorp automations pause <bot> <name>` flips this
  - name: incident-watch
    trigger: {interval_min: 5}
    command: "python tools/incidents.py tick --alert"
    timeout_min: 5
    critical: true
```

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
   `critical` -> skipped.
5. `max_per_day` reached (counter resets at local midnight) -> skipped.
6. `idle_gated` and the session is busy -> skipped (retried next tick).

`-RunNow <name>` (the cockpit's "Run now") ignores the schedule and
`max_per_day`, and still respects `timeout_min`. `-DryRun` logs what would run.

## How a run executes

- cwd = `BOT_HOME`; the command goes through `cmd.exe /d /s /c` verbatim, with
  stdout+stderr redirected to the run's log file by cmd itself.
- env = the bot env (`BOT_HOME`, `BOT_NAME`, `BOT_MODULES`, `BOTCORP_HOME`,
  `CLAUDE_CONFIG_DIR`, `CLAUDE_PLUGIN_ROOT`, `PYTHONIOENCODING`) plus
  `BOT_AUTOMATION=<name>`, `BOT_RUN_ID=<run id>`, and every key listed in
  `secrets:` decrypted in-process from the bot's DPAPI vault and injected as
  `<KEY>` (env names are case-insensitive on Windows; `hub_token` ->
  `HUB_TOKEN`). Secrets never touch a command line or a log.
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

Per-automation state lives in `<rt>/state/<bot>/automations.json`:
`failure_streak`, `next_due`, `backoff_min`, `backoff_history` (last 10
`{at, streak, gap_min, next_due}`), `runs_today` / `runs_today_date`,
`last_ok`, `last_start`, `last_end`, `last_exit`, `last_run_id`,
`last_summary`, `running_run_id` / `running_pid` while a run is in progress,
`last_skip` (why it was last skipped). Health for the cockpit and `hub_push`
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
