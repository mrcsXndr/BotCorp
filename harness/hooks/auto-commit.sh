#!/usr/bin/env bash
# Auto-commit uncommitted changes on session stop.
#
# Module-gated (`auto_commit`). Only runs when the session is inside the bot's
# own home — BOT_HOME/BOT_NAME as the LAUNCHER set them (a `bots/<name>` folder,
# never _guard.sh's cwd fallback), the session cwd is inside that folder, and
# the folder is itself the root of a git work tree whose origin is NOT the
# shared BotCorp checkout — a bot must never auto-commit into the harness repo
# everyone shares, and a `--plugin-dir` smoke run from some other repo must
# never commit there either (it did, before this check: the Stop hook landed
# checkpoint commits in whatever repo the session happened to sit in).
# Commits locally only, never pushes, and never skips hooks: the bot repo's
# own pre-commit secret scan (if any) must run like any other commit.

set -uo pipefail
SESSION_CWD="${CLAUDE_PROJECT_DIR:-$PWD}"
LAUNCH_HOME="${BOT_HOME:-}"
LAUNCH_NAME="${BOT_NAME:-}"
. "$(dirname "$0")/_guard.sh" auto-commit auto_commit

[ -n "$LAUNCH_HOME" ] && [ -n "$LAUNCH_NAME" ] || exit 0
case "$(printf '%s' "$LAUNCH_HOME" | tr '\\' '/' | sed 's#/*$##')" in
  */bots/"$LAUNCH_NAME") ;;
  *) exit 0 ;;
esac

# Both must resolve to the same git work tree, and that tree's root must be
# the bot home itself (not a parent repo the bot folder happens to sit in).
HOME_TOP=$(git -C "$LAUNCH_HOME" rev-parse --show-toplevel 2>/dev/null) || exit 0
CWD_TOP=$(git -C "$SESSION_CWD" rev-parse --show-toplevel 2>/dev/null) || exit 0
# --show-prefix is the bot home's path relative to its work-tree root: empty
# means the home IS the root. (git prints both paths in one form, unlike `pwd`
# on Windows, so this needs no path normalisation.)
HOME_PREFIX=$(git -C "$LAUNCH_HOME" rev-parse --show-prefix 2>/dev/null) || exit 0
[ -n "$HOME_TOP" ] && [ "$HOME_TOP" = "$CWD_TOP" ] && [ -z "$HOME_PREFIX" ] || exit 0

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
