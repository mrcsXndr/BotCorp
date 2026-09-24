---
name: tasks
description: Manage Google Tasks — list, add, complete.
allowed-tools: Bash, Read
---

# /tasks — Google Tasks Manager

Usage:
- `/tasks` — show all open tasks
- `/tasks add <title>` — add a new task
- `/tasks done <task-id>` — mark a task complete

## Commands

### List tasks
Run `bash tools/google/gtasks.sh list` and format as:
```
## Open Tasks
**[List Name]**
- [ ] [title] — due [date]
```

### Add task
`bash tools/google/gtasks.sh add "<title>"` with optional `--due YYYY-MM-DD` and `--list <list-name>`.

### Complete task
`bash tools/google/gtasks.sh complete "<task-id>"`.

## Optional: sync with a backlog sheet

If the operator keeps a Google Sheet as the canonical task board, you can write a small sync script that pulls items assigned to them and mirrors them into Google Tasks. Pattern lives in `tools/google/sheets.sh` — wire it up if the operator asks.
