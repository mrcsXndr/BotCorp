#!/usr/bin/env bash
# SessionStart hook
# - Injects last-session context + git log
# - Ensures memory/sessions/<session_id>/journal.md exists and loads
#   journal + timeline into the system prompt (NOT chat history) via
#   additionalContext.
# - Refreshes the cross-session recall index, emits a memory-budget header,
#   surfaces due commitments, and injects the condensed persistent TDL.
# - Records this bot's harness version/session into the runtime state file.
# - Injects the harness lessons index when the `lessons` module is enabled.
#
# The steps run in ONE python process (session_start.py): as ~35 bash forks
# they cost 200 ms or more each under Git Bash and blew the hook's timeout.
#
# STRICTLY FAIL-OPEN: every step swallows its own errors; this hook must
# never break session start.

set -uo pipefail
case "$0" in */*|*\\*) _hooks="${0%[/\\]*}" ;; *) _hooks=. ;; esac  # dirname without a fork
. "$_hooks/_guard.sh" session-start

"$PY" "$HARNESS/hooks/session_start.py" "$BOT_HOME" "$HARNESS" \
  || printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":""}}'
exit 0
