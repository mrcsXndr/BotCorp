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
#
# The check lives in guard.mjs (v0.8.6: one node process for every guard;
# hooks.json runs `node guard.mjs post`). This wrapper runs the same code for
# the tests.

exec "${BOT_NODE:-node}" "$(dirname "$0")/guard.mjs" tools-nudge
