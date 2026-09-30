#!/usr/bin/env bash
# PreToolUse guard (Bash|PowerShell) — a bot never runs the operator-only
# verbs: `botcorp approve|reject` (its own queued widening change), `accounts
# add|remove|seed|use|backups`, `secrets set|delete`, `pair <id>`, `update
# --apply|--skip|--rollback|--cancel`, start/stop/restart of another bot,
# `cockpit expose|unexpose|pair|unpair`.
# `accounts rename`, `accounts seed --link`.
# An admin bot (bot.yaml role: admin, its launch id matching; `botcorp
# whoami`) may run all of them but the last three. The CLI refuses them too
# (BOT_NAME / CLAUDECODE in the env, exit 3); this is the second layer.
#
# Matches the COMMAND field only, never file paths or Grep patterns, so a
# search for the word "approve" is never blocked.
#
# FAIL-CLOSED for the verbs it names (exit 2 blocks the tool call and feeds
# the message back to the model); everything else is a silent exit 0.
#
# The decision lives in guard.mjs (v0.8.6: one node process for every guard;
# hooks.json runs `node guard.mjs pre`). This wrapper runs the same code for
# the tests.

exec "${BOT_NODE:-node}" "$(dirname "$0")/guard.mjs" operator-guard
