"""v0.8.5: the SessionStart additionalContext fits Claude Code's 10,000-char cap.

Claude Code saves a longer additionalContext to a file and injects only a
2,000-char preview, so the journal, timeline and TDL never reached the session.

Locked behaviour:
- a bot with a huge journal, timeline and TDL gets <= 9,500 chars (UTF-16 units),
  still carrying every TDL Open headline and the newest timeline decisions, and
  each cut section ends with one line naming the file to Read;
- sections are joined with real newlines, never a literal backslash-n;
- on a resume the session's own timeline is not injected a second time as
  "Last session"; on a fresh start the previous session's is;
- a small bot's block is what it was, minus the literal backslash-n;
- session_context.py hard-stops at 9,500 even when the fixed lines overrun.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

from test_hooks_fake_stdin import base_env, bot_home, run_hook  # noqa: F401  (bot_home is a fixture)

ASSEMBLER = Path(__file__).resolve().parents[1] / "tools" / "v2" / "session_context.py"
LIMIT = 9500
TDL_INTRO = ("(condensed: 2 items — header + latest status line each; "
             "full detail per item lives in memory/TDL.md, Read it before working an item)")


def u16(s: str) -> int:
    return len(s.encode("utf-16-le")) // 2


def context(tmp_path, home, sid, modules=""):
    proc = run_hook("session-start.sh", base_env(tmp_path, home, {"BOT_MODULES": modules}), json.dumps({"session_id": sid}))
    assert proc.returncode == 0, proc.stderr
    lines = [ln for ln in proc.stdout.splitlines() if ln.strip()]
    return json.loads(lines[-1])["hookSpecificOutput"]["additionalContext"]


def timeline(sid: str, n: int, tag: str) -> str:
    bullets = "\n".join(f"- [{i:02d}:00:00] {tag} decision {i:03d} " + "x" * 300 for i in range(n))
    return (f"---\r\nsession_id: {sid}\r\n---\r\n\r\n# Critic's Timeline (structural)\r\n\r\n## Key Decisions\r\n\r\n"
            + bullets.replace("\n", "\r\n") + "\r\n\r\n## Top Findings\r\n\r\n- a finding " + "y" * 4000 + "\r\n")


def make_huge(home: Path, current: str, previous: str):
    tdl = ["# TDL", "", "## Open", ""]
    for i in range(25):
        tdl += [f"### item {i:02d} " + "h" * 80, f"- NEXT STEP: step for item {i:02d} " + "s" * 250, "- more detail " + "d" * 400, ""]
    tdl += ["## Done", "", "(nothing)"]
    (home / "memory" / "TDL.md").write_text("\n".join(tdl) + "\n", encoding="utf-8")
    for sid in (previous, current):
        d = home / "memory" / "sessions" / sid
        d.mkdir(parents=True, exist_ok=True)
        (d / "timeline.md").write_bytes(timeline(sid, 60, sid).encode("utf-8"))
        entries = "\n\n".join(f"- [10:{i % 60:02d}:00] journal entry {i:04d} " + "j" * 250 for i in range(200))
        (d / "journal.md").write_text(f"---\nsession_id: {sid}\n---\n\n# Director's Journal\n\n## Actions\n\n{entries}\n", encoding="utf-8")
    # the current session is the newest one
    old = time.time() - 3600
    for f in (home / "memory" / "sessions" / previous).iterdir():
        os.utime(f, (old, old))


def test_huge_bot_fits_and_keeps_the_tdl_headlines(tmp_path, bot_home):
    make_huge(bot_home, "cur1", "prev1")
    ctx = context(tmp_path, bot_home, "cur1", modules="lessons")
    assert u16(ctx) <= LIMIT, u16(ctx)
    assert "\\n" not in ctx
    for i in range(25):
        assert f"### item {i:02d} " in ctx, i
    assert "cur1 decision 059" in ctx                      # the newest decision of this session's timeline
    assert "cur1 decision 000" not in ctx                  # the oldest one was cut
    assert "journal entry 0199" in ctx                     # the journal tail
    assert "Last session:" not in ctx                      # a resume: no duplicate of its own timeline
    for f in ("TDL.md", "cur1/journal.md", "cur1/timeline.md"):
        assert any("cut to fit the session-start budget; Read" in ln and ln.replace("\\", "/").removesuffix(" for the rest)").endswith(f)
                   for ln in ctx.splitlines()), f
    assert "Harness lessons" in ctx                        # the index, or the one-line pointer to it


def test_fresh_start_carries_the_previous_sessions_newest_decisions(tmp_path, bot_home):
    make_huge(bot_home, "prev2", "older2")
    ctx = context(tmp_path, bot_home, "fresh2")
    assert u16(ctx) <= LIMIT, u16(ctx)
    assert ctx.startswith("Last session:\n(from prev2/timeline.md)\n## Key Decisions (the newest ")
    assert "prev2 decision 059" in ctx and "prev2 decision 000" not in ctx
    assert "older2" not in ctx


def test_small_bot_block_is_unchanged_but_for_real_newlines(tmp_path, bot_home):
    ctx = context(tmp_path, bot_home, "s1")
    journal = (bot_home / "memory" / "sessions" / "s1" / "journal.md").read_text(encoding="utf-8").rstrip("\n")
    assert "\\n" not in ctx and "cut to fit" not in ctx and "Last session:" not in ctx
    assert ctx.startswith("## v2 Context Channels\nSession ID: s1\nJournal: ")
    assert "\n\n### Memory budget (frozen snapshot at session start)\n[journal: " in ctx
    assert f"\n\n### Director's Journal (working memory)\n{journal}\n\n## Open TDL (persistent backlog" in ctx
    assert ctx.endswith(f"edit it directly with Edit/Write)\n{TDL_INTRO}\n### item one\n  - - NEXT STEP: do the thing\n### item two\n  - - some plain note")
    lessons = (Path(__file__).resolve().parents[1] / "lessons" / "INDEX.md").read_text(encoding="utf-8").strip()
    with_lessons = context(tmp_path, bot_home, "s1", modules="lessons")
    assert with_lessons == ctx + "\n\n## Harness lessons (index)\n" + lessons


def test_a_bullet_style_tdl_reaches_the_session(tmp_path, bot_home):
    # A TDL of top-level "- **title**" bullets with indented detail and no ###
    # items. Before v0.9.1 its whole Open section was dropped.
    tdl = ["# TDL", "", "## Open", ""]
    for i in range(40):
        tdl += [f"- **[WAITING-operator: keys / PAT / prod] 2026-09-{i % 28 + 1:02d} — bullet item {i:02d}, a long title.** " + "b" * 200,
                f"  - detail for {i:02d} " + "d" * 300, "  - NEXT: step " + "n" * 100]
    tdl += ["- **[DONE] 2026-09-26 — finished thing.** gone", "  - done detail",
            "- **[DONE 2026-09-28 12:48Z] dated finished thing.**", "- **[superseded by the line above] stale thing.**",
            "- **[DONE-ish] 2026-09-25 — half-done thing.**", "", "## Inherited at cutoff", "", "- old item", "## Done"]
    (bot_home / "memory" / "TDL.md").write_text("\n".join(tdl) + "\n", encoding="utf-8")
    ctx = context(tmp_path, bot_home, "s1")
    assert u16(ctx) <= LIMIT, u16(ctx)
    assert "## Open TDL (persistent backlog" in ctx
    heads = [ln for ln in ctx.splitlines() if ln.startswith("### [WAITING-operator")]
    assert len(heads) == 40, len(heads)                      # every open item's headline, cut to 72 chars
    assert all(len(h) <= 4 + 72 for h in heads)
    assert "bullet item 39" in ctx
    assert "finished thing" not in ctx and "stale thing" not in ctx and "old item" not in ctx
    assert "half-done thing" in ctx


def test_assembler_hard_stops_when_the_fixed_lines_overrun(tmp_path):
    fields = ["", "", "", "s9", "/j.md", "/t.md", "[memory: " + "z" * 12000 + "]", "", "", "", "### one", "", ""]
    r = subprocess.run([sys.executable, str(ASSEMBLER), str(tmp_path), str(tmp_path)], input="\0".join(fields).encode("utf-8"),
                       capture_output=True, timeout=30)
    assert r.returncode == 0, r.stderr
    ctx = json.loads(r.stdout)["hookSpecificOutput"]["additionalContext"]
    assert u16(ctx) <= LIMIT
    assert ctx.rstrip().endswith("]") and "session-start context cut at 9500 chars" in ctx
