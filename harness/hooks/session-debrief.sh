#!/usr/bin/env bash
# Stop hook: background subagent reviews the session and updates context docs.
# Runs async — does not block the user's exit.
#
# Module-gated (`debrief`): a bot turns this off entirely via bot.yaml
# harness.modules (-> BOT_MODULES), no separate .env feature flag needed.

set -uo pipefail
. "$(dirname "$0")/_guard.sh" session-debrief debrief

TIMESTAMP=$(date "+%Y-%m-%d %H:%M")

INPUT=$(cat 2>/dev/null || echo '{}')

RECENT_CHANGES=$(git log --oneline -10 2>/dev/null || echo "no git history")
CHANGED_FILES=$(git diff --name-only HEAD~3 HEAD 2>/dev/null | head -20 || echo "unknown")

PROMPT="You are a session debrief agent. Your job is to:
1. Append a SHORT (3-5 line) entry to context/session-log.md
2. Check if any context docs need updating
3. Commit changes with 'chore(auto): session debrief update'

Recent git log:
$RECENT_CHANGES

Changed files:
$CHANGED_FILES

Format:
## $TIMESTAMP
- **Task:** [what was done]
- **Decisions:** [key decisions]
- **Open:** [pending items]

Rules: keep SHORT, only update docs if meaningful, commit silently, no push"

# Time-gate: Stop fires EVERY turn; each debrief is a headless claude run
# (real spend). One per window is plenty.
GATE_FILE="$BOT_HOME/.claude/.debrief_last_ts"
GATE_SECONDS=$(( ${BOT_DEBRIEF_GATE_HOURS:-6} * 3600 ))
NOW=$(date +%s)
if [ -f "$GATE_FILE" ]; then
  LAST=$(cat "$GATE_FILE" 2>/dev/null || echo 0)
  case "$LAST" in (*[!0-9]*|'') LAST=0;; esac
  [ $(( NOW - LAST )) -lt "$GATE_SECONDS" ] && exit 0
fi
echo "$NOW" > "$GATE_FILE" 2>/dev/null || true

# Run claude headless in background. CRITICAL:
# - --setting-sources user skips the PROJECT settings — the repo-local
#   enabledPlugins would otherwise load the telegram plugin in this throwaway
#   session, which STEALS the getUpdates slot from the real bot.
# - run_hidden.py spawns it DETACHED + CREATE_NO_WINDOW so no console window
#   ever pops (nohup does NOT prevent Windows console allocation).
# - BOT_TG_MUTE=1 on the child so any TG-aware tool it touches stays silent —
#   this is a background context-doc pass, not a channel the operator sees.
PROMPT_FILE="$BOT_HOME/.claude/.debrief_prompt.txt"
printf '%s' "$PROMPT" > "$PROMPT_FILE" 2>/dev/null || exit 0
export BOT_TG_MUTE=1
"$PY" "$HARNESS/tools/v2/run_hidden.py" --prompt-file "$PROMPT_FILE" -- \
  claude --print --model sonnet --dangerously-skip-permissions \
  --setting-sources user -p @PROMPT@ 2>/dev/null || true

exit 0
