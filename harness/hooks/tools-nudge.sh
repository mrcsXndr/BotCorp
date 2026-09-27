#!/usr/bin/env bash
# PostToolUse (Write|Edit): warn when the bot just wrote an executable under
# tools/ or scripts/ that no bot.yaml `tools:` entry covers.
#
# The capability registry only works if a new tool is registered in the turn
# it was written; this is the write-time reminder, with the register command
# filled in. Warn-only, never blocks: stdout from a PostToolUse hook is fed
# back to the model as feedback. Silent when `tools:` is absent (the registry
# is off for that bot). Coverage is decided by cli/tools.mjs, the same code
# `botcorp tools scan` uses. STRICTLY FAIL-OPEN.

set -uo pipefail
. "$(dirname "$0")/_guard.sh" tools-nudge

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
    print(ti.get('file_path') or '')
except Exception:
    pass
" <<<"$PAYLOAD" 2>/dev/null) || exit 0
[ -n "$FILE" ] || exit 0
[ -f "$BOT_HOME/bot.yaml" ] || exit 0

# _guard.sh cd'd into BOT_HOME; `pwd -W` gives the C:/... form on Windows.
HOME_N=$(pwd -W 2>/dev/null || pwd)
FILE_N=$(printf '%s' "$FILE" | tr '\\' '/')
shopt -s nocasematch
case "$FILE_N" in
  "$HOME_N"/tools/*|"$HOME_N"/scripts/*) : ;;
  *) exit 0 ;;
esac
REL="${FILE_N:${#HOME_N}+1}"
case "$REL" in
  *.py|*.mjs|*.js|*.cjs|*.sh|*.ps1) : ;;
  *) exit 0 ;;
esac
case "${REL##*/}" in
  _*|test_*) exit 0 ;;   # private modules and tests are not tools
esac
shopt -u nocasematch

BOTCORP=$(cd "$HARNESS/.." 2>/dev/null && { pwd -W 2>/dev/null || pwd; }) || exit 0
NODE="${BOT_NODE:-node}"
"$NODE" --input-type=module -e '
import path from "node:path";
import { pathToFileURL } from "node:url";
const [root, home, rel] = process.argv.slice(1);
const load = (p) => import(pathToFileURL(path.join(root, p)).href);
const { loadBotYaml } = await load("daemon/botyaml.mjs");
const { covers } = await load("cli/tools.mjs");
const { isShim } = await load("daemon/sync.mjs");
const cfg = loadBotYaml(path.join(home, "bot.yaml"));
if (!Array.isArray(cfg.tools) || cfg.tools.some((t) => covers(t, rel)) || isShim(path.join(home, rel))) process.exit(0);
const name = path.posix.basename(rel).replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "tool";
console.log("unregistered tool " + rel + ": register it this turn with botcorp tools " + cfg.name + " register --name " + name + " --path " + rel + " --kind cli --purpose \"<what it does>\" (kind integration if it uses a secret or writes outside the box)");
' "$BOTCORP" "$HOME_N" "$REL" 2>/dev/null || true
exit 0
