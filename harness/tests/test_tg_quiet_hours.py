"""QA pack A item 7: quiet hours for scheduled Telegram sends.

Locked behaviour:
- bot.yaml integrations.telegram.quiet is 'HH:MM-HH:MM' (may wrap midnight) or
  null; validate rejects anything else; sync writes it into
  <config_home>/botcorp/telegram.json next to default_chat_id;
- tg_send.py with BOT_TG_SCHEDULED=1 inside that window holds the message in
  memory/metrics/alerts.log and sends nothing; outside the window, or without
  BOT_TG_SCHEDULED, it sends as before; a CRITICAL --alert still goes out.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from test_operator_only import ASSEMBLY, box, cli, make_bot, needs_node  # noqa: F401

TG_SEND = ASSEMBLY / "harness" / "tools" / "tg" / "tg_send.py"
BOTYAML = ASSEMBLY / "daemon" / "botyaml.mjs"
sys.path.insert(0, str(TG_SEND.parent))
import tg_send  # noqa: E402


@pytest.mark.parametrize("window,hhmm,quiet", [
    ("22:00-08:00", "23:30", True), ("22:00-08:00", "03:00", True), ("22:00-08:00", "08:00", False),
    ("22:00-08:00", "12:00", False), ("09:00-17:00", "09:00", True), ("09:00-17:00", "17:00", False),
    ("", "03:00", False), ("bogus", "03:00", False),
])
def test_in_quiet_hours(window, hhmm, quiet):
    h, m = map(int, hhmm.split(":"))
    assert tg_send.in_quiet_hours(window, dt.datetime(2026, 9, 30, h, m)) is quiet


def _window_around_now(inside: bool) -> str:
    now = dt.datetime.now()
    a = now + dt.timedelta(minutes=-60 if inside else 60)
    b = now + dt.timedelta(minutes=60 if inside else 120)
    return f"{a:%H:%M}-{b:%H:%M}"


def _send(tmp_path, window: str, *args: str, scheduled: bool = True) -> tuple[subprocess.CompletedProcess, list[str]]:
    cfg = Path(os.environ["CLAUDE_CONFIG_DIR"])
    (cfg / "botcorp").mkdir(parents=True, exist_ok=True)
    (cfg / "botcorp" / "telegram.json").write_text(json.dumps({"default_chat_id": "1", "quiet": window}), encoding="utf-8")
    env = {**os.environ, "PYTHONIOENCODING": "utf-8", "BOT_TG_STATUS": "0", "BOT_TG_UNANSWERED_MAX": "0"}
    env.pop("BOT_TG_SCHEDULED", None)
    if scheduled:
        env["BOT_TG_SCHEDULED"] = "1"
    r = subprocess.run([sys.executable, str(TG_SEND), *args], capture_output=True, text=True, env=env, timeout=60)
    log = Path(os.environ["BOT_HOME"]) / "memory" / "metrics" / "alerts.log"
    return r, (log.read_text(encoding="utf-8").splitlines() if log.exists() else [])


def test_a_scheduled_send_inside_the_window_is_held(tmp_path):
    window = _window_around_now(inside=True)
    r, lines = _send(tmp_path, window, "morning digest")
    assert r.returncode == 0 and "[quiet]" in r.stderr and "BOT_TG_MUTE" not in r.stderr, r.stderr
    assert len(lines) == 1 and f"[quiet hours {window}] morning digest" in lines[0]


def test_outside_the_window_or_unscheduled_it_sends(tmp_path):
    r, lines = _send(tmp_path, _window_around_now(inside=False), "digest")
    assert "[BOT_TG_MUTE] suppressed" in r.stderr and lines == []          # reached the send path (muted in tests)
    r, lines = _send(tmp_path, _window_around_now(inside=True), "a reply", scheduled=False)
    assert "[BOT_TG_MUTE] suppressed" in r.stderr and lines == []


def test_a_critical_alert_still_goes_out(tmp_path):
    window = _window_around_now(inside=True)
    r, lines = _send(tmp_path, window, "--alert", "CRITICAL: site down")
    assert "[BOT_TG_MUTE] suppressed" in r.stderr, r.stderr
    assert len(lines) == 1 and "[quiet hours" not in lines[0]
    r, lines = _send(tmp_path, window, "--alert", "disk at 91%")          # non-critical: logged, as always
    assert "[BOT_TG_MUTE]" not in r.stderr and len(lines) == 2


@needs_node
@pytest.mark.parametrize("value,ok", [("'22:00-08:00'", True), ("null", True), ("'22:00-22:00'", False), ("'25:00-08:00'", False), ("'10pm-8am'", False), ("[22, 8]", False)])
def test_validate_takes_a_window_or_null(tmp_path, value, ok):
    f = tmp_path / "t" / "bot.yaml"
    f.parent.mkdir(parents=True)
    f.write_text(f"name: t\nintegrations:\n  telegram:\n    quiet: {value}\n", encoding="utf-8")
    r = subprocess.run(["node", str(BOTYAML), str(f), "--validate"], capture_output=True, text=True, timeout=60, cwd=str(ASSEMBLY))
    assert (r.returncode == 0) is ok, r.stderr
    if not ok:
        assert "integrations.telegram.quiet" in r.stderr


@needs_node
def test_sync_writes_the_window_for_tg_send(box):
    rt, bots, env = box
    make_bot(bots, "t", "name: t\nharness:\n  service: manual\nintegrations:\n  telegram:\n    quiet: '22:00-08:00'\n")
    r = cli(env, "sync", "t")
    assert r.returncode == 0, r.stdout + r.stderr
    gen = json.loads((bots / "t" / ".claude-t" / "botcorp" / "telegram.json").read_text(encoding="utf-8"))
    assert gen["quiet"] == "22:00-08:00"
