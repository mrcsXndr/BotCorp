#!/usr/bin/env bash
# PostToolUse (Edit|Write|MultiEdit|NotebookEdit): warn when the bot just
# modified a TRACKED harness file outside a suggest/* branch.
#
# The harness (<BotCorp>/harness) is shared by every bot on the machine and
# the next `botcorp sync` overwrites it — this is the write-time tripwire for
# a bot editing harness code in place, which would silently diverge that
# checkout from upstream until the next update stomps it. Warn-only, never
# blocks: stdout from a PostToolUse hook is fed back to the model as
# feedback. The `bots/` subtree is excluded — that's per-bot instance state,
# not shared harness code. STRICTLY FAIL-OPEN.

set -uo pipefail
. "$(dirname "$0")/_guard.sh" core-guard

PAYLOAD=""
if ! [ -t 0 ]; then
  PAYLOAD=$(cat || true)
fi
[ -n "$PAYLOAD" ] || exit 0

FILE=$("$PY" -c "
import json, sys
try:
    d = json.loads(sys.stdin.read() or '{}')
    ti = d.get('tool_input') or {}
    print(ti.get('file_path') or ti.get('notebook_path') or '')
except Exception:
    pass
" <<<"$PAYLOAD" 2>/dev/null) || exit 0
[ -n "$FILE" ] || exit 0

BOTCORP=$(cd "$HARNESS/.." 2>/dev/null && pwd) || exit 0

# Normalise both to forward slashes for the containment check.
FILE_N=$(printf '%s' "$FILE" | tr '\\' '/')
BOTCORP_N=$(printf '%s' "$BOTCORP" | tr '\\' '/')
case "$FILE_N" in
  "$BOTCORP_N"/*) : ;;
  *) exit 0 ;;   # outside the BotCorp checkout — a bot's own tree, scratchpads, etc.
esac
REL="${FILE_N#"$BOTCORP_N"/}"

# The bots/ subtree is per-instance state, not shared harness code.
case "$REL" in
  bots/*) exit 0 ;;
esac

# Only tracked files are harness files (a bot's own untracked overlay isn't).
git -C "$BOTCORP" ls-files --error-unmatch -- "$REL" >/dev/null 2>&1 || exit 0

BRANCH=$(git -C "$BOTCORP" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')
case "$BRANCH" in
  suggest/*) exit 0 ;;   # the sanctioned path for harness changes
esac

cat <<EOF
⚠️ HARNESS-CONTRACT WARNING: you just modified a TRACKED harness file
($REL) on branch '$BRANCH'. Harness files are shared by every bot on this
machine and the next update overwrites them. Either put the behavior in your
bot folder (bot.yaml, bot-local rules, memory/) instead, or make the change
on a suggest/<topic> branch and open a PR: \`botcorp suggest <bot> --topic <t>\`.
EOF
exit 0
