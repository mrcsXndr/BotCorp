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


def test_record_block_stamps_state_even_when_the_send_fails(isolated, monkeypatch):
    """A blocked session's tg_send.py can fail (the limit blocks it too, or the
    backlog gate refuses); --resume-check still needs blocked_until."""
    monkeypatch.setattr(um, "send_tg", lambda reset, dry: False)
    _feed_stdin(monkeypatch, {"error_code": "rate_limit", "detail": "You've hit your session limit · resets 7:10pm (Europe/Stockholm)"})
    assert um.cmd_record_block(dry_run=False) == 0
    st = json.loads(isolated["state_file"].read_text(encoding="utf-8"))
    assert st.get("blocked_until") and st["last_alerted_reset"].startswith("7:10pm")


def test_record_block_dry_run_stamps_nothing(isolated, monkeypatch):
    _feed_stdin(monkeypatch, {"message": "resets 7:10pm (Europe/Stockholm)"})
    assert um.cmd_record_block(dry_run=True) == 0
    assert not isolated["state_file"].exists()


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


# The StopFailure payload Claude Code 2.1.284 builds (common hook fields +
# error / error_details / last_assistant_message). `error` is a STRING; the old
# handler did `(payload.get("error") or {}).get("message")` and crashed on it.
_API_BODY = ('429 {"type":"error","error":{"type":"rate_limit_error","message":'
             '"This request would exceed your account\'s rate limit. Please try again later."},'
             '"request_id":"req_x"}')


def _real_payload(text: str, *, agent: bool = False, details: str | None = None) -> dict:
    p = {"session_id": "s1", "transcript_path": "t.jsonl", "cwd": "C:/bots/x",
         "permission_mode": "bypassPermissions", "hook_event_name": "StopFailure",
         "error": "rate_limit", "last_assistant_message": text}
    if details is not None:
        p["error_details"] = details
    if agent:
        p.update(agent_id="a1", agent_type="coder")
    return p


def test_record_block_real_session_limit_payload_with_string_error(isolated, monkeypatch):
    _feed_stdin(monkeypatch, _real_payload(
        "You've hit your session limit · resets 6:30am (Europe/Stockholm)"))
    assert um.cmd_record_block(dry_run=False) == 0
    st = json.loads(isolated["state_file"].read_text(encoding="utf-8"))
    assert st["last_alerted_reset"] == "6:30am (Europe/Stockholm)"
    assert st["blocked_until"] and st["source"] == "usage_monitor"
    assert isolated["sent"] == ["6:30am (Europe/Stockholm)"]


def test_record_block_one_model_limit_is_not_a_usage_block(isolated, monkeypatch):
    """Three real StopFailures (09-27, 09-28, 09-29) were a subagent
    reaching its Fable limit. The session went on; nothing to wait out."""
    _feed_stdin(monkeypatch, _real_payload(
        "You've reached your Fable limit. /model to switch models.", agent=True, details=_API_BODY))
    assert um.cmd_record_block(dry_run=False) == 0
    assert not isolated["state_file"].exists()
    assert isolated["sent"] == []


def test_record_block_still_reads_a_dict_error(isolated, monkeypatch):
    _feed_stdin(monkeypatch, {"error": {"type": "rate_limit",
                                        "message": "limit hit - resets 7:10pm (Europe/Stockholm)"}})
    assert um.cmd_record_block(dry_run=False) == 0
    st = json.loads(isolated["state_file"].read_text(encoding="utf-8"))
    assert st["last_alerted_reset"].startswith("7:10pm")


def test_record_block_string_error_without_text_defaults_to_5h(isolated, monkeypatch):
    _feed_stdin(monkeypatch, {"hook_event_name": "StopFailure", "error": "rate_limit",
                              "error_details": _API_BODY})
    assert um.cmd_record_block(dry_run=False) == 0
    assert json.loads(isolated["state_file"].read_text(encoding="utf-8")).get("blocked_until")


# --- banner fallback ----------------------------------------------------------

def _clock(dt: datetime) -> str:
    h = dt.hour % 12 or 12
    return f"{h}:{dt.minute:02d}{'am' if dt.hour < 12 else 'pm'} (Europe/Stockholm)"


def _banner_line(ts: datetime, text: str) -> str:
    # The entry CC writes for a limit (a real main session, 2026-09-29 01:37Z).
    return json.dumps({
        "type": "assistant", "isApiErrorMessage": True, "error": "rate_limit",
        "timestamp": ts.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "message": {"model": "<synthetic>", "role": "assistant", "type": "message",
                    "content": [{"type": "text", "text": text}]},
    })


@pytest.fixture
def transcripts(tmp_path, monkeypatch):
    d = tmp_path / "projects"
    d.mkdir()
    monkeypatch.setattr(um, "TRANSCRIPT_DIR", str(d))
    return d


def test_banner_scan_stamps_a_window_the_hook_missed(isolated, transcripts, monkeypatch):
    now = datetime.now(timezone.utc).astimezone()
    reset = _clock(now + timedelta(hours=2))
    (transcripts / "s1.jsonl").write_text(
        '{"type":"user"}\n' + _banner_line(now - timedelta(minutes=10),
                                          f"You've hit your session limit · resets {reset}") + "\n",
        encoding="utf-8")
    monkeypatch.setattr(um, "newest_transcript_mtime", lambda: now - timedelta(minutes=10))
    state = um.load_state()
    assert um.scan_banner(state, dry_run=False) is True
    st = json.loads(isolated["state_file"].read_text(encoding="utf-8"))
    assert st["source"] == "banner" and st["last_alerted_reset"] == reset
    assert isolated["sent"] == [reset]
    assert um.resume_check(st, dry=False) == 0  # WAIT: the window is ahead
    # The next tick sees the same banner and stays quiet.
    assert um.scan_banner(um.load_state(), dry_run=False) is False
    assert len(isolated["sent"]) == 1


def test_banner_scan_ignores_a_block_the_hook_already_recorded(isolated, transcripts, monkeypatch):
    now = datetime.now(timezone.utc).astimezone()
    reset = _clock(now + timedelta(hours=2))
    (transcripts / "s1.jsonl").write_text(
        _banner_line(now - timedelta(seconds=30), f"You've hit your session limit · resets {reset}") + "\n",
        encoding="utf-8")
    _feed_stdin(monkeypatch, _real_payload(f"You've hit your session limit · resets {reset}"))
    um.cmd_record_block(dry_run=False)
    assert um.scan_banner(um.load_state(), dry_run=False) is False
    assert isolated["sent"] == [reset]


def test_banner_scan_skips_passed_windows_and_one_model_limits(isolated, transcripts):
    now = datetime.now(timezone.utc).astimezone()
    (transcripts / "s1.jsonl").write_text(
        _banner_line(now - timedelta(hours=3), f"You've hit your session limit · resets {_clock(now - timedelta(hours=1))}") + "\n"
        + _banner_line(now - timedelta(minutes=5), "You've reached your Fable limit. /model to switch models.") + "\n",
        encoding="utf-8")
    assert um.scan_banner(um.load_state(), dry_run=False) is False
    assert not isolated["state_file"].exists() and isolated["sent"] == []


def test_resume_check_cli_runs_the_banner_scan(isolated, transcripts, monkeypatch, capsys):
    now = datetime.now(timezone.utc).astimezone()
    reset = _clock(now + timedelta(hours=1))
    (transcripts / "s1.jsonl").write_text(
        _banner_line(now - timedelta(minutes=2), f"You've hit your session limit · resets {reset}") + "\n",
        encoding="utf-8")
    monkeypatch.setattr(um.sys, "argv", ["usage_monitor.py", "--resume-check"])
    assert um.main() == 0
    assert capsys.readouterr().out.strip().startswith("WAIT")
    assert isolated["sent"] == [reset]


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
