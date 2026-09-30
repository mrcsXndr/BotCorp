#!/usr/bin/env bash
# PostToolUse (Edit|Write|MultiEdit|NotebookEdit): warn when the bot just
# modified a TRACKED harness file outside a suggest/* branch.
#
# The harness (<BotCorp>/harness) is shared by every bot on the machine, and
# daemon/update.ps1 refuses a dirty tree — this is the write-time tripwire for
# a bot editing engine code in place, which would silently block every future
# update until the edit is reverted. Warn-only, never
# blocks: stdout from a PostToolUse hook is fed back to the model as
# feedback. The `bots/` subtree is excluded — that's per-bot instance state,
# not shared harness code. STRICTLY FAIL-OPEN.
#
# The check lives in guard.mjs (v0.8.6: one node process for every guard;
# hooks.json runs `node guard.mjs post`). This wrapper runs the same code for
# the tests.

exec "${BOT_NODE:-node}" "$(dirname "$0")/guard.mjs" core-guard
