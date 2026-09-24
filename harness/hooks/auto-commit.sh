#!/usr/bin/env bash
# Auto-commit uncommitted changes on session stop.
#
# Module-gated (`auto_commit`). Only runs when BOT_HOME is a git work tree
# AND its origin is NOT the shared BotCorp checkout itself — a bot must never
# auto-commit into the harness repo everyone shares. Commits locally only,
# never pushes, and never skips hooks: the bot repo's own pre-commit secret
# scan (if any) must run like any other commit.

set -uo pipefail
. "$(dirname "$0")/_guard.sh" auto-commit auto_commit

git -C "$BOT_HOME" rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

ORIGIN_URL=$(git -C "$BOT_HOME" remote get-url origin 2>/dev/null || echo "")
case "$ORIGIN_URL" in
  */BotCorp|*/BotCorp.git) exit 0 ;;
esac

if [ -z "$(git -C "$BOT_HOME" status --porcelain)" ]; then
  exit 0
fi
git -C "$BOT_HOME" add -A
git -C "$BOT_HOME" commit -m "chore(auto): session checkpoint $(date +%Y-%m-%d' '%H:%M)" 2>/dev/null || true
exit 0
