#!/usr/bin/env bash
# PreToolUse guard (Read|Glob|Grep|Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit) —
# block any tool call that touches a bot vault (any bot's, this bot's own
# included — a bot never has a reason to reach into vault files) or the
# secrets CLI's mutating verbs.
#
# FAIL-CLOSED for the things it names and for a payload it cannot parse (exit
# 2 blocks the tool call and feeds the message back to the model); everything
# else is a silent exit 0.
#
# The decision lives in guard.mjs (v0.8.6: one node process for every guard;
# hooks.json runs `node guard.mjs pre`). This wrapper runs the same code for
# the tests and `botcorp doctor`; a node that cannot run fails closed here too.

"${BOT_NODE:-node}" "$(dirname "$0")/guard.mjs" vault-guard
rc=$?
case "$rc" in 0|2) exit "$rc" ;; esac
echo "BLOCKED: vault-guard could not parse this tool call (its node guard exited $rc), so it cannot rule out a vault access; it fails closed. If node is missing, point BOT_NODE at a real node.exe." >&2
exit 2
