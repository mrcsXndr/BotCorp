---
name: notes
description: Quick note capture to Google Keep
allowed-tools: Bash
---

# /notes — Quick Note Capture

Usage:
- `/notes <text>` — create a new Keep note
- `/notes list` — show recent notes
- `/notes search <query>` — search notes

## Commands:

### Create note
Run `bash tools/keep.sh create "<text>"` — creates a timestamped note in Google Keep

### List recent
Run `bash tools/keep.sh list` — shows last 10 notes

### Search
Run `bash tools/keep.sh search "<query>"` — searches note content
