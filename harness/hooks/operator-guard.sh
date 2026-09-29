#!/usr/bin/env bash
# PreToolUse guard (Bash|PowerShell) — a bot never runs the operator-only
# verbs: `botcorp approve|reject` (its own queued widening change), `accounts
# add|remove|seed|use|backups`, `secrets set|delete`, `pair <id>`, `update
# --apply|--skip`, start/stop/restart of another bot, `cockpit expose|unexpose`.
# An admin bot (bot.yaml role: admin, its launch id matching; `botcorp
# whoami`) may run all of them but the last. The CLI refuses them too
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
BC="botcorp(\.mjs)?[\"']?[[:space:]]+"

# Never from a session, admin bot or not.
if printf '%s\n' "$CMD_N" | grep -qE "${BC}cockpit[[:space:]]+(expose|unexpose)([^a-z0-9_-]|$)"; then
  echo "BLOCKED: botcorp cockpit expose / unexpose are the operator's alone (an admin bot cannot run them either)." >&2
  exit 2
fi

# The operator-only verbs an admin bot (bot.yaml role: admin) may run, and
# start/stop/restart of a bot other than this session's own.
NEED=""
if printf '%s\n' "$CMD_N" | grep -qE "${BC}(approve|reject|accounts[[:space:]]+(use|add|remove|seed|backups)|secrets[[:space:]]+(set|delete)|pair[[:space:]]+[a-z0-9_-]+[[:space:]]+[0-9]+|update[[:space:]].*--(apply|skip))([^a-z0-9_-]|$)"; then
  NEED="operator-only verb"
else
  OTHER=$(printf '%s\n' "$CMD_N" | grep -oE "${BC}(start|stop|restart)[[:space:]]+_?[a-z0-9][a-z0-9-]*" | awk '{print $NF}' | grep -vxF -- "${BOT_NAME:-}" | head -n 1)
  [ -n "$OTHER" ] && NEED="start/stop/restart of another bot ($OTHER)"
fi
[ -n "$NEED" ] || exit 0

# An admin bot passes: `botcorp whoami` judges THIS session's own env (its
# BOT_NAME and launch id), never what the command sets inline. Anything that
# fails to answer is a no.
WHO=$(node "$HARNESS/../cli/botcorp.mjs" whoami --json 2>/dev/null) || WHO=""
ADMIN=$("$PY" -c "
import json, sys
try:
    print('yes' if json.loads(sys.stdin.read()).get('admin') is True else 'no')
except Exception:
    print('no')
" <<<"$WHO" 2>/dev/null)
[ "$ADMIN" = "yes" ] && exit 0

echo "BLOCKED: $NEED: operator-only (or an admin bot: bot.yaml role: admin). botcorp approve / reject, accounts add|remove|seed|use|backups, secrets set|delete, pair <id>, update --apply|--skip and start/stop/restart of another bot are the operator's. A bot queues a widening change (botcorp config set) and the operator decides it in the cockpit or their own terminal. To read the queue: botcorp approvals." >&2
exit 2
