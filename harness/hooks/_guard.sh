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
#      PY         the python interpreter (BOT_PYTHON > [Windows only] py launcher
#                 > python3 > python), pinned once here instead of in every hook,
#                 because the WindowsApps `python` alias has bitten a hook that
#                 resolved it ad hoc, and a bare `python`/`python3` can be absent
#                 entirely from a session-0 / Scheduled-Task PATH where the py
#                 launcher still is.
# 3. Exports PYTHONIOENCODING so Windows consoles never trip on UTF-8 output.
#
# STRICTLY FAIL-OPEN: nothing in here may fail the hook. No `set -e`.

HOOK_NAME="${1:-}"
HOOK_MODULE="${2:-}"

# Opt-in trace (BotCorp's Claude Code gate, check 3): one line per hook Claude
# Code ran, before any gate below can skip it.
if [ "${BOT_HOOK_TRACE:-}" = "1" ]; then
  _trace_dir="${BOT_HOME:-${CLAUDE_PROJECT_DIR:-$PWD}}/memory/metrics"
  { mkdir -p "$_trace_dir" && printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$HOOK_NAME" >> "$_trace_dir/hook-trace.log"; } 2>/dev/null
  unset _trace_dir
fi

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

PY=""
if [ -n "${BOT_PYTHON:-}" ]; then
  PY="$BOT_PYTHON"
fi

if [ -z "$PY" ]; then
  case "$(uname -s 2>/dev/null)" in
    MINGW*|MSYS*|CYGWIN*)
      # Bare `python`/`python3` can be entirely absent from a session-0 /
      # Scheduled-Task PATH; the py launcher is a stock Windows install and
      # survives there. Best-effort only — any failure here falls through.
      _to_unix_path() {
        if command -v cygpath >/dev/null 2>&1; then
          cygpath -u "$1" 2>/dev/null
        else
          printf '%s' "$1" | sed 's#\\#/#g' 2>/dev/null
        fi
      }
      for _py_launcher_win in "${SYSTEMROOT:-C:/Windows}/py.exe" "${LOCALAPPDATA:-}/Programs/Python/Launcher/py.exe"; do
        [ -n "$_py_launcher_win" ] || continue
        _py_launcher="$(_to_unix_path "$_py_launcher_win")"
        if [ -n "$_py_launcher" ] && [ -f "$_py_launcher" ]; then
          _py_resolved_win="$("$_py_launcher" -3 -c 'import sys; print(sys.executable)' 2>/dev/null)"
          if [ -n "$_py_resolved_win" ]; then
            _py_resolved="$(_to_unix_path "$_py_resolved_win")"
            if [ -n "$_py_resolved" ] && [ -f "$_py_resolved" ]; then
              PY="$_py_resolved"
              break
            fi
          fi
        fi
      done
      unset -f _to_unix_path 2>/dev/null
      unset _py_launcher_win _py_launcher _py_resolved_win _py_resolved
      ;;
  esac
fi

if [ -z "$PY" ]; then
  if command -v python3 >/dev/null 2>&1 && python3 -c 'import sys' >/dev/null 2>&1; then
    PY="python3"
  else
    PY="python"
  fi
fi
export PY
export PYTHONIOENCODING=utf-8
