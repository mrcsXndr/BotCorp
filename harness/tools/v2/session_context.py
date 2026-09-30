#!/usr/bin/env python3
"""Assemble the SessionStart additionalContext inside a hard size budget.

Claude Code caps a hook's additionalContext at 10,000 characters. Anything
longer is saved to a file and the session gets only a 2,000-character preview,
and nothing asks the model to read the file. So the journal, the timeline and
the TDL would never arrive. This keeps the whole block at or under
BUDGET characters (counted in UTF-16 code units, which is how a JavaScript
string counts its length).

Space is handed out in priority order, while the sections print in their
usual order:
  1. the TDL `## Open` items, cut down to the `###` headlines when the
     condensed block does not fit;
  2. the timeline (this session's, or the last session's), cut down to the
     newest `## Key Decisions` bullets;
  3. the journal tail;
  4. the due commitments;
  5. the lessons index, which is either shown in full or replaced by a pointer.
The small fixed lines (session id and paths, commits, memory budget, recall
hint, review board) always stay. A section that was cut ends with one line
naming the file to Read for the rest.

Usage: session_context.py <bot_home> <harness>, with the hook's values on
stdin, NUL-separated, in FIELDS order. Prints the hook's JSON line.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

BUDGET = 9500
FIELDS = ("isolation", "last_session", "git_log", "session_id", "journal_path",
          "timeline_path", "budget_header", "journal", "timeline", "commitments",
          "tdl", "board", "lessons")
CAPS = {"git": 600, "tdl": 3500, "last": 2500, "timeline": 2500, "journal": 1500, "commitments": 800}
MIN_USEFUL = 200  # below this a section is only its pointer line


def u16(s: str) -> int:
    return len(s.encode("utf-16-le")) // 2


def cut_note(how: str) -> str:
    return f"(cut to fit the session-start budget; {how} for the rest)"


def head_lines(text: str, allow: int) -> str:
    out, used = [], 0
    for ln in text.splitlines():
        if used + u16(ln) + 1 > allow:
            break
        out.append(ln)
        used += u16(ln) + 1
    return "\n".join(out)


def tail_lines(text: str, allow: int) -> str:
    out, used = [], 0
    for ln in reversed(text.splitlines()):
        if used + u16(ln) + 1 > allow:
            break
        out.append(ln)
        used += u16(ln) + 1
    if not out and text:  # one line longer than the allowance: keep its end
        return "…" + text[-max(allow - 1, 0):]
    return "\n".join(reversed(out)).lstrip("\n")


def fit_tdl(text: str, allow: int) -> str:
    if u16(text) <= allow:
        return text
    lines = text.splitlines()
    headers = [ln for ln in lines if ln.startswith("### ")]
    intro = f"(headlines only: {len(headers)} items; each item's status and next step are in memory/TDL.md)"
    out, used = [intro], u16(intro) + 1
    for i, h in enumerate(headers):
        more = f"(+{len(headers) - i} more items)"
        if used + u16(h) + 1 + u16(more) + 1 > allow:
            out.append(more)
            break
        out.append(h)
        used += u16(h) + 1
    return "\n".join(out)


def fit_timeline(text: str, allow: int) -> str:
    """The newest Key Decisions bullets that fit, else the tail of the text."""
    if u16(text) <= allow:
        return text
    lines = text.splitlines()
    label = lines[0] if lines and lines[0].startswith("(") else ""
    m = re.search(r"(?ms)^## Key Decisions[ \t]*$(.*?)(?=^## |\Z)", text)
    bullets = [ln for ln in (m.group(1).splitlines() if m else []) if ln.startswith("- ")]
    if not bullets:
        return tail_lines(text, allow)
    head = [label] if label else []
    title = f"## Key Decisions (the newest {len(bullets)} of {len(bullets)})"  # widest form, for the room sum
    room = allow - sum(u16(h) + 1 for h in head) - u16(title) - 1
    keep, used = [], 0
    for b in reversed(bullets):
        if used + u16(b) + 1 > room:
            if not keep:  # the newest one alone is too long: keep its start
                keep.append(b[:max(room - 1, 0)] + "…")
            break
        keep.append(b)
        used += u16(b) + 1
    head.append(f"## Key Decisions (the newest {len(keep)} of {len(bullets)})")
    return "\n".join(head + list(reversed(keep)))


def main() -> int:
    bot_home, harness = sys.argv[1], sys.argv[2]
    # CRLF files (a Windows-written timeline) would defeat the `$` anchors below
    raw = sys.stdin.buffer.read().decode("utf-8", "replace").replace("\r\n", "\n").split("\0")
    f = dict(zip(FIELDS, raw + [""] * (len(FIELDS) - len(raw))))
    mem = Path(bot_home) / "memory"
    tdl_path = str(mem / "TDL.md")
    lessons_path = str(Path(harness) / "lessons" / "INDEX.md")

    last_src = str(mem / "sessions")
    mm = re.match(r"\(from (\S+)\)", f["last_session"]) or re.match(r"\(recent journal entries — (\S+)\)", f["last_session"])
    if mm:
        rel = mm.group(1)
        last_src = str(mem / "sessions" / (rel if rel.endswith(".md") else f"{rel}/journal.md"))

    # [key, heading, body, fit(body, allow), pointer]; fixed sections have no fit.
    recall = ("Cross-session recall: run `python tools/v2/recall.py search \"<query>\"` for zero-LLM FTS5 recall "
              "across ALL past session journals AND the auto-memory files (no need to re-read them). A memory hit "
              "prints its 1-hop `[[link]]` neighbours; `recall.py neighbours <slug>` walks one node in full.")
    channels = (f"## v2 Context Channels\nSession ID: {f['session_id']}\n"
                f"Journal: {f['journal_path']}\nTimeline: {f['timeline_path']}")
    sections = [
        ["isolation", "", f["isolation"], None, ""],
        ["last", "Last session:\n", f["last_session"], fit_timeline, f"Read {last_src}"],
        ["git", "Recent commits:\n", f["git_log"], head_lines, "run `git log`"],
        ["channels", "", channels, None, ""],
        ["budget", "### Memory budget (frozen snapshot at session start)\n", f["budget_header"], None, ""],
        ["recall", "", recall, None, ""],
        ["journal", "### Director's Journal (working memory)\n", f["journal"], tail_lines, f"Read {f['journal_path']}"],
        ["timeline", "### Timeline (distilled narrative)\n", f["timeline"], fit_timeline, f"Read {f['timeline_path']}"],
        ["commitments", "## Due commitments\n", f["commitments"], head_lines, "run `python tools/v2/commitments.py surface`"],
        ["tdl", "## Open TDL (persistent backlog — memory/TDL.md; hand-maintained, edit it directly with Edit/Write)\n",
         f["tdl"], fit_tdl, f"Read {tdl_path}"],
        ["board", "", f["board"], None, ""],
        ["lessons", "## Harness lessons (index)\n", f["lessons"], None, ""],
    ]
    sections = [s for s in sections if s[2]]
    rendered = {s[0]: s[1] + s[2] for s in sections}

    # Separators: "\n\n" between sections.
    fixed = sum(u16(rendered[s[0]]) + 2 for s in sections if s[3] is None and s[0] != "lessons")
    remaining = BUDGET - fixed
    for key in ("tdl", "last", "timeline", "journal", "git", "commitments"):
        s = next((x for x in sections if x[0] == key), None)
        if not s:
            continue
        heading, body, fit, pointer = s[1], s[2], s[3], s[4]
        full = u16(heading) + u16(body) + 2
        if full <= min(CAPS[key], remaining):
            remaining -= full
            continue
        note = cut_note(pointer)
        allow = min(CAPS[key], remaining) - u16(heading) - u16(note) - 3
        body = fit(body, allow) if allow >= MIN_USEFUL else ""
        rendered[key] = heading + (body + "\n" if body else "") + note
        remaining -= u16(rendered[key]) + 2
    s = next((x for x in sections if x[0] == "lessons"), None)
    if s and u16(rendered["lessons"]) + 2 > remaining:
        rendered["lessons"] = f"Harness lessons index: Read {lessons_path} (left out to fit the session-start budget)."

    ctx = "\n\n".join(rendered[s[0]] for s in sections)
    if u16(ctx) > BUDGET:  # the fixed lines alone overran: hard stop
        note = f"\n[session-start context cut at {BUDGET} chars; full journal/timeline/TDL on disk: {f['journal_path']}, {f['timeline_path']}, {tdl_path}]"
        room = BUDGET - u16(note)
        while u16(ctx) > room:  # cutting the excess in code points removes at least that many code units
            ctx = ctx[:len(ctx) - (u16(ctx) - room)]
        ctx += note
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": ctx}}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
