#!/usr/bin/env bash
# PostToolUse (Edit|Write|MultiEdit|NotebookEdit): warn when the bot just
# modified a TRACKED harness file outside a suggest/* branch.
#
# The harness (<BotCorp>/harness) is shared by every bot on the machine, and
# daemon/update.ps1 refuses a dirty tree — this is the write-time tripwire for
# a bot editing engine code in place, which would silently block every future
# update until the edit is reverted. Warn-only, never
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

# Normalise both to forward slashes for the containment check. On Windows the
# payload path is C:\... but Git Bash's pwd is /c/..., so compare both in the
# drive-letter form (pwd -W), case-insensitively like the filesystem.
FILE_N=$(printf '%s' "$FILE" | tr '\\' '/')
BOTCORP_N=$(printf '%s' "$BOTCORP" | tr '\\' '/')
FILE_CMP=$FILE_N
BOTCORP_CMP=$BOTCORP_N
if BOTCORP_W=$(cd "$BOTCORP" 2>/dev/null && pwd -W 2>/dev/null) && [ -n "$BOTCORP_W" ]; then
  BOTCORP_N=$BOTCORP_W
  case "$FILE_N" in
    /[a-zA-Z]/*) FILE_N="${FILE_N:1:1}:${FILE_N:2}" ;;
  esac
  FILE_CMP=$(printf '%s' "$FILE_N" | tr '[:upper:]' '[:lower:]')
  BOTCORP_CMP=$(printf '%s' "$BOTCORP_N" | tr '[:upper:]' '[:lower:]')
fi
case "$FILE_CMP" in
  "$BOTCORP_CMP"/*) : ;;
  *) exit 0 ;;   # outside the BotCorp checkout — a bot's own tree, scratchpads, etc.
esac
REL="${FILE_N:$((${#BOTCORP_N} + 1))}"

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
⚠️ HARNESS-CONTRACT WARNING: you just modified a TRACKED BotCorp file
($REL) on branch '$BRANCH'. This checkout is shared by every bot on this
machine, and the updater refuses a dirty tree: until this edit is reverted it
blocks every future engine update. Revert it (\`git -C "$BOTCORP_N" checkout -- $REL\`)
and put the behavior in your bot folder (bot.yaml, bot-local rules, memory/)
instead, or make the change on a suggest/<topic> branch and open a PR:
\`botcorp suggest <bot> --topic <t>\`.
EOF
exit 0
