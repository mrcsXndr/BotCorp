#!/usr/bin/env bash
# StopFailure hook (matcher: rate_limit) — record a usage-limit block so the
# quota auto-resume loop (tools/v2/usage_monitor.py) can act on it, and log
# the event for the bot's own activity history.
#
# STRICTLY FAIL-OPEN: any error here must never fail the hook.

set -uo pipefail
. "$(dirname "$0")/_guard.sh" stop-failure

PAYLOAD=""
if ! [ -t 0 ]; then
  PAYLOAD=$(cat || true)
fi

printf '%s' "$PAYLOAD" | "$PY" "$HARNESS/tools/v2/usage_monitor.py" record-block --stdin >/dev/null 2>&1 || true

STATE_DIR="${BOTCORP_HOME:-$HOME/.botcorp}/state"
BOT_ID="${BOT_NAME:-$(basename "$BOT_HOME")}"
mkdir -p "$STATE_DIR/$BOT_ID" 2>/dev/null || true
EVENTS_FILE="$STATE_DIR/$BOT_ID/events.jsonl"
NOW_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
"$PY" -c "
import json, sys
path, ts = sys.argv[1:3]
try:
    d = json.loads(sys.stdin.read() or '{}')
except Exception:
    d = {}
line = json.dumps({
    'ts': ts, 'event': 'stop_failure',
    'error_code': d.get('error_code') or d.get('errorCode') or '',
    'message': str(d.get('message') or '')[:200],
})
try:
    with open(path, 'a', encoding='utf-8') as f:
        f.write(line + '\n')
except Exception:
    pass
" "$EVENTS_FILE" "$NOW_TS" <<<"$PAYLOAD" >/dev/null 2>&1 || true

exit 0
