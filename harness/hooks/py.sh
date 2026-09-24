#!/usr/bin/env bash
# py.sh — run one harness python tool as a hook:  bash py.sh <hook-name> <module|-> <tools-relative-path> [args...]
#
# One place that pins the interpreter, applies the BOT_DISABLED_HOOKS /
# BOT_MODULES gates and resolves BOT_HOME (all via _guard.sh), so hooks.json
# never hardcodes a python path (the settings.json this replaced had six copies of one).
# stdin (the hook payload) is passed straight through. STRICTLY FAIL-OPEN:
# the tool's exit code is swallowed — a broken metric writer must never fail
# a Stop hook.
. "$(dirname "$0")/_guard.sh" "$1" "$( [ "$2" = "-" ] && echo "" || echo "$2" )" || exit 0
shift 2
TOOL="$1"; shift
"$PY" "$HARNESS/tools/$TOOL" "$@" || true
exit 0
