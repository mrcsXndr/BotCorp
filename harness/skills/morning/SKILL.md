---
name: morning
description: Daily morning briefing — calendar, priority emails, open tasks, deadline alerts.
allowed-tools: Bash, Read, Glob, Grep, Write
---

# /morning — Daily Briefing

Run before your first meeting of the day.

The Google steps use the bot's own `tools/google/*.sh`: the harness ships no `tools/google/`. If the bot folder has none, skip those steps and say so.

## Steps

1. **Calendar** — `bash tools/google/calendar.sh today` to list today's events. Highlight recurring meetings the operator has flagged as important (configure in `context/me.md`).

2. **Priority emails** — `bash tools/google/gmail.sh priority` for unread emails matching the operator's priority filter (set the filter in `tools/google/gmail.sh` or via Gmail's `IMPORTANT` label).

3. **Open tasks** — `bash tools/google/gtasks.sh list` for all open Google Tasks, plus any task-board sheet the operator keeps (configure the sheet ID in `CLAUDE.md`).

4. **Deadline / overdue alerts** — if the operator keeps a tracker (TDL sheet, GitHub Projects, Linear), pull items past their ETA. Skip silently if no tracker is configured.

5. **Output format** — ultra-concise, bulleted:

```
## [Date] Morning Briefing

### Calendar
- 09:30 [meeting]
- 14:00 [meeting]

### Priority Emails ([count] unread)
- [from] — [subject]

### Open Tasks ([count])
- [P1] [task] — due [date]

### Deadline Alerts
- [OVERDUE] [item] — ETA was [date]
```

6. Save the briefing to `meetings/daily/YYYY-MM-DD.md` so the operator can scroll back through past briefings.
