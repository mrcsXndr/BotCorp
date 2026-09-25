#!/usr/bin/env bash
# SessionStart hook: records which OAuth / Telegram token (last 4 only) and
# which launcher's env THIS session actually got, in
# <CLAUDE_CONFIG_DIR>/botcorp/session-env.json (tools/v2/session_env.py). A
# `claude --bg` session inherits the config home's daemon env, not the launch's;
# this is the measurement launch.ps1, `botcorp status` and `doctor` read.
#
# STRICTLY FAIL-OPEN.

set -uo pipefail
. "$(dirname "$0")/_guard.sh" session-env

"$PY" "$HARNESS/tools/v2/session_env.py" >/dev/null 2>&1 || true
exit 0
