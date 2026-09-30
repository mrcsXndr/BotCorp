#!/usr/bin/env bash
# UserPromptSubmit hook
#
# What this hook does:
#   1. Parse the Claude Code UserPromptSubmit JSON payload from stdin.
#   2. TG SLASH-COMMAND INTERCEPT — a local "/cmd" prompt, or a Telegram
#      message whose body is a read-only command (/status /journal /timeline
#      /board /costs /usage /help), is handled by tools/v2/tg_commands.py and blocked
#      from the main thread (exit 2). The reply goes straight back to Telegram.
#   3. INBOUND SIZE GUARD — stash huge pastes and redirect the bot's attention
#      instead of polluting context inline.
#
# Defensive: ANY error -> exit 0 (fail open — never silently drop a message).

set -uo pipefail
case "$0" in */*|*\\*) _hooks="${0%[/\\]*}" ;; *) _hooks=. ;; esac  # dirname without a fork
. "$_hooks/_guard.sh" user-prompt-submit

# ONE python call reads the payload from STDIN (NEVER as an argv arg: a prompt
# over ~32K chars hits "Argument list too long" on Windows, and the size guard
# fires at 50K) and hands back every field this hook needs, NUL-separated, so
# no further fork is spent picking it apart (each costs 200 ms or more under
# Git Bash). The prompt is kept RAW: no %b re-escaping, so Windows-path
# backslashes and other literals survive intact. For a Telegram prompt it
# also appends the message to the bot's own chat log and builds the reply-path
# nudge (see the TG block below). Fields: session_id, reply_to msg id, the one
# <channel> body, the nudge, the nudge as a JSON string, the prompt.
PROMPT=""
SESSION_ID=""
REPLY_TO=""
TG_BODY=""
REPLY_NUDGE=""
NUDGE_JSON=""
if ! [ -t 0 ]; then
  { IFS= read -r -d '' SESSION_ID; IFS= read -r -d '' REPLY_TO; IFS= read -r -d '' TG_BODY
    IFS= read -r -d '' REPLY_NUDGE; IFS= read -r -d '' NUDGE_JSON; IFS= read -r -d '' PROMPT; } < <("$PY" -c '
import json, os, re, subprocess, sys
try:
    d = json.loads(sys.stdin.buffer.read().decode("utf-8", "replace") or "{}")
except Exception:
    d = {}
d = d if isinstance(d, dict) else {}
raw = str(d.get("prompt") or "")
p = raw.rstrip("\n")
m = re.search(r"message_id=\"(\d+)\"", raw)
tg = "<channel source=\"telegram\"" in p or "<channel source=\"plugin:telegram:telegram\"" in p
body = nudge = nudge_json = ""
if tg:
    try:
        subprocess.run([sys.executable, os.path.join(sys.argv[1], "tools", "tg", "tg_log.py"), "ingest"], input=p.encode("utf-8"),
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        pass
    bodies = re.findall(r"<channel\s+source=\"(?:plugin:telegram:)?telegram\"[^>]*>(.*?)</channel>", p, re.DOTALL)
    body = bodies[0].strip() if len(bodies) == 1 else ""
    chats = re.findall(r"chat_id=\"([^\"\n]*)\"", p)
    msgs = re.findall(r"message_id=\"([0-9]*)\"", p)
    if chats and chats[-1]:
        default = os.environ.get("TELEGRAM_CHAT_ID", "")
        if not default:
            try:
                for ln in open(".env", encoding="utf-8", errors="replace"):
                    if ln.startswith("TELEGRAM_CHAT_ID="):
                        default = ln[len("TELEGRAM_CHAT_ID="):].replace("\r", "").replace(" ", "").rstrip("\n")
                        break
            except OSError:
                pass
        flag = "" if chats[-1] == default else "--chat-id " + chats[-1] + " "
        msg = msgs[-1] if msgs and msgs[-1] else "<message_id>"
        nudge = ("Reply path: python tools/tg/tg_send.py " + flag + "--reply-to " + msg + " \"<CommonMark text>\" (formatted + status "
                 "footer; it is working). Use the plugin reply tool only for file attachments. Run python tools/tg/tg_send.py "
                 "--answered first if this is a reply from the operator.")
        nudge_json = json.dumps(nudge)
out = [str(d.get("session_id") or ""), m.group(1) if m else "", body, nudge, nudge_json, p]
sys.stdout.buffer.write("".join(x.replace("\0", "") + "\0" for x in out).encode("utf-8"))
' "$HARNESS" 2>/dev/null)
fi

if [ -z "$PROMPT" ]; then
  exit 0
fi

# A new prompt ends a declared breakpoint (D7): the daemon reads a fresh
# .botcorp_breakpoint as IDLE for 30 min, and this turn is live work. (The
# test is a builtin: no rm fork on the usual prompt, which has no marker.)
[ -e "$BOT_HOME/.claude/.botcorp_breakpoint" ] && { rm -f "$BOT_HOME/.claude/.botcorp_breakpoint" 2>/dev/null || true; }

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
#
# Both happen in the parse call at the top, for a Telegram prompt: tg_log.py ingest, then
# TG_BODY = the body of the Telegram <channel> element for the slash intercept
# below, only when the prompt carries exactly one (the intercept blocks the
# whole prompt, which would drop every other message batched into it), and
# REPLY_NUDGE naming the LAST tag's chat and message id (the message being
# answered; a batched prompt can carry several), with --chat-id only when that
# chat is not the default (TELEGRAM_CHAT_ID, else the bot's .env).

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
elif [ "${TG_BODY:0:1}" = "/" ] && [[ "${TG_BODY//$'\r'/}" != *$'\n'* ]]; then
  # one line only: `read` sees line 1, but tg_commands.py parses the whole body,
  # so "/board" + newline + "move x Done" would pass as a read-only /board
  read -r TG_CMD TG_ARG1 _ <<< "$TG_BODY"
  case "${TG_CMD,,}" in
    /status|/journal|/timeline|/costs|/usage|/help) CMD_TEXT="$TG_BODY" ;;
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
  printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":%s}}\n' "${NUDGE_JSON:-\"\"}"
fi

# Default: pass through to main thread (exit 0).
exit 0
