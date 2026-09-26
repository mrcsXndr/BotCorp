#!/usr/bin/env bash
# UserPromptSubmit hook
#
# What this hook does:
#   1. Parse the Claude Code UserPromptSubmit JSON payload from stdin.
#   2. TG SLASH-COMMAND INTERCEPT — a local "/cmd" prompt, or a Telegram
#      message whose body is a read-only command (/status /journal /timeline
#      /board /costs /help), is handled by tools/v2/tg_commands.py and blocked
#      from the main thread (exit 2). The reply goes straight back to Telegram.
#   3. INBOUND SIZE GUARD — stash huge pastes and redirect the bot's attention
#      instead of polluting context inline.
#
# Defensive: ANY error -> exit 0 (fail open — never silently drop a message).

set -uo pipefail
. "$(dirname "$0")/_guard.sh" user-prompt-submit

PAYLOAD=""
if ! [ -t 0 ]; then
  PAYLOAD=$(cat || true)
fi

# Extract prompt + session id (+ inbound reply-to message id) from the payload.
PROMPT=""
SESSION_ID=""
REPLY_TO=""
if [ -n "$PAYLOAD" ]; then
  # ONE python call, reading the payload from STDIN — NEVER as an argv arg. A
  # prompt >~32K chars passed as argv hits "Argument list too long" on Windows;
  # the parse then silently fails and PROMPT="" so the inbound size guard could
  # never fire (it fires at 50K > the argv limit). Reading stdin removes the cap.
  # The prompt is kept RAW here — no %b re-escaping, so Windows-path backslashes
  # and other literals survive intact. Output shape:
  #   line1 = session_id, line2 = reply_to msg id, line3+ = raw prompt.
  PARSED=$(printf '%s' "$PAYLOAD" | "$PY" -c '
import json, re, sys
try:
    d = json.loads(sys.stdin.read() or "{}")
except Exception:
    d = {}
p = d.get("prompt") or ""
s = d.get("session_id") or ""
m = re.search(r"message_id=\"(\d+)\"", p)
sys.stdout.write((s or "") + "\n")
sys.stdout.write((m.group(1) if m else "") + "\n")
sys.stdout.write(p)
' 2>/dev/null || true)
  SESSION_ID=$(printf '%s' "$PARSED" | sed -n '1p')
  REPLY_TO=$(printf '%s' "$PARSED" | sed -n '2p')
  PROMPT=$(printf '%s' "$PARSED" | sed -n '3,$p')
fi

if [ -z "$PROMPT" ]; then
  exit 0
fi

if [ -z "$SESSION_ID" ] && [ -f "$BOT_HOME/.claude/.current_session_id" ]; then
  SESSION_ID=$(cat "$BOT_HOME/.claude/.current_session_id" 2>/dev/null || true)
fi
if [ -z "$SESSION_ID" ]; then
  SESSION_ID=$(date -u +%Y%m%d-%H%M%S)
fi

PROMPT_REAL="$PROMPT"

# --- TG INBOUND LOG + REPLY-PATH NUDGE ---
# Telegram's Bot API keeps no history, so every inbound <channel> message is
# appended to memory/tg/<chat_id>.jsonl (idempotent on chat+message id) BEFORE
# any intercept, so slash commands are logged too. Fail-open: tg_log.py exits 0
# on its own errors and this line never gates the prompt.
#
# The nudge (injected as additional context at the end) states the working
# tg_send.py reply command per inbound message: once a reply path broke, the
# bot fell back to the plugin `reply` tool and kept using it after the fix
# (footer-less replies that outlived the bug). In-session learning has to be
# countered on every prompt, so the hook states the working path each time.
# Matches both channel-tag spellings the plugin has shipped.
REPLY_NUDGE=""
TG_BODY=""
case "$PROMPT_REAL" in
  *'<channel source="telegram"'*|*'<channel source="plugin:telegram:telegram"'*)
    printf '%s' "$PROMPT_REAL" | "$PY" "$HARNESS/tools/tg/tg_log.py" ingest >/dev/null 2>&1 || true
    # Body of the Telegram <channel> element, for the slash intercept below. Only
    # when the prompt carries exactly one: the intercept blocks the whole prompt,
    # which would drop every other message batched into it.
    TG_BODY=$(printf '%s' "$PROMPT_REAL" | "$PY" -c '
import re, sys
m = re.findall(r"<channel\s+source=\"(?:plugin:telegram:)?telegram\"[^>]*>(.*?)</channel>", sys.stdin.read(), re.DOTALL)
sys.stdout.write(m[0].strip() if len(m) == 1 else "")
' 2>/dev/null || true)
    # Last tag in the prompt = the message being answered (a batched prompt
    # can carry several).
    TG_CHAT_ID=$(printf '%s' "$PROMPT_REAL" | grep -o 'chat_id="[^"]*"' | tail -1 | sed 's/chat_id="\(.*\)"/\1/')
    TG_MSG_ID=$(printf '%s' "$PROMPT_REAL" | grep -o 'message_id="[0-9]*"' | tail -1 | sed 's/message_id="\(.*\)"/\1/')
    TG_DEFAULT_CHAT="${TELEGRAM_CHAT_ID:-}"
    if [ -z "$TG_DEFAULT_CHAT" ] && [ -f "$BOT_HOME/.env" ]; then
      TG_DEFAULT_CHAT=$(sed -n 's/^TELEGRAM_CHAT_ID=//p' "$BOT_HOME/.env" 2>/dev/null | head -1 | tr -d '\r ')
    fi
    if [ -n "$TG_CHAT_ID" ]; then
      CHAT_FLAG=""
      if [ "$TG_CHAT_ID" != "$TG_DEFAULT_CHAT" ]; then
        CHAT_FLAG="--chat-id $TG_CHAT_ID "
      fi
      REPLY_NUDGE="Reply path: python tools/tg/tg_send.py ${CHAT_FLAG}--reply-to ${TG_MSG_ID:-<message_id>} \"<CommonMark text>\" (formatted + status footer; it is working). Use the plugin reply tool only for file attachments. Run python tools/tg/tg_send.py --answered first if this is a reply from the operator."
    fi
    ;;
esac

# --- TG SLASH-COMMAND INTERCEPT ---
# If the prompt is a TG-style slash command, handle it directly and block the
# main thread. tg_commands.py exit codes: 0=handled, 1=not-a-cmd,
# 2=handled-with-error. REPLY_TO (inbound TG message_id for threading) was
# extracted in the parse above.
#
# From Telegram only an explicit read-only allowlist is intercepted: a command
# that mutates or restarts (/compact, /update, /board move|set|sync|poll, a
# bot-local command) passes through to the model, so a Telegram message can
# never restart the bot through this hook.
CMD_TEXT=""
if [ "${PROMPT_REAL:0:1}" = "/" ]; then
  CMD_TEXT="$PROMPT_REAL"
elif [ "${TG_BODY:0:1}" = "/" ]; then
  read -r TG_CMD TG_ARG1 _ <<< "$TG_BODY"
  case "${TG_CMD,,}" in
    /status|/journal|/timeline|/costs|/help) CMD_TEXT="$TG_BODY" ;;
    /board) case "${TG_ARG1,,}" in ""|show|render|list|help) CMD_TEXT="$TG_BODY" ;; esac ;;
  esac
fi
if [ -n "$CMD_TEXT" ]; then
  # Prompt goes via STDIN ('-'): on Windows/Git Bash, MSYS converts a
  # leading-slash argv ("/help") into a Windows path, which would break the
  # intercept. stdin is never path-converted.
  CMD_RC=$(printf '%s' "$CMD_TEXT" | "$PY" "$HARNESS/tools/v2/tg_commands.py" - "$REPLY_TO" >/dev/null 2>&1; echo $?)
  if [ "$CMD_RC" = "0" ] || [ "$CMD_RC" = "2" ]; then
    "$PY" "$HARNESS/tools/v2/journal.py" append "$SESSION_ID" action "tg-command handled: ${CMD_TEXT:0:80}" >/dev/null 2>&1 || true
    echo "[tg_commands] handled $CMD_TEXT — reply sent to TG, blocking main thread" >&2
    exit 2
  fi
fi

# --- INBOUND SIZE GUARD ---
# If a single prompt is huge (paste / log dump / convo export), don't let it
# silently pollute context. Stash the raw blob and inject a strong directive
# telling the bot to Read or dispatch instead of reasoning over the whole
# thing inline. Threshold: 50K chars (~12K tokens).
PROMPT_SIZE=${#PROMPT_REAL}
SIZE_THRESHOLD=${BOT_SIZE_THRESHOLD:-50000}
if [ "$PROMPT_SIZE" -gt "$SIZE_THRESHOLD" ]; then
  STASH_DIR="$BOT_HOME/.claude/stash"
  mkdir -p "$STASH_DIR" 2>/dev/null || true
  TS_NOW=$(date -u +%Y%m%dT%H%M%SZ)
  STASH_FILE="$STASH_DIR/paste_${SESSION_ID}_${TS_NOW}.txt"
  printf '%s' "$PROMPT_REAL" > "$STASH_FILE" 2>/dev/null || true
  EST_TOKENS=$((PROMPT_SIZE / 4))
  HEAD=$(printf '%s' "$PROMPT_REAL" | head -c 1500)
  GUARD_MSG=$(cat <<EOF
[INBOUND-SIZE-GUARD] Prompt is $PROMPT_SIZE chars (~$EST_TOKENS tokens). Full payload stashed at: $STASH_FILE

Do NOT ingest the entire blob into reasoning context. Choose one:
  1. Read the file with offset/limit for the relevant slice only
  2. Dispatch a one-shot subagent (fresh ctx) to summarise/extract
  3. If the actual ask is clear from the head, answer that and ignore the dump

Prompt head (first 1500 chars):
$HEAD
EOF
)
  "$PY" "$HARNESS/tools/v2/journal.py" append "$SESSION_ID" observation "large-paste guarded: ~$EST_TOKENS tokens stashed to .claude/stash/$(basename "$STASH_FILE")" >/dev/null 2>&1 || true
  # One JSON blob per hook run: the reply-path nudge rides inside this one.
  if [ -n "$REPLY_NUDGE" ]; then
    GUARD_MSG="$GUARD_MSG

$REPLY_NUDGE"
    REPLY_NUDGE=""
  fi
  ESCAPED=$(printf '%s' "$GUARD_MSG" | "$PY" -c "import sys,json; print(json.dumps(sys.stdin.read()))" 2>/dev/null || echo '""')
  printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":%s}}\n' "$ESCAPED"
fi

# --- TG REPLY-PATH NUDGE (see the inbound-log block) ---
if [ -n "$REPLY_NUDGE" ]; then
  ESCAPED=$(printf '%s' "$REPLY_NUDGE" | "$PY" -c "import sys,json; print(json.dumps(sys.stdin.read()))" 2>/dev/null || echo '""')
  printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":%s}}\n' "$ESCAPED"
fi

# Default: pass through to main thread (exit 0).
exit 0
