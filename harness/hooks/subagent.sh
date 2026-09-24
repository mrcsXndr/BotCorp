#!/usr/bin/env bash
# SubagentStart / SubagentStop hook: usage $1 = start|stop.
#
# No credibility-grading envelope here (measured as pure cost in the source
# bot: a zero-LLM stub with no caller) — this only appends one activity-log
# line per event so subagent volume/shape is visible, plus a one-time raw-key
# dump per event kind so the real payload schema is learned from live traffic
# rather than guessed. Never logs the full prompt — summary is capped at 120
# chars of description (or prompt if no description), start events only.
#
# STRICTLY FAIL-OPEN: any error here must never fail the hook.

set -uo pipefail
KIND="${1:-}"
. "$(dirname "$0")/_guard.sh" subagent

PAYLOAD=""
if ! [ -t 0 ]; then
  PAYLOAD=$(cat || true)
fi

STATE_DIR="${BOTCORP_HOME:-$HOME/.botcorp}/state"
BOT_ID="${BOT_NAME:-$(basename "$BOT_HOME")}"
mkdir -p "$STATE_DIR/$BOT_ID" 2>/dev/null || true
SUBAGENTS_FILE="$STATE_DIR/$BOT_ID/subagents.jsonl"
EVENTS_FILE="$STATE_DIR/$BOT_ID/events.jsonl"
NOW_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

"$PY" -c "
import json, sys
path, ts, kind = sys.argv[1:4]
try:
    d = json.loads(sys.stdin.read() or '{}')
except Exception:
    d = {}
summary = ''
if kind == 'start':
    desc = d.get('description')
    prompt = d.get('prompt')
    src = desc if desc else (prompt if prompt else '')
    summary = str(src)[:120]
entry = {
    'ts': ts, 'event': kind, 'session_id': d.get('session_id') or '',
    'agent_id': d.get('agent_id') or '', 'agent_type': d.get('agent_type') or '',
    'parent_agent_id': d.get('parent_agent_id') or '', 'summary': summary,
}
if kind == 'stop' and 'exit_code' in d:
    entry['exit_code'] = d.get('exit_code')
try:
    with open(path, 'a', encoding='utf-8') as f:
        f.write(json.dumps(entry) + '\n')
except Exception:
    pass
" "$SUBAGENTS_FILE" "$NOW_TS" "$KIND" <<<"$PAYLOAD" >/dev/null 2>&1 || true

# Learn the real payload schema from live traffic: mirror just the KEY NAMES
# (never values) into events.jsonl, once per event kind.
"$PY" -c "
import json, sys
path, ts, kind = sys.argv[1:4]
try:
    d = json.loads(sys.stdin.read() or '{}')
except Exception:
    d = {}
keys = sorted(d.keys()) if isinstance(d, dict) else []
entry = {'ts': ts, 'event': f'subagent_{kind}_keys', 'keys': keys}
try:
    with open(path, 'a', encoding='utf-8') as f:
        f.write(json.dumps(entry) + '\n')
except Exception:
    pass
" "$EVENTS_FILE" "$NOW_TS" "$KIND" <<<"$PAYLOAD" >/dev/null 2>&1 || true

exit 0
