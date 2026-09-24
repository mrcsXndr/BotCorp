#!/usr/bin/env bash
# PreToolUse guard (Read|Glob|Grep|Bash|Edit|Write|MultiEdit|NotebookEdit) —
# block any tool call that touches a bot vault (any bot's, this bot's own
# included — a bot never has a reason to reach into vault files) or the
# secrets CLI's mutating verbs.
#
# FAIL-CLOSED for the things it names (exit 2 blocks the tool call and feeds
# the message back to the model); everything else is a silent exit 0.

set -uo pipefail
. "$(dirname "$0")/_guard.sh" vault-guard

PAYLOAD=""
if ! [ -t 0 ]; then
  PAYLOAD=$(cat || true)
fi
[ -n "$PAYLOAD" ] || exit 0

T=$("$PY" -c "
import json, sys
try:
    d = json.loads(sys.stdin.read() or '{}')
    ti = d.get('tool_input') or {}
    parts = []
    for k in ('file_path', 'notebook_path', 'path', 'pattern', 'glob', 'command'):
        v = ti.get(k)
        if v:
            parts.append(str(v))
    edits = ti.get('edits') or []
    if isinstance(edits, list):
        for e in edits:
            if isinstance(e, dict):
                fp = e.get('file_path')
                if fp:
                    parts.append(str(fp))
    print('\n'.join(parts))
except Exception:
    pass
" <<<"$PAYLOAD" 2>/dev/null) || exit 0
[ -n "$T" ] || exit 0

# Normalise backslashes to forward slashes and lowercase for a
# case-insensitive, separator-insensitive comparison (Windows paths).
T_N=$(printf '%s\n' "$T" | tr '\\' '/' | tr '[:upper:]' '[:lower:]')

BLOCKED=0
MATCHED=""

if printf '%s\n' "$T_N" | grep -qE '(^|/)\.vault(/|$)'; then
  BLOCKED=1; MATCHED=".vault (a bot's secrets vault directory)"
elif printf '%s\n' "$T_N" | grep -qE '(secrets|vault|accounts)\.ps1'; then
  BLOCKED=1; MATCHED="secrets.ps1/vault.ps1/accounts.ps1"
elif printf '%s\n' "$T_N" | grep -qE 'botcorp.*secrets.*(get|unlock|lock|import-bundle|export-bundle|migrate)'; then
  BLOCKED=1; MATCHED="botcorp secrets get/unlock/lock/import-bundle/export-bundle/migrate"
elif printf '%s\n' "$T_N" | grep -qE 'protecteddata'; then
  BLOCKED=1; MATCHED="ProtectedData (the DPAPI API)"
elif printf '%s\n' "$T_N" | grep -qE 'secret-access\.jsonl'; then
  BLOCKED=1; MATCHED="secret-access.jsonl (the secrets audit log)"
fi

[ "$BLOCKED" = "1" ] || exit 0

echo "BLOCKED: $MATCHED is the secrets vault / secrets CLI. Bots never read or write vault files; the daemon injects declared keys at launch (bot.yaml secrets:). Use botcorp secrets set|list via the operator, never from a session." >&2
exit 2
