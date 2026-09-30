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

Uses the bot's own `tools/google/keep.sh`: the harness ships no `tools/google/`. If the bot folder has none, say so instead of running it.

## Commands:

### Create note
Run `bash tools/google/keep.sh create "<text>"` — creates a timestamped note in Google Keep

### List recent
Run `bash tools/google/keep.sh list` — shows last 10 notes

### Search
Run `bash tools/google/keep.sh search "<query>"` — searches note content
