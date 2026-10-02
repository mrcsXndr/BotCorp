#!/usr/bin/env python3
"""SessionStart hook body: session-start.sh runs this as ONE python process.

The steps used to be about 35 bash forks, each a fork() emulation that costs
200 ms or more on Windows (Git Bash), so the hook ran past its 30 s timeout on
a loaded box. Here the helper tools run as native child processes (recall
index and due commitments in parallel) and everything else runs in-process.
Steps, inputs and output are the bash version's:

- refresh the cross-session recall index;
- ensure memory/sessions/<session_id>/journal.md exists;
- last-session context, recent commits, this session's journal tail and
  timeline, each memory chunk sanitized (tools/v2/sanitize_chunk.py);
- the memory-budget header, due commitments and the condensed TDL `## Open`;
- this bot's harness version / session id into the runtime state file;
- the lessons index (module `lessons`), the isolation warning, the review
  board line; all assembled inside the 9,500-char budget by
  tools/v2/session_context.py;
- the session id into .claude/.current_session_id for sibling hooks.

Usage: session_start.py <bot_home> <harness>, the hook payload on stdin.
STRICTLY FAIL-OPEN: every step swallows its own errors; it always prints the
hook's JSON line and exits 0.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

BOT_HOME = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()
HARNESS = sys.argv[2] if len(sys.argv) > 2 else str(Path(__file__).resolve().parents[1])
sys.path.insert(0, str(Path(HARNESS) / "tools" / "v2"))
PY = sys.executable
PLACEHOLDERS = ("_(none yet)_", "_(none recorded)_")


def tool(rel: str) -> str:
    return str(Path(HARNESS) / "tools" / rel)


def run(args: list[str], stdin: str | None = None) -> str:
    """A child's stdout with trailing newlines stripped (as `$(...)` does); '' on any failure."""
    try:
        r = subprocess.run(args, input=stdin, stdin=None if stdin is not None else subprocess.DEVNULL,
                           capture_output=True, text=True, encoding="utf-8", errors="replace")
        return (r.stdout or "").rstrip("\n") if r.returncode == 0 else ""
    except Exception:
        return ""


def read_text(p: str | Path) -> str:
    try:
        return Path(p).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def sanitize(text: str, label: str) -> str:
    if not text:
        return text
    try:
        from sanitize_chunk import clean
        return clean(text, label).rstrip("\n")
    except Exception:
        return text


# --- Last-session context ----------------------------------------------------
# Prefer the most recent non-stub timeline.md (distilled narrative), else the
# tail of the most recent journal.md that has real entries, else omit.
def timeline_payload(p: Path):
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


def journal_payload(p: Path):
    """Tail of a journal that has real `- [YYYY-MM-DD HH:MM:SS] ...` entries (or old `- [HH:MM:SS]`)."""
    try:
        lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return None
    entry = re.compile(r"^- \[(?:\d{4}-\d{2}-\d{2} )?\d{2}:\d{2}:\d{2}\] (.+)$")
    bullets = [ln for ln in lines if entry.match(ln.strip()) and entry.match(ln.strip()).group(1).strip() not in PLACEHOLDERS]
    if not bullets:
        return None
    tail = bullets[-15:]
    return "\n".join(tail)[:4000]


def last_session(current: str) -> str:
    sessions = Path(BOT_HOME) / "memory" / "sessions"
    # SESSION-RECENCY-FIRST: rank SESSIONS by recency (max mtime of their
    # journal/timeline), then for the newest session prefer its timeline, else
    # its journal: a session that ended without a timeline but with a rich
    # journal must not lose to an older session that has one.
    try:
        dirs = [d for d in sessions.iterdir() if d.is_dir()]
    except OSError:
        return ""

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

    # The newest session with content being THIS one (a resume or a compaction)
    # means its own journal and timeline blocks already carry it: return nothing
    # rather than inject the same timeline twice.
    for d in sorted(dirs, key=recency, reverse=True):
        tl = d / "timeline.md"
        if tl.is_file():
            pl = timeline_payload(tl)
            if pl:
                return f"(from {d.name}/timeline.md)\n{pl}" if d.name != current else ""
        jr = d / "journal.md"
        if jr.is_file():
            pl = journal_payload(jr)
            if pl:
                return f"(recent journal entries — {d.name})\n{pl}" if d.name != current else ""
    return ""


# --- Memory budget header ----------------------------------------------------
# Frozen-snapshot usage header so the Director SEES how full the durable
# index (the auto-memory MEMORY.md Claude Code loads) and this session's
# journal are, and self-consolidates before they bloat. Journal budget is chars.
# Claude Code loads only the first 200 lines or 25KB of the auto-memory index,
# whichever comes first (https://code.claude.com/docs/en/memory, "How it
# works"). That index lives in `autoMemoryDirectory`, which `botcorp sync`
# writes to <bot>/.claude/settings.json (default <bot>/memory/auto). The
# curated <bot>/memory/MEMORY.md is never injected: it is only the fallback
# for a bot that has no auto index at all.
MEMORY_MAX_LINES = 200
MEMORY_MAX_BYTES = 25000


def memory_index_path() -> str:
    d = f"{BOT_HOME}/memory/auto"
    try:
        with open(f"{BOT_HOME}/.claude/settings.json", encoding="utf-8") as f:
            cfg = json.load(f).get("autoMemoryDirectory")
        if isinstance(cfg, str) and cfg:
            d = os.path.expanduser(cfg)
    except (OSError, ValueError, AttributeError):
        pass
    auto = os.path.join(d, "MEMORY.md")
    return auto if os.path.isfile(auto) else f"{BOT_HOME}/memory/MEMORY.md"


def memory_line() -> str | None:
    path = memory_index_path()
    try:
        n = os.path.getsize(path)
        with open(path, "rb") as f:
            lines = f.read().count(b"\n") + 1
    except OSError:
        return None
    pct = round(100 * max(lines / MEMORY_MAX_LINES, n / MEMORY_MAX_BYTES))
    over = lines > MEMORY_MAX_LINES or n > MEMORY_MAX_BYTES
    flag = " OVER-LIMIT — the tail is not loaded, consolidate" if over else ""
    return f"[memory: {pct}% — {lines}/{MEMORY_MAX_LINES} lines, {n:,}/{MEMORY_MAX_BYTES:,} bytes{flag}]"


def budget_header(journal_path: str, journal_budget: int) -> str:
    def line(label, path, budget):
        try:
            n = os.path.getsize(path)
        except OSError:
            return None
        pct = round(100 * n / budget) if budget else 0
        flag = " OVER-BUDGET — consolidate" if n > budget else ""
        return f"[{label}: {pct}% — {n:,}/{budget:,} chars{flag}]"
    out = []
    for ln in (memory_line(), line("journal", journal_path, journal_budget)):
        if ln:
            out.append(ln)
    return "\n".join(out)


# --- Persistent TDL (single always-in-memory backlog) --------------------
# memory/TDL.md is the durable, HAND-MAINTAINED "what's unfinished" doc; this
# hook only READS it. CONDENSED: only each item's `###` header plus its latest
# status/next-step line (last line carrying an uppercase status marker, else
# the first body line). Missing/malformed file or empty extraction -> ''.
def tdl_open() -> str:
    try:
        text = open(f"{BOT_HOME}/memory/TDL.md", encoding="utf-8", errors="replace").read()
    except OSError:
        return ""
    m = re.search(r"(?ms)^## Open[ \t]*$(.*?)(?=^## |\Z)", text)
    if not m:
        return ""
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
        return ""
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
    return "\n".join(out)


# --- Runtime state file (cockpit visibility) ------------------------------
# Every bot's harness version + last session id is a small machine-runtime
# fact, not a secret: merge-written under BOTCORP_HOME so the cockpit/daemon
# can read bot liveness without opening each bot's own memory/.
def write_state(session_id: str) -> None:
    state_dir = Path(os.environ.get("BOTCORP_HOME") or os.path.join(os.path.expanduser("~"), ".botcorp")) / "state"
    bot_id = os.environ.get("BOT_NAME") or Path(BOT_HOME).name
    try:
        state_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass
    try:
        version = json.load(open(Path(HARNESS) / ".claude-plugin" / "plugin.json")).get("version", "0.0.0")
    except Exception:
        version = "0.0.0"
    path = state_dir / f"{bot_id}.json"
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            data = {}
    except Exception:
        data = {}
    data["harness_version"] = version
    data["session_id"] = session_id
    data["last_session_start"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
    except Exception:
        pass


def lessons_enabled() -> bool:
    # unset BOT_MODULES = all enabled; a literal "*" entry also enables everything
    if "BOT_MODULES" not in os.environ:
        return True
    return bool({"lessons", "*"} & set(os.environ["BOT_MODULES"].split(",")))


def main() -> str:
    # Refresh the FTS5 recall index (incremental, mtime-gated) and look up due
    # commitments while the rest runs: neither depends on anything below.
    bg = {}
    for key, args in (("recall", [PY, tool("v2/recall.py"), "index"]), ("commitments", [PY, tool("v2/commitments.py"), "surface"])):
        try:
            bg[key] = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE if key == "commitments" else subprocess.DEVNULL,
                                       stderr=subprocess.DEVNULL, text=True, encoding="utf-8", errors="replace")
        except Exception:
            pass

    payload = ""
    try:
        if not sys.stdin.isatty():
            payload = sys.stdin.read()
    except Exception:
        pass
    session_id = ""
    if payload:
        try:
            session_id = str(json.loads(payload or "{}").get("session_id") or "").strip("\n")
        except Exception:
            session_id = ""
    if not session_id:
        session_id = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")

    # Create journal (idempotent)
    run([PY, tool("v2/journal.py"), "new", session_id])
    journal_path = f"{BOT_HOME}/memory/sessions/{session_id}/journal.md"
    timeline_path = f"{BOT_HOME}/memory/sessions/{session_id}/timeline.md"

    last = ""
    try:
        last = last_session(session_id)
    except Exception:
        pass
    git_log = run(["git", "log", "--oneline", "-5"])

    journal_budget = os.environ.get("BOT_JOURNAL_HEAD_BYTES") or "20000"
    journal_body = ""
    if os.path.isfile(journal_path):
        # At most the last ~20K bytes; session_context.py cuts it further to fit
        # the injection budget. The full journal is always on disk to Read.
        try:
            with open(journal_path, "rb") as f:
                f.seek(0, os.SEEK_END)
                n = int(journal_budget)
                f.seek(max(f.tell() - n, 0))
                journal_body = f.read().decode("utf-8", "ignore").replace("\r\n", "\n").replace("\r", "\n").rstrip("\n")
        except Exception:
            journal_body = ""
    timeline_body = read_text(timeline_path).rstrip("\n") if os.path.isfile(timeline_path) else ""

    # Sanitize external-derived memory before injection: journal / timeline /
    # last-session / lessons can carry pasted TG/web content (a prompt-injection
    # persistence vector). HIGH/CRITICAL -> a [BLOCKED ...] marker.
    last = sanitize(last, "last-session")
    journal_body = sanitize(journal_body, journal_path)
    timeline_body = sanitize(timeline_body, timeline_path)

    header = ""
    try:
        header = budget_header(journal_path, int(journal_budget))
    except Exception:
        pass

    tdl = ""
    try:
        tdl = tdl_open()
    except Exception:
        pass
    # Account for the TDL injection in the budget header so its size stays
    # visible and an over-budget Open section nags for consolidation too.
    b = os.environ.get("BOT_TDL_INJECT_BUDGET", "8000")
    tdl_budget = int(b) if b.isascii() and b.isdigit() and int(b) > 0 else 8000
    if tdl:
        n = len(tdl)
        flag = " OVER-BUDGET — consolidate" if n > tdl_budget else ""
        tdl_line = f"[tdl-open: {n * 100 // tdl_budget}% — {n}/{tdl_budget} chars injected (condensed; full items in memory/TDL.md){flag}]"
        header = f"{header}\n{tdl_line}" if header else tdl_line

    write_state(session_id)

    lessons = ""
    lessons_path = f"{HARNESS}/lessons/INDEX.md"
    if lessons_enabled() and os.path.isfile(lessons_path):
        lessons = sanitize(read_text(lessons_path).rstrip("\n"), lessons_path)

    # CLAUDE_CONFIG_DIR unset means this bot is sharing (and can mutate) the
    # operator's own ~/.claude config home rather than an isolated one.
    isolation = "" if os.environ.get("CLAUDE_CONFIG_DIR") else \
        "ISOLATION WARNING: CLAUDE_CONFIG_DIR is unset — this bot is running against the user's real ~/.claude config home."

    # One line, only with the review_board module on and a board recorded (review_board.py gates both).
    board = run([PY, tool("v2/review_board.py"), "line"]) if os.path.isfile(f"{BOT_HOME}/.botcorp/review-board.json") else ""

    commitments = ""
    p = bg.get("commitments")
    if p:
        try:
            out, _ = p.communicate()
            commitments = (out or "").rstrip("\n") if p.returncode == 0 else ""
        except Exception:
            pass
    if bg.get("recall"):
        try:
            bg["recall"].wait()
        except Exception:
            pass

    # Claude Code saves an additionalContext over 10,000 chars to a file and
    # injects only a 2,000-char preview, so session_context.py assembles the
    # block inside a 9,500-char budget.
    from session_context import assemble
    out = assemble(BOT_HOME, HARNESS, [isolation, last, git_log, session_id, journal_path, timeline_path, header,
                                       journal_body, timeline_body, commitments, tdl, board, lessons])

    # Stash session id for sibling hooks (UserPromptSubmit etc.)
    try:
        with open(f"{BOT_HOME}/.claude/.current_session_id", "w", encoding="utf-8") as f:
            f.write(session_id + "\n")
    except OSError:
        pass
    return out


if __name__ == "__main__":
    try:
        out = main()
    except Exception:
        out = ""
    out = out or '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":""}}'
    sys.stdout.buffer.write((out + "\n").encode("utf-8"))  # "\n", not the Windows text-mode "\r\n"
    sys.exit(0)
