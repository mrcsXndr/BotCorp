#!/usr/bin/env bash
# PreToolUse guard (Edit|Write|MultiEdit|NotebookEdit) — block direct writes to
# harness-managed config the bot must not self-modify: bot.yaml, generated
# settings.json, the secrets vault, and the Telegram access allowlist.
#
# FAIL-CLOSED for the files it names (exit 2 blocks the tool call and feeds
# the message back to the model); everything else is a silent exit 0.
#
# The decision lives in guard.mjs (v0.8.6: one node process for every guard;
# hooks.json runs `node guard.mjs pre`). This wrapper runs the same code for
# the tests.

exec "${BOT_NODE:-node}" "$(dirname "$0")/guard.mjs" config-guard
