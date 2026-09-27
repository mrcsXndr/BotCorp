#!/usr/bin/env bash
# PreToolUse guard (Bash|PowerShell) — a bot never runs the operator-only
# verbs: `botcorp approve|reject` (its own queued widening change) and
# `botcorp accounts use`. The CLI refuses them too
# (BOT_NAME / CLAUDECODE in the env, exit 3); this is the second layer.
#
# Matches the COMMAND field only, never file paths or Grep patterns, so a
# search for the word "approve" is never blocked.
#
# FAIL-CLOSED for the verbs it names (exit 2 blocks the tool call and feeds
# the message back to the model); everything else is a silent exit 0.

set -uo pipefail
. "$(dirname "$0")/_guard.sh" operator-guard

PAYLOAD=""
if ! [ -t 0 ]; then
  PAYLOAD=$(cat || true)
fi
[ -n "$PAYLOAD" ] || exit 0

CMD=$("$PY" -c "
import json, sys
try:
    d = json.loads(sys.stdin.read() or '{}')
    print(str((d.get('tool_input') or {}).get('command') or ''))
except Exception:
    pass
" <<<"$PAYLOAD" 2>/dev/null) || exit 0
[ -n "$CMD" ] || exit 0

CMD_N=$(printf '%s\n' "$CMD" | tr '[:upper:]' '[:lower:]')

if printf '%s\n' "$CMD_N" | grep -qE "botcorp(\.mjs)?[\"']?[[:space:]]+(approve|reject|accounts[[:space:]]+use)([^a-z0-9_-]|$)"; then
  echo "BLOCKED: botcorp approve / reject / accounts use are operator-only. A bot queues a widening change (botcorp config set) and the operator decides it in the cockpit or their own terminal; never approve from a session. To read the queue: botcorp approvals." >&2
  exit 2
fi
exit 0
