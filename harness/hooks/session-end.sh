#!/usr/bin/env bash
# SessionEnd hook — release the Telegram single-poller lock (and the plugin's
# own bot.pid) when this session actually owned them, so the NEXT session
# doesn't have to wait out a dead owner. Never touches a live foreign owner's
# lock: only Telegram's getUpdates allows one poller per bot token, so
# stealing a still-live lock would 409 a session that is genuinely running.
#
# STRICTLY FAIL-OPEN: any error here must never fail session end.

set -uo pipefail
. "$(dirname "$0")/_guard.sh" session-end

PAYLOAD=""
if ! [ -t 0 ]; then
  PAYLOAD=$(cat || true)
fi
SESSION_ID=""
REASON=""
if [ -n "$PAYLOAD" ]; then
  PARSED=$("$PY" -c "
import json, sys
try:
    d = json.loads(sys.stdin.read() or '{}')
except Exception:
    d = {}
sys.stdout.write((d.get('session_id') or '') + '\n')
sys.stdout.write((d.get('reason') or '') + '\n')
" <<<"$PAYLOAD" 2>/dev/null || true)
  SESSION_ID=$(printf '%s' "$PARSED" | sed -n '1p')
  REASON=$(printf '%s' "$PARSED" | sed -n '2p')
fi

CONFIG_HOME="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
LOCK_FILE="$CONFIG_HOME/botcorp/tg_owner.lock"
BOT_PID_FILE="$CONFIG_HOME/channels/telegram/bot.pid"

RELEASED=0
if [ -f "$LOCK_FILE" ]; then
  LOCK_PID=$(head -n 1 "$LOCK_FILE" 2>/dev/null | tr -d '\r ' || true)
  # Release when the recorded PID is dead, OR it is this session's own
  # launcher (BOT_LAUNCHER_PID) — never a live foreign owner's lock.
  SHOULD_RELEASE=0
  if [ -n "$LOCK_PID" ]; then
    if [ -n "${BOT_LAUNCHER_PID:-}" ] && [ "$LOCK_PID" = "$BOT_LAUNCHER_PID" ]; then
      SHOULD_RELEASE=1
    else
      # Liveness check WITHOUT os.kill(pid, 0): on Windows that call does not
      # merely probe the process — CPython's os.kill implements signal 0 via
      # OpenProcess(PROCESS_ALL_ACCESS) + TerminateProcess(handle, 0), which
      # actually KILLS a live process if the PID happens to match. That is
      # exactly the "never touch a live foreign owner" failure this hook must
      # avoid, so liveness is checked via `tasklist` (non-destructive) on
      # Windows and real signal-0 os.kill elsewhere. If liveness can't be
      # determined at all, default to "alive" (keep the lock) — an
      # unreleased stale lock is recoverable, a stolen live one is not.
      "$PY" -c "
import os, subprocess, sys
pid_s = sys.argv[1]
try:
    pid = int(pid_s)
except ValueError:
    sys.exit(1)  # unparsable -> not alive -> release
if os.name == 'nt':
    try:
        out = subprocess.run(
            ['tasklist', '/FI', f'PID eq {pid}', '/NH'],
            capture_output=True, text=True, timeout=5,
        )
        alive = str(pid) in (out.stdout or '')
    except Exception:
        alive = True  # can't determine -> assume alive -> keep the lock
    sys.exit(0 if alive else 1)
try:
    os.kill(pid, 0)
except OSError:
    sys.exit(1)  # dead -> release
else:
    sys.exit(0)  # alive -> keep
" "$LOCK_PID" 2>/dev/null
      [ $? -ne 0 ] && SHOULD_RELEASE=1
    fi
  else
    SHOULD_RELEASE=1  # empty/unreadable lock -> nothing to protect
  fi
  if [ "$SHOULD_RELEASE" = "1" ]; then
    rm -f "$LOCK_FILE" 2>/dev/null || true
    rm -f "$BOT_PID_FILE" 2>/dev/null || true
    RELEASED=1
  fi
fi

# Append one activity-log line, best-effort.
STATE_DIR="${BOTCORP_HOME:-$HOME/.botcorp}/state"
BOT_ID="${BOT_NAME:-$(basename "$BOT_HOME")}"
mkdir -p "$STATE_DIR/$BOT_ID" 2>/dev/null || true
EVENTS_FILE="$STATE_DIR/$BOT_ID/events.jsonl"
NOW_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
"$PY" -c "
import json, sys
path, ts, session_id, reason, released = sys.argv[1:6]
line = json.dumps({
    'ts': ts, 'event': 'session_end', 'session_id': session_id,
    'reason': reason, 'released_lock': released == '1',
})
try:
    with open(path, 'a', encoding='utf-8') as f:
        f.write(line + '\n')
except Exception:
    pass
" "$EVENTS_FILE" "$NOW_TS" "$SESSION_ID" "$REASON" "$RELEASED" >/dev/null 2>&1 || true

echo "session-end: reason=${REASON:-unknown} lock_released=$([ "$RELEASED" = "1" ] && echo true || echo false)" >&2
exit 0
