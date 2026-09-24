#!/usr/bin/env bash
# _guard.sh — sourced first by EVERY harness hook:  . "$(dirname "$0")/_guard.sh" <hook-name> [module]
#
# 1. Opt-out gates. BOT_DISABLED_HOOKS (comma list of hook names) and BOT_MODULES
#    (comma list of enabled modules; unset = all) come from the launcher, which
#    derives them from bot.yaml. A disabled hook exits 0 HERE, before the caller
#    runs a single line — `exit` inside a sourced file ends the calling script.
# 2. Resolves the paths every hook needs:
#      BOT_HOME   the bot folder (BOT_HOME > CLAUDE_PROJECT_DIR > cwd); hooks cd there
#      HARNESS    <BotCorp>/harness (this plugin; CLAUDE_PLUGIN_ROOT when set)
#      PY         the python interpreter (BOT_PYTHON > python3 > python), pinned
#                 once here instead of in every hook, because the WindowsApps
#                 `python` alias has bitten a hook that resolved it ad hoc.
# 3. Exports PYTHONIOENCODING so Windows consoles never trip on UTF-8 output.
#
# STRICTLY FAIL-OPEN: nothing in here may fail the hook. No `set -e`.

HOOK_NAME="${1:-}"
HOOK_MODULE="${2:-}"

case ",${BOT_DISABLED_HOOKS:-}," in
  *",${HOOK_NAME},"*) exit 0 ;;
esac
if [ -n "$HOOK_MODULE" ] && [ -n "${BOT_MODULES+x}" ]; then
  case ",${BOT_MODULES}," in
    *",${HOOK_MODULE},"*|*",*,"*) : ;;
    *) exit 0 ;;
  esac
fi

HARNESS="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd)}"
export HARNESS

if [ -z "${BOT_HOME:-}" ]; then
  if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then BOT_HOME="$CLAUDE_PROJECT_DIR"; else BOT_HOME="$PWD"; fi
fi
export BOT_HOME
cd "$BOT_HOME" 2>/dev/null || exit 0

if [ -n "${BOT_PYTHON:-}" ]; then
  PY="$BOT_PYTHON"
elif command -v python3 >/dev/null 2>&1 && python3 -c 'import sys' >/dev/null 2>&1; then
  PY="python3"
else
  PY="python"
fi
export PY
export PYTHONIOENCODING=utf-8
