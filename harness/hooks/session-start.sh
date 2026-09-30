#!/usr/bin/env bash
# SessionStart hook
# - Injects last-session context + git log
# - Ensures memory/sessions/<session_id>/journal.md exists and loads
#   journal + timeline into the system prompt (NOT chat history) via
#   additionalContext.
# - Refreshes the cross-session recall index, emits a memory-budget header,
#   surfaces due commitments, and injects the condensed persistent TDL.
# - Records this bot's harness version/session into the runtime state file.
# - Injects the harness lessons index when the `lessons` module is enabled.
#
# STRICTLY FAIL-OPEN: every step swallows its own errors; this hook must
# never break session start.

set -uo pipefail
. "$(dirname "$0")/_guard.sh" session-start

# --- Cross-session recall index -------------------------------------------
# Refresh the FTS5 recall index so the Director can do zero-LLM cross-session
# recall this session. Incremental + mtime-gated (~ms).
( "$PY" "$HARNESS/tools/v2/recall.py" index >/dev/null 2>&1 ) || true

# Read session id from Claude Code stdin payload (JSON: {"session_id":"..."})
PAYLOAD=""
if ! [ -t 0 ]; then
  PAYLOAD=$(cat || true)
fi
SESSION_ID=""
if [ -n "$PAYLOAD" ]; then
  SESSION_ID=$("$PY" -c "import json,sys; d=json.loads(sys.stdin.read() or '{}'); print(d.get('session_id') or '')" <<<"$PAYLOAD" 2>/dev/null || true)
fi
if [ -z "$SESSION_ID" ]; then
  SESSION_ID=$(date -u +%Y%m%d-%H%M%S)
fi

# Create journal (idempotent)
"$PY" "$HARNESS/tools/v2/journal.py" new "$SESSION_ID" >/dev/null 2>&1 || true

JOURNAL_PATH="$BOT_HOME/memory/sessions/$SESSION_ID/journal.md"
TIMELINE_PATH="$BOT_HOME/memory/sessions/$SESSION_ID/timeline.md"

# --- Last-session context ----------------------------------------------------
# Prefer the most recent non-stub timeline.md (distilled narrative), else the
# tail of the most recent journal.md that has real entries, else omit.
LAST_SESSION=$("$PY" - "$BOT_HOME" "$SESSION_ID" <<'PYEOF' 2>/dev/null || true
import os, sys
from pathlib import Path

bot_home = Path(sys.argv[1])
current = sys.argv[2]
sessions = bot_home / "memory" / "sessions"
PLACEHOLDERS = ("_(none yet)_", "_(none recorded)_")

def timeline_payload(p):
    """Return distilled timeline text if it has a real body (skip stubs)."""
    try:
        txt = p.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    body = txt
    if body.startswith("---"):
        end = body.find("\n---", 3)
        if end != -1:
            body = body[end + 4:]
    has_content = any(
        ln.strip() and ln.strip() not in PLACEHOLDERS and not ln.lstrip().startswith("#")
        and not ln.strip().startswith(">")
        for ln in body.splitlines()
    )
    if not has_content:
        return None
    return body.strip()  # session_context.py keeps the newest decisions that fit

def journal_payload(p):
    """Tail of a journal that has real `- [HH:MM:SS] ...` entries."""
    try:
        lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return None
    import re
    entry = re.compile(r"^- \[\d{2}:\d{2}:\d{2}\] (.+)$")
    bullets = [ln for ln in lines if entry.match(ln.strip()) and entry.match(ln.strip()).group(1).strip() not in PLACEHOLDERS]
    if not bullets:
        return None
    tail = bullets[-15:]
    return "\n".join(tail)[:4000]

# SESSION-RECENCY-FIRST: rank SESSIONS by recency (max mtime of their
# journal/timeline), then for the newest session prefer its timeline, else
# its journal — a session that ended without a timeline but with a rich
# journal must not lose to an older session that has one.
def session_dirs_newest_first():
    try:
        dirs = [d for d in sessions.iterdir() if d.is_dir()]
    except OSError:
        return []
    def recency(d):
        m = 0.0
        for name in ("timeline.md", "journal.md"):
            f = d / name
            try:
                if f.is_file():
                    m = max(m, f.stat().st_mtime)
            except OSError:
                pass
        return m
    return sorted(dirs, key=recency, reverse=True)

# The newest session with content being THIS one (a resume or a compaction)
# means its own journal and timeline blocks already carry it: print nothing
# rather than inject the same timeline twice.
for d in session_dirs_newest_first():
    tl = d / "timeline.md"
    if tl.is_file():
        pl = timeline_payload(tl)
        if pl:
            if d.name != current:
                print(f"(from {d.name}/timeline.md)\n{pl}")
            sys.exit(0)
    jr = d / "journal.md"
    if jr.is_file():
        pl = journal_payload(jr)
        if pl:
            if d.name != current:
                print(f"(recent journal entries — {d.name})\n{pl}")
            sys.exit(0)

# nothing usable -> empty (block omitted by the hook)
PYEOF
)
GIT_LOG=$(git log --oneline -5 2>/dev/null || echo "")

JOURNAL_BODY=""
if [ -f "$JOURNAL_PATH" ]; then
  # Read at most the last ~20K chars; session_context.py cuts it further to
  # fit the injection budget. Full journal is always on disk to Read.
  JOURNAL_BODY=$(tail -c "${BOT_JOURNAL_HEAD_BYTES:-20000}" "$JOURNAL_PATH" 2>/dev/null || true)
fi
TIMELINE_BODY=""
if [ -f "$TIMELINE_PATH" ]; then
  TIMELINE_BODY=$(cat "$TIMELINE_PATH")
fi

# --- Sanitize external-derived memory before injection -----------------------
# journal / timeline / last-session / lessons can carry pasted TG/web content
# = a prompt-injection persistence vector. Pass each chunk through
# tools/v2/sanitize_chunk.py (gate over tools/infra/sanitize.py):
# HIGH/CRITICAL risk -> replaced with a [BLOCKED ...] marker; otherwise the
# cleaned chunk is injected instead of the raw text. FAIL-OPEN: prints the raw
# chunk if sanitize can't run, so this can never break session start.
sanitize_chunk() {
  # $1 = source label. Reads chunk on stdin, prints cleaned/blocked on stdout.
  "$PY" "$HARNESS/tools/v2/sanitize_chunk.py" "$1" 2>/dev/null || cat
}
if [ -n "$LAST_SESSION" ]; then
  LAST_SESSION=$(printf '%s' "$LAST_SESSION" | sanitize_chunk "last-session" || printf '%s' "$LAST_SESSION")
fi
if [ -n "$JOURNAL_BODY" ]; then
  JOURNAL_BODY=$(printf '%s' "$JOURNAL_BODY" | sanitize_chunk "$JOURNAL_PATH" || printf '%s' "$JOURNAL_BODY")
fi
if [ -n "$TIMELINE_BODY" ]; then
  TIMELINE_BODY=$(printf '%s' "$TIMELINE_BODY" | sanitize_chunk "$TIMELINE_PATH" || printf '%s' "$TIMELINE_BODY")
fi

# --- Memory budget header ----------------------------------------------------
# Frozen-snapshot usage header so the Director SEES how full the durable
# index (memory/MEMORY.md) and this session's journal are, and self-
# consolidates before they bloat. Budgets are chars.
MEMORY_FILE="$BOT_HOME/memory/MEMORY.md"
MEMORY_BUDGET=20000
JOURNAL_BUDGET="${BOT_JOURNAL_HEAD_BYTES:-20000}"
BUDGET_HEADER=$("$PY" - "$MEMORY_FILE" "$MEMORY_BUDGET" "$JOURNAL_PATH" "$JOURNAL_BUDGET" <<'PYEOF' 2>/dev/null || true
import os, sys
def line(label, path, budget):
    try:
        n = os.path.getsize(path)
    except OSError:
        return None
    pct = round(100 * n / budget) if budget else 0
    flag = " OVER-BUDGET — consolidate" if n > budget else ""
    return f"[{label}: {pct}% — {n:,}/{budget:,} chars{flag}]"
out = []
for label, path, budget in (
    ("memory", sys.argv[1], int(sys.argv[2])),
    ("journal", sys.argv[3], int(sys.argv[4])),
):
    l = line(label, path, budget)
    if l:
        out.append(l)
print("\n".join(out))
PYEOF
)

# --- Due commitments -----------------------------------------------------
# Surface OPEN, due/overdue follow-ups from the session-independent store so
# they resurface automatically instead of waiting on the operator to re-ask.
# `surface` prints nothing (exit 0) when there's nothing due.
COMMITMENTS=$("$PY" "$HARNESS/tools/v2/commitments.py" surface 2>/dev/null || true)

# --- Persistent TDL (single always-in-memory backlog) --------------------
# memory/TDL.md is the durable, HAND-MAINTAINED "what's unfinished" doc so
# nothing lives in session context alone. The bot edits it directly
# (Write/Edit) with rich per-item detail; this hook only READS it. CONDENSED:
# the verbatim `## Open` injection can bloat past tens of thousands of chars
# per session start, so inject only each item's `###` header plus its latest
# status/next-step line (last line carrying an uppercase status marker, else
# the first body line). Full detail stays on disk — the session Reads
# memory/TDL.md before working an item. STRICTLY FAIL-OPEN: missing/malformed
# file or empty extraction -> empty block, hook still exits 0.
TDL_OPEN=$("$PY" - "$BOT_HOME/memory/TDL.md" <<'PYEOF' 2>/dev/null || true
import re, sys
try:
    text = open(sys.argv[1], encoding="utf-8", errors="replace").read()
except OSError:
    sys.exit(0)
m = re.search(r"(?ms)^## Open[ \t]*$(.*?)(?=^## |\Z)", text)
if not m:
    sys.exit(0)
# Case-sensitive on purpose: TDL status notes are UPPERCASE ("NOW IDLE ON:",
# "PARKED:"), prose "next"/"blocked" are lowercase and must not match.
MARKER = re.compile(r"\b(NOW IDLE ON|NEXT STEP|NEXT:|PARKED|AWAITING|BLOCKED|WAITING ON|STATUS)\b")
blocks = []  # [header line, [body lines]]
for ln in m.group(1).splitlines():
    if ln.startswith("### "):
        blocks.append([ln.rstrip(), []])
    elif blocks:
        blocks[-1][1].append(ln)
if not blocks:
    # A TDL written as top-level bullets ("- **title** ..." with indented
    # detail under each) has no ### items: each column-0 bullet is an item,
    # rendered as a ### header (its bold title, at most 72 chars, so ~40 items
    # fit the TDL budget) and the rest of the bullet line as its first note.
    # A bullet marked [DONE], [DONE <date>], [resolved], [superseded ...] or
    # [ANSWERED] is finished and left out ([DONE-ish] and the like stay).
    for ln in m.group(1).splitlines():
        if ln.startswith("- "):
            item = ln[2:].strip()
            bold = re.match(r"\*\*(.+?)\*\*\s*(.*)", item)
            title, rest = (bold.group(1), bold.group(2)) if bold else (item, "")
            done = re.match(r"\[(DONE[\] ,]|resolved\]|RESOLVED\]|superseded|ANSWERED\])", title)
            title = title if len(title) <= 72 else title[:71].rstrip() + "…"
            blocks.append([None if done else "### " + title, [rest] if rest else []])
        elif blocks:
            blocks[-1][1].append(ln)
    blocks = [b for b in blocks if b[0]]
if not blocks:
    sys.exit(0)
out = [f"(condensed: {len(blocks)} items — header + latest status line each; "
       f"full detail per item lives in memory/TDL.md, Read it before working an item)"]
for header, body in blocks:
    status = ""
    first = ""
    for ln in body:
        s = ln.strip()
        if not s:
            continue
        if not first:
            first = s
        if MARKER.search(s):
            status = s  # last marker line wins — the most recent status note
    out.append(header)
    pick = status or first
    if pick:
        out.append("  - " + pick[:300])
print("\n".join(out))
PYEOF
)

# Account for the TDL injection in the budget header so its size stays
# visible and an over-budget Open section nags for consolidation too.
TDL_INJECT_BUDGET="${BOT_TDL_INJECT_BUDGET:-8000}"
case "$TDL_INJECT_BUDGET" in ''|*[!0-9]*|0) TDL_INJECT_BUDGET=8000 ;; esac
if [ -n "$TDL_OPEN" ]; then
  TDL_LEN=${#TDL_OPEN}
  TDL_FLAG=""
  [ "$TDL_LEN" -gt "$TDL_INJECT_BUDGET" ] && TDL_FLAG=" OVER-BUDGET — consolidate"
  TDL_LINE="[tdl-open: $(( TDL_LEN * 100 / TDL_INJECT_BUDGET ))% — ${TDL_LEN}/${TDL_INJECT_BUDGET} chars injected (condensed; full items in memory/TDL.md)${TDL_FLAG}]"
  if [ -n "$BUDGET_HEADER" ]; then
    BUDGET_HEADER="${BUDGET_HEADER}
${TDL_LINE}"
  else
    BUDGET_HEADER="$TDL_LINE"
  fi
fi

# --- Runtime state file (cockpit visibility) ------------------------------
# Every bot's harness version + last session id is a small machine-runtime
# fact, not a secret — write it under BOTCORP_HOME so the cockpit/daemon can
# read bot liveness without opening each bot's own memory/. Merge-write:
# read existing JSON if any, update just these keys, write back.
STATE_DIR="${BOTCORP_HOME:-$HOME/.botcorp}/state"
BOT_ID="${BOT_NAME:-$(basename "$BOT_HOME")}"
STATE_FILE="$STATE_DIR/$BOT_ID.json"
mkdir -p "$STATE_DIR" 2>/dev/null || true
HARNESS_VERSION=$("$PY" -c "import json,sys; print(json.load(open(sys.argv[1])).get('version','0.0.0'))" "$HARNESS/.claude-plugin/plugin.json" 2>/dev/null || echo "0.0.0")
NOW_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
"$PY" - "$STATE_FILE" "$HARNESS_VERSION" "$SESSION_ID" "$NOW_TS" <<'PYEOF' >/dev/null 2>&1 || true
import json, sys
path, version, session_id, ts = sys.argv[1:5]
try:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        data = {}
except Exception:
    data = {}
data["harness_version"] = version
data["session_id"] = session_id
data["last_session_start"] = ts
try:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
except Exception:
    pass
PYEOF

# --- Harness lessons index (module-gated) ---------------------------------
# Mirrors the `_guard.sh` module gate (unset BOT_MODULES = all enabled; a
# literal "*" entry also enables everything) for a module check that applies
# to only PART of this always-on hook rather than the whole file.
lessons_enabled() {
  if [ -z "${BOT_MODULES+x}" ]; then return 0; fi
  case ",${BOT_MODULES}," in
    *",lessons,"*|*",*,"*) return 0 ;;
    *) return 1 ;;
  esac
}
LESSONS_BLOCK=""
if lessons_enabled && [ -f "$HARNESS/lessons/INDEX.md" ]; then
  LESSONS_RAW=$(cat "$HARNESS/lessons/INDEX.md" 2>/dev/null || true)
  if [ -n "$LESSONS_RAW" ]; then
    LESSONS_BLOCK=$(printf '%s' "$LESSONS_RAW" | sanitize_chunk "$HARNESS/lessons/INDEX.md" || printf '%s' "$LESSONS_RAW")
  fi
fi

# --- Isolation warning -----------------------------------------------------
# CLAUDE_CONFIG_DIR unset means this bot is sharing (and can mutate) the
# operator's own ~/.claude config home rather than an isolated one.
ISOLATION_WARNING=""
if [ -z "${CLAUDE_CONFIG_DIR:-}" ]; then
  ISOLATION_WARNING="ISOLATION WARNING: CLAUDE_CONFIG_DIR is unset — this bot is running against the user's real ~/.claude config home."
fi

# One line, only with the review_board module on and a board recorded (review_board.py gates both).
BOARD_LINE=""
if [ -f "$BOT_HOME/.botcorp/review-board.json" ]; then
  BOARD_LINE=$("$PY" "$HARNESS/tools/v2/review_board.py" line 2>/dev/null || true)
fi

# Claude Code saves an additionalContext over 10,000 chars to a file and injects
# only a 2,000-char preview, so session_context.py assembles the block inside a
# 9,500-char budget (priority: TDL headlines, timeline decisions, journal,
# commitments, lessons). Fields go over stdin NUL-separated, in its FIELDS order.
OUT=$(printf '%s\0' "$ISOLATION_WARNING" "$LAST_SESSION" "$GIT_LOG" "$SESSION_ID" "$JOURNAL_PATH" \
        "$TIMELINE_PATH" "$BUDGET_HEADER" "$JOURNAL_BODY" "$TIMELINE_BODY" "$COMMITMENTS" \
        "$TDL_OPEN" "$BOARD_LINE" "$LESSONS_BLOCK" \
      | "$PY" "$HARNESS/tools/v2/session_context.py" "$BOT_HOME" "$HARNESS" 2>/dev/null || true)
if [ -z "$OUT" ]; then
  OUT='{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":""}}'
fi
printf '%s\n' "$OUT"

# Stash session id for sibling hooks (UserPromptSubmit etc.)
echo "$SESSION_ID" > "$BOT_HOME/.claude/.current_session_id" 2>/dev/null || true

exit 0
