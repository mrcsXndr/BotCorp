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

set -uo pipefail
. "$(dirname "$0")/_guard.sh" block-dialogs

echo "BLOCKED: AskUserQuestion / ExitPlanMode are disabled in this bot — a blocking TUI dialog freezes the headless/Telegram-driven flow (no one can answer it over Telegram). Do NOT retry. Instead: pick the sensible default and proceed, stating the choice in your reply. If you genuinely need the operator's input, send a NON-blocking question via 'python \"$HARNESS/tools/tg/tg_send.py\" \"...\"' and continue with a reasonable default rather than waiting." >&2
exit 2
