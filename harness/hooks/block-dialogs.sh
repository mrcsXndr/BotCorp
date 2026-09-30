#!/usr/bin/env bash
# PreToolUse guard — hard-block interactive TUI dialogs.
#
# This bot runs as a long-lived, Telegram-driven / headless agent. A blocking
# dialog (AskUserQuestion, ExitPlanMode) freezes the entire loop: the TUI waits
# for a keypress that never comes over Telegram, so inbound work stalls
# indefinitely. This is belt-and-suspenders behind the settings.json `deny`
# rule — exit 2 on a PreToolUse hook BLOCKS the tool call and feeds the
# message back to the model.
#
# Scoped by the hook matcher to AskUserQuestion|ExitPlanMode, so it only fires
# for those tools. FAIL-CLOSED by design: the whole point is to refuse.
#
# The decision lives in guard.mjs (v0.8.6: one node process for every guard;
# hooks.json runs `node guard.mjs pre`). This wrapper runs the same code for
# the tests; a node that cannot run still refuses.

"${BOT_NODE:-node}" "$(dirname "$0")/guard.mjs" block-dialogs
rc=$?
[ "$rc" = "0" ] && exit 0   # switched off in BOT_DISABLED_HOOKS
[ "$rc" = "2" ] || echo "BLOCKED: AskUserQuestion / ExitPlanMode are disabled in this bot. Do NOT retry: pick the sensible default and proceed." >&2
exit 2
