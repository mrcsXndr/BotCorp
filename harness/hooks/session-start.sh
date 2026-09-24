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
LAST_SESSION=$("$PY" - "$BOT_HOME" <<'PYEOF' 2>/dev/null || true
import os, sys
from pathlib import Path

bot_home = Path(sys.argv[1])
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
    return body.strip()[:4000]

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

for d in session_dirs_newest_first():
    tl = d / "timeline.md"
    if tl.is_file():
        pl = timeline_payload(tl)
        if pl:
            print(f"(from {d.name}/timeline.md)\n{pl}")
            sys.exit(0)
    jr = d / "journal.md"
    if jr.is_file():
        pl = journal_payload(jr)
        if pl:
            print(f"(recent journal entries — {d.name})\n{pl}")
            sys.exit(0)

# nothing usable -> empty (block omitted by the hook)
PYEOF
)
GIT_LOG=$(git log --oneline -5 2>/dev/null || echo "")

JOURNAL_BODY=""
if [ -f "$JOURNAL_PATH" ]; then
  # Cap journal load at last ~20K chars (~5K tokens) so a long-running
  # session's journal doesn't bloat startup context. Full journal is
  # always available on disk if the Director needs to Read it.
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

CONTEXT=""
if [ -n "$ISOLATION_WARNING" ]; then
  CONTEXT="$ISOLATION_WARNING"
fi
if [ -n "$LAST_SESSION" ]; then
  CONTEXT="$CONTEXT\n\nLast session:\n$LAST_SESSION"
fi
if [ -n "$GIT_LOG" ]; then
  CONTEXT="$CONTEXT\n\nRecent commits:\n$GIT_LOG"
fi
CONTEXT="$CONTEXT\n\n## v2 Context Channels\nSession ID: $SESSION_ID\nJournal: $JOURNAL_PATH\nTimeline: $TIMELINE_PATH"
if [ -n "$BUDGET_HEADER" ]; then
  CONTEXT="$CONTEXT\n\n### Memory budget (frozen snapshot at session start)\n$BUDGET_HEADER"
fi
CONTEXT="$CONTEXT\n\nCross-session recall: run \`python tools/v2/recall.py search \"<query>\"\` for zero-LLM FTS5 recall across ALL past session journals AND the auto-memory files (no need to re-read them). A memory hit prints its 1-hop \`[[link]]\` neighbours; \`recall.py neighbours <slug>\` walks one node in full."
if [ -n "$JOURNAL_BODY" ]; then
  CONTEXT="$CONTEXT\n\n### Director's Journal (working memory)\n$JOURNAL_BODY"
fi
if [ -n "$TIMELINE_BODY" ]; then
  CONTEXT="$CONTEXT\n\n### Timeline (distilled narrative)\n$TIMELINE_BODY"
fi
if [ -n "$COMMITMENTS" ]; then
  CONTEXT="$CONTEXT\n\n## Due commitments\n$COMMITMENTS"
fi
if [ -n "$TDL_OPEN" ]; then
  CONTEXT="$CONTEXT\n\n## Open TDL (persistent backlog — memory/TDL.md; hand-maintained, edit it directly with Edit/Write)\n$TDL_OPEN"
fi
if [ -n "$LESSONS_BLOCK" ]; then
  CONTEXT="$CONTEXT\n\n## Harness lessons (index)\n$LESSONS_BLOCK"
fi

if [ -n "$CONTEXT" ]; then
  ESCAPED=$(printf '%s' "$CONTEXT" | "$PY" -c "import sys,json; print(json.dumps(sys.stdin.read()))" 2>/dev/null || echo '""')
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":%s}}\n' "$ESCAPED"
fi

# Stash session id for sibling hooks (UserPromptSubmit etc.)
echo "$SESSION_ID" > "$BOT_HOME/.claude/.current_session_id" 2>/dev/null || true

exit 0
