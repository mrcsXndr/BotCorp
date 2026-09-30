"""QA pack A item 4: journal entries carry the date.

A session outlives a day, and `- [HH:MM:SS]` alone could not say which day an
entry was from.

Locked behaviour:
- `journal.py append` writes `- [YYYY-MM-DD HH:MM:SS] text` (UTC);
- a journal holding both the old time-only entries and dated ones is read in
  full by timeline.py build, recall.py index/search, precompact_extract.py and
  the session-start hook's last-session fallback.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

HARNESS = Path(__file__).resolve().parents[1]
V2 = HARNESS / "tools" / "v2"
MIXED = """---
session_id: {sid}
---

# Director's Journal

## Findings

- [09:15:00] old-format zebrafruit finding

## Decisions

- [09:16:00] old-format decision pineapple
- [2026-09-30 10:17:18] dated-format decision mangosteen

## Actions

- [2026-09-30 10:18:00] dated-format action kumquat
"""


def _env() -> dict:
    env = {k: v for k, v in os.environ.items() if k not in ("CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY")}
    env["PYTHONIOENCODING"] = "utf-8"
    return env


def _py(*args, stdin=None) -> subprocess.CompletedProcess:
    Path(os.environ["BOT_HOME"]).mkdir(parents=True, exist_ok=True)
    return subprocess.run([sys.executable, *map(str, args)], capture_output=True, text=True, encoding="utf-8",
                          input=stdin, env=_env(), timeout=120, cwd=os.environ["BOT_HOME"])


def _write_mixed(sid: str) -> Path:
    d = Path(os.environ["BOT_HOME"]) / "memory" / "sessions" / sid
    d.mkdir(parents=True, exist_ok=True)
    (d / "journal.md").write_text(MIXED.format(sid=sid), encoding="utf-8")
    return d / "journal.md"


def test_append_writes_a_dated_entry():
    r = _py(V2 / "journal.py", "append", "d1", "decision", "ship the dated stamp")
    assert r.returncode == 0, r.stderr
    text = (Path(os.environ["BOT_HOME"]) / "memory" / "sessions" / "d1" / "journal.md").read_text(encoding="utf-8")
    assert re.search(r"^- \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] ship the dated stamp$", text, re.M), text


def test_timeline_reads_both_formats():
    _write_mixed("mix1")
    r = _py(V2 / "timeline.py", "build", "mix1")
    assert r.returncode == 0, r.stderr
    tl = (Path(os.environ["BOT_HOME"]) / "memory" / "sessions" / "mix1" / "timeline.md").read_text(encoding="utf-8")
    for word in ("pineapple", "mangosteen", "zebrafruit", "kumquat"):
        assert word in tl, (word, tl)


def test_recall_indexes_both_formats():
    _write_mixed("mix2")
    assert _py(V2 / "recall.py", "index").returncode == 0
    for word, ts in (("pineapple", "09:16:00"), ("mangosteen", "2026-09-30 10:17:18")):
        r = _py(V2 / "recall.py", "search", word, "--json")
        assert r.returncode == 0, r.stderr
        hits = json.loads(r.stdout)
        hits = hits.get("results", hits) if isinstance(hits, dict) else hits
        assert any(h.get("ts") == ts and word in json.dumps(h) for h in hits), (word, hits)


def test_precompact_extract_reads_both_formats():
    sys.path.insert(0, str(V2))
    import precompact_extract as pe
    assert pe.ENTRY_RE.match("- [09:16:00] old").group(2) == "old"
    assert pe.ENTRY_RE.match("- [2026-09-30 10:17:18] new").group(2) == "new"


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash on PATH")
def test_session_start_falls_back_to_a_dated_journal(tmp_path):
    from test_hooks_fake_stdin import base_env
    home = Path(os.environ["BOT_HOME"])
    (home / ".claude").mkdir(parents=True, exist_ok=True)
    d = home / "memory" / "sessions" / "prev"
    d.mkdir(parents=True)
    (d / "journal.md").write_text("## Decisions\n\n- [2026-09-30 10:17:18] dated-only decision guava\n", encoding="utf-8")
    old = time.time() - 60
    os.utime(d / "journal.md", (old, old))
    r = subprocess.run(["bash", str(HARNESS / "hooks" / "session-start.sh")], input=json.dumps({"session_id": "now1"}),
                       capture_output=True, text=True, env=base_env(tmp_path, home), timeout=120)
    assert r.returncode == 0, r.stderr
    ctx = json.loads(r.stdout.strip().splitlines()[-1])["hookSpecificOutput"]["additionalContext"]
    assert "Last session:\n(recent journal entries — prev)" in ctx and "guava" in ctx, ctx[:600]
