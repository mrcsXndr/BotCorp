#!/usr/bin/env bash
# Auto-commit uncommitted changes on session stop, and push them when the bot
# has a backup remote.
#
# Module-gated (`auto_commit`). Only runs when BOT_HOME is a git work tree
# AND its origin is NOT the shared BotCorp checkout itself — a bot must never
# auto-commit into the harness repo everyone shares. Never skips hooks: the bot
# repo's own pre-commit secret scan (if any) must run like any other commit.
#
# Push: only with the `backup` module (bot.yaml backup.git_remote set, which
# puts `backup` in BOT_MODULES), only from the bot folder's OWN repo (a .git
# in BOT_HOME, never a checkout above it) and only to an origin that already
# exists (`botcorp backup <bot>` adds it). Background + non-interactive + 60 s
# bound, so a credential prompt (session 0 has no credential UI) can never
# hang the Stop hook. It runs on a clean tree too, so a failed push is retried
# on the next stop. One line per attempt in <BOTCORP_HOME>/state/<bot>/push.log.

set -uo pipefail
. "$(dirname "$0")/_guard.sh" auto-commit auto_commit

git -C "$BOT_HOME" rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

ORIGIN_URL=$(git -C "$BOT_HOME" remote get-url origin 2>/dev/null || echo "")
case "$ORIGIN_URL" in
  */BotCorp|*/BotCorp.git) exit 0 ;;
esac

if [ -n "$(git -C "$BOT_HOME" status --porcelain)" ]; then
  git -C "$BOT_HOME" add -A
  git -C "$BOT_HOME" commit -m "chore(auto): session checkpoint $(date +%Y-%m-%d' '%H:%M)" 2>/dev/null || true
fi

case ",${BOT_MODULES:-}," in
  *",backup,"*) : ;;
  *) exit 0 ;;
esac
[ -e .git ] || exit 0   # _guard.sh cd'd into BOT_HOME
[ -n "$ORIGIN_URL" ] || exit 0
BRANCH=$(git -C "$BOT_HOME" symbolic-ref -q --short HEAD 2>/dev/null) || exit 0
AHEAD=$(git -C "$BOT_HOME" rev-list --count HEAD --not --remotes=origin 2>/dev/null || echo 0)
[ "${AHEAD:-0}" -gt 0 ] 2>/dev/null || exit 0

# GNU timeout only: on Windows a bare `timeout` can resolve to timeout.exe,
# which takes no command.
TO=()
if [ -x /usr/bin/timeout ]; then TO=(/usr/bin/timeout 60)
elif timeout --version >/dev/null 2>&1; then TO=(timeout 60)
fi
STATE_DIR="${BOTCORP_HOME:-$HOME/.botcorp}/state"
BOT_ID="${BOT_NAME:-$(basename "$BOT_HOME")}"
mkdir -p "$STATE_DIR/$BOT_ID" 2>/dev/null || true
PUSH_LOG="$STATE_DIR/$BOT_ID/push.log"
(
  GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never ${TO[@]+"${TO[@]}"} \
    git -C "$BOT_HOME" -c credential.interactive=never push -q origin "HEAD:refs/heads/$BRANCH" >/dev/null 2>&1
  rc=$?
  printf '%s push %s ahead=%s rc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$BRANCH" "$AHEAD" "$rc" >> "$PUSH_LOG" 2>/dev/null
  if [ "$(wc -l < "$PUSH_LOG" 2>/dev/null || echo 0)" -gt 1000 ]; then
    tail -n 500 "$PUSH_LOG" > "$PUSH_LOG.tmp" 2>/dev/null && mv -f "$PUSH_LOG.tmp" "$PUSH_LOG" 2>/dev/null
  fi
) </dev/null >/dev/null 2>&1 &
exit 0
