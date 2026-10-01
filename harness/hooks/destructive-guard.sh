#!/usr/bin/env bash
# PreToolUse guard (Bash|PowerShell|Monitor|mcp__*) — a bot never runs a
# command that wipes what it cannot get back: a recursive delete of the
# filesystem root, a drive root, the home folder, the BotCorp root, a bot
# folder or a .git directory (or a folder holding one); a force push to
# main/master; `git reset --hard` together with `git clean -fdx`; format
# <drive>:, Format-Volume, diskpart, mkfs. The operator runs those from their
# own terminal.
#
# Narrow on purpose: rm -rf node_modules, a delete under a job dir, deleting a
# file and a push without force all pass. FAIL-CLOSED on a payload it cannot
# parse (exit 2 blocks the tool call and feeds the message back to the model).
#
# The decision lives in guard.mjs (one node process for every guard; hooks.json
# runs `node guard.mjs pre`). This wrapper runs the same code for the tests.

exec "${BOT_NODE:-node}" "$(dirname "$0")/guard.mjs" destructive-guard
