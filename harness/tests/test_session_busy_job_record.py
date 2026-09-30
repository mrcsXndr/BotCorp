"""Code review 2026-09-30, D12 (and D7 for bg sessions): Test-SessionBusy
(daemon/_common.ps1) judged idle by transcript mtime alone, so one tool call
running past 5 min read idle, and a breakpoint marker read idle for 30 min
even after a new turn had started. Claude Code's own job record
(<config>/jobs/<bg_id>/state.json) says `tempo: active` while a turn runs; a
fresh one is BUSY, ahead of the transcript and the marker. `state: working`
alone is not: an idle session with monitors in flight keeps it.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

ASSEMBLY = Path(__file__).resolve().parents[2]
COMMON = ASSEMBLY / "daemon" / "_common.ps1"

pytestmark = pytest.mark.skipif(sys.platform != "win32" or shutil.which("pwsh") is None, reason="Windows with pwsh on PATH")

BG = "abc123ef"


def _box(tmp_path: Path, job: dict | None, job_age_min: float = 0, breakpoint: bool = False) -> dict:
    rt, bots = tmp_path / "rt", tmp_path / "bots"
    home = bots / "demo"
    (rt / "state").mkdir(parents=True, exist_ok=True)
    home.mkdir(parents=True, exist_ok=True)
    (home / "bot.yaml").write_text("name: demo\n", encoding="utf-8")
    (rt / "state" / "demo.json").write_text(json.dumps({"bot": "demo", "bg_id": BG}), encoding="utf-8")
    # a transcript quiet for an hour: by mtime alone the session reads idle
    proj = home / ".claude-demo" / "projects" / "".join(c if c.isalnum() else "-" for c in str(home))
    proj.mkdir(parents=True, exist_ok=True)
    t = proj / "s.jsonl"
    t.write_text("{}\n", encoding="utf-8")
    old = time.time() - 3600
    os.utime(t, (old, old))
    if job is not None:
        jf = home / ".claude-demo" / "jobs" / BG / "state.json"
        jf.parent.mkdir(parents=True, exist_ok=True)
        jf.write_text(json.dumps(job), encoding="utf-8")
        at = time.time() - job_age_min * 60
        os.utime(jf, (at, at))
    if breakpoint:
        (home / ".claude").mkdir(exist_ok=True)
        (home / ".claude" / ".botcorp_breakpoint").write_text("", encoding="utf-8")
    env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE", "TELEGRAM_", "BOT_"))}
    env.update({"BOTCORP_HOME": str(rt), "BOTCORP_BOTS_DIR": str(bots), "BOTCORP_ROOT": str(ASSEMBLY), "BOT_TG_MUTE": "1"})
    return env


def _busy(env: dict) -> bool:
    body = f". '{COMMON}'\nWrite-Output \"BUSY=$(Test-SessionBusy -Bot demo)\""
    r = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", body],
                       env=env, capture_output=True, text=True, timeout=120)
    line = [l for l in r.stdout.splitlines() if l.startswith("BUSY=")]
    assert line, r.stdout + r.stderr
    return line[-1] == "BUSY=True"


def test_a_turn_in_progress_is_busy_though_the_transcript_is_quiet(tmp_path):
    assert _busy(_box(tmp_path, {"state": "working", "tempo": "active", "inFlight": {"tasks": 1}}))


def test_a_turn_in_progress_beats_a_fresh_breakpoint(tmp_path):
    assert _busy(_box(tmp_path, {"state": "working", "tempo": "active"}, breakpoint=True))


def test_positive_control_an_idle_session_with_monitors_in_flight_is_idle(tmp_path):
    assert not _busy(_box(tmp_path, {"state": "working", "tempo": "idle", "inFlight": {"tasks": 7, "kinds": ["local_bash", "artifact_watch"]}}))


def test_a_stale_active_record_is_not_trusted_over_the_transcript(tmp_path):
    assert not _busy(_box(tmp_path, {"state": "working", "tempo": "active"}, job_age_min=120))


def test_no_job_record_keeps_the_transcript_rule(tmp_path):
    assert not _busy(_box(tmp_path, None))
