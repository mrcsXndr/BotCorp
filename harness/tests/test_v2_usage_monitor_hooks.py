"""tools/v2/usage_monitor.py: the two hook-fed subcommands.

record-block (fed by the StopFailure hook) must set blocked_until from the
error payload; record-notification (fed by the Notification hook) with a
`quota_auto_resume_fired` matcher_value must mark that window resumed so
--resume-check leaves it alone.

Every module-level path constant is monkeypatched into tmp_path and every
send is stubbed — no test here writes into a real bot's memory/ or sends a
real Telegram message (BOT_TG_MUTE=1 is also set by conftest's autouse
fixture, as a floor).
"""
from __future__ import annotations

import io
import json
from datetime import datetime, timedelta, timezone

import pytest

import usage_monitor as um


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    statef = tmp_path / "usage_limit_state.json"
    monkeypatch.setattr(um, "STATE", str(statef))
    monkeypatch.setattr(um, "RESUME_FILE", str(tmp_path / ".botcorp_resume_prompt"))
    sent = []
    monkeypatch.setattr(um, "send_tg", lambda reset, dry: (sent.append(reset), True)[1])
    monkeypatch.setattr(um, "send_resume_tg", lambda reset: sent.append(("resume", reset)))
    return {"state_file": statef, "sent": sent}


def _feed_stdin(monkeypatch, payload: dict) -> None:
    monkeypatch.setattr(um.sys, "stdin", io.StringIO(json.dumps(payload)))


def test_record_block_sets_blocked_until_from_message(isolated, monkeypatch):
    _feed_stdin(monkeypatch, {"error_code": "rate_limit",
                              "message": "You've hit your usage limit - resets 7:10pm (Europe/Stockholm)"})
    rc = um.cmd_record_block(dry_run=False)
    assert rc == 0
    st = json.loads(isolated["state_file"].read_text(encoding="utf-8"))
    assert st.get("blocked_until")
    assert st["last_alerted_reset"].startswith("7:10pm")
    assert isolated["sent"] == ["7:10pm (Europe/Stockholm)"]


def test_record_block_without_reset_phrase_defaults_to_now_plus_5h(isolated, monkeypatch):
    _feed_stdin(monkeypatch, {"error_code": "rate_limit", "message": "quota exceeded, try later"})
    before = datetime.now(timezone.utc)
    rc = um.cmd_record_block(dry_run=False)
    assert rc == 0
    st = json.loads(isolated["state_file"].read_text(encoding="utf-8"))
    until = datetime.fromisoformat(st["blocked_until"])
    if until.tzinfo is None:
        until = until.astimezone()
    delta = until - before.astimezone()
    assert timedelta(hours=4, minutes=59) < delta < timedelta(hours=5, minutes=1)


def test_record_block_dedupes_against_an_already_announced_window(isolated, monkeypatch):
    _feed_stdin(monkeypatch, {"message": "resets 7:10pm (Europe/Stockholm)"})
    assert um.cmd_record_block(dry_run=False) == 0
    assert len(isolated["sent"]) == 1

    # A second StopFailure for the same window (~seconds later) must not
    # re-announce — this is the cross-tool/cross-hook dedupe limit_window.py
    # exists for.
    _feed_stdin(monkeypatch, {"message": "resets 7:10pm (Europe/Stockholm)"})
    assert um.cmd_record_block(dry_run=False) == 0
    assert len(isolated["sent"]) == 1, "duplicate block re-announced the same window"


def test_record_notification_fired_marks_window_resumed(isolated, monkeypatch):
    isolated["state_file"].write_text(json.dumps({
        "last_alerted_reset": "7:10pm (Europe/Stockholm)",
        "last_alerted_window": "7:10pm (Europe/Stockholm)|2026-09-24T17:04",
        "blocked_until": datetime.now(timezone.utc).isoformat(),
    }), encoding="utf-8")
    _feed_stdin(monkeypatch, {"matcher_value": "quota_auto_resume_fired"})
    rc = um.cmd_record_notification(dry_run=False)
    assert rc == 0
    st = json.loads(isolated["state_file"].read_text(encoding="utf-8"))
    assert st["resumed_for"] == "7:10pm (Europe/Stockholm)|2026-09-24T17:04"


def test_record_notification_stale_leaves_window_for_resume_check(isolated, monkeypatch):
    wid = "7:10pm (Europe/Stockholm)|2026-09-24T17:04"
    isolated["state_file"].write_text(json.dumps({
        "last_alerted_reset": "7:10pm (Europe/Stockholm)",
        "last_alerted_window": wid,
        "blocked_until": datetime.now(timezone.utc).isoformat(),
    }), encoding="utf-8")
    _feed_stdin(monkeypatch, {"matcher_value": "quota_auto_resume_stale"})
    rc = um.cmd_record_notification(dry_run=False)
    assert rc == 0
    st = json.loads(isolated["state_file"].read_text(encoding="utf-8"))
    assert "resumed_for" not in st


def test_resume_check_resumes_once_the_recorded_window_has_passed(isolated, monkeypatch):
    past = datetime.now(timezone.utc).astimezone() - timedelta(minutes=5)
    state = {
        "last_alerted_reset": "7:10pm",
        "last_alerted_window": "7:10pm|2026-09-24T17:04",
        "blocked_until": past.isoformat(),
    }
    monkeypatch.setattr(um, "newest_transcript_mtime", lambda: past - timedelta(hours=2))
    rc = um.resume_check(state, dry=False)
    assert rc == 10
    assert any(x[0] == "resume" for x in isolated["sent"])
