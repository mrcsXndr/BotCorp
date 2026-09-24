"""usage_monitor.resume_check: the full decision table.

test_v2_usage_monitor_hooks.py covers the hook-fed record-block/record-
notification entry points plus the RESUME case end to end; this file drives
resume_check() directly across its other branches (WAIT / SELF-RESUMED /
STALE) so the whole decision table has a test, not just the payoff case.

Runs on temp state + a stubbed transcript clock; never sends a real Telegram
message and never touches the real state file or resume-prompt file.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

import usage_monitor as um


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(um, "STATE", str(tmp_path / "usage_limit_state.json"))
    monkeypatch.setattr(um, "RESUME_FILE", str(tmp_path / ".botcorp_resume_prompt"))
    sent = []
    monkeypatch.setattr(um, "send_resume_tg", lambda reset: sent.append(reset))
    return {"sent": sent}


def _state(blocked_until: datetime) -> dict:
    return {
        "last_alerted_reset": "7:10pm",
        "last_alerted_window": "7:10pm|2026-08-21T17:04",
        "blocked_until": blocked_until.isoformat(),
    }


def test_resume_check_waits_while_still_blocked(isolated, monkeypatch):
    future = datetime.now(timezone.utc).astimezone() + timedelta(minutes=30)
    monkeypatch.setattr(um, "newest_transcript_mtime", lambda: None)
    rc = um.resume_check(_state(future), dry=False)
    assert rc == 0
    assert not isolated["sent"]


def test_resume_check_stands_down_when_session_self_resumed(isolated, monkeypatch):
    # Reset has passed AND a transcript was written after it - a human already
    # got the session going by hand. Must consume the window, not relaunch.
    past = datetime.now(timezone.utc).astimezone() - timedelta(minutes=5)
    monkeypatch.setattr(um, "newest_transcript_mtime", lambda: datetime.now(timezone.utc).astimezone())
    st = _state(past)
    rc = um.resume_check(st, dry=False)
    assert rc == 0
    assert not isolated["sent"], "self-resumed case must not relaunch nor send a resume TG"
    assert st.get("resume_skipped") == "self-resumed"


def test_resume_check_declines_a_stale_window(isolated, monkeypatch):
    # Long past the reset with a dark session: too stale to trust a relaunch
    # (session-lifecycle.md: when unsure, don't roll).
    old = datetime.now(timezone.utc).astimezone() - timedelta(minutes=um.RESUME_MAX_LATE_MIN + 30)
    monkeypatch.setattr(um, "newest_transcript_mtime", lambda: None)
    st = _state(old)
    rc = um.resume_check(st, dry=False)
    assert rc == 0
    assert not isolated["sent"]
    assert "stale" in str(st.get("resume_skipped", ""))


def test_resume_check_resumes_once_the_recorded_window_has_passed(isolated, monkeypatch):
    past = datetime.now(timezone.utc).astimezone() - timedelta(minutes=5)
    monkeypatch.setattr(um, "newest_transcript_mtime", lambda: past - timedelta(hours=2))
    st = _state(past)
    rc = um.resume_check(st, dry=False)
    assert rc == 10
    assert isolated["sent"] == ["7:10pm"]


def test_resume_check_already_resumed_window_is_a_no_op(isolated, monkeypatch):
    past = datetime.now(timezone.utc).astimezone() - timedelta(minutes=5)
    st = _state(past)
    st["resumed_for"] = st["last_alerted_window"]
    monkeypatch.setattr(um, "newest_transcript_mtime", lambda: None)
    rc = um.resume_check(st, dry=False)
    assert rc == 0
    assert not isolated["sent"]


def test_dry_run_never_writes_or_sends(isolated, monkeypatch, tmp_path):
    past = datetime.now(timezone.utc).astimezone() - timedelta(minutes=5)
    monkeypatch.setattr(um, "newest_transcript_mtime", lambda: past - timedelta(hours=2))
    rc = um.resume_check(_state(past), dry=True)
    assert rc == 0
    assert not isolated["sent"]
    assert not (tmp_path / ".botcorp_resume_prompt").exists()
