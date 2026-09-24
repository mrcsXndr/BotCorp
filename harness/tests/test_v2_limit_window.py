"""Tests for the cross-tool limit dedupe (`limit_window.already_announced`).

The bug this guards: two tools can both alert on the same usage-limit block
and both write the shared state file, but if their dedupe keys can never be
equal, each only ever deduped against ITSELF — one block, two differently
worded Telegram messages minutes apart. The operator's complaint at the time:
"ONCE IS ENOUGH AND THEN WAIT."

Both failure directions are live here and they pull against each other:

  * too loose and the duplicate is back;
  * too tight and a dedupe key becomes a permanent mute — swallowing a whole
    block with no alert AND no auto-resume.

So the load-bearing cases are the ORDER-INDEPENDENCE pair and the
must-still-fire cases.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import limit_window as lw

NOW = datetime(2026, 8, 21, 19, 4, tzinfo=timezone(timedelta(hours=2)))
RESET = NOW + timedelta(minutes=6)  # 19:10


def monitor_state(until=RESET):
    """What usage_monitor.py writes: key is `<reset text>|<hit minute>`."""
    return {
        "last_alerted_reset": "7:10pm (Europe/Stockholm)",
        "last_alerted_window": "7:10pm (Europe/Stockholm)|2026-08-21T17:04",
        "last_alerted_at": NOW.isoformat(),
        "blocked_until": until.isoformat(),
        "source": "usage_monitor",
    }


def probe_state(until=RESET):
    """What a second tool observing the same block via a different signal
    would write: key is `probe|<epoch>`."""
    return {
        "last_alerted_reset": until.strftime("%H:%M (%Z)"),
        "last_alerted_window": f"probe|{int(until.timestamp())}",
        "last_alerted_at": NOW.isoformat(),
        "blocked_until": until.isoformat(),
        "source": "probe",
    }


def test_empty_state_announces():
    assert not lw.already_announced({}, RESET)


def test_state_without_last_alerted_window_announces():
    assert not lw.already_announced({"resumed_at": NOW.isoformat()}, RESET)


def test_a_new_window_hours_later_still_announces():
    # THE MUTE GUARD. A genuinely new block hours later must alert even though
    # a previous one is on record.
    later = RESET + timedelta(hours=5)
    assert not lw.already_announced(monitor_state(), later)


def test_a_window_already_resumed_past_does_not_suppress_the_next():
    later = RESET + timedelta(hours=5)
    resumed = probe_state()
    resumed["resumed_for"] = resumed["last_alerted_window"]
    assert not lw.already_announced(resumed, later)


def test_order_a_second_tool_silent_after_the_monitor_announced():
    # The exact epoch lands seconds off the monitor's minute-rounded banner
    # parse, which is why this is a tolerance and not an equality.
    probe_sees = RESET + timedelta(seconds=37)
    assert lw.already_announced(monitor_state(), probe_sees)


def test_order_b_monitor_silent_after_the_other_tool_announced():
    # Order genuinely varies, so both directions have to hold.
    monitor_sees = RESET - timedelta(seconds=37)
    assert lw.already_announced(probe_state(), monitor_sees)


def test_second_tick_of_the_same_tool_stays_quiet():
    assert lw.already_announced(probe_state(), RESET)


def test_tolerance_boundary_inside_is_same_block():
    assert lw.already_announced(monitor_state(), RESET + timedelta(minutes=lw.TOLERANCE_MIN - 1))


def test_tolerance_boundary_outside_is_different_block():
    assert not lw.already_announced(monitor_state(), RESET + timedelta(minutes=lw.TOLERANCE_MIN + 5))


def test_fail_open_on_bad_input():
    # The failure mode of a crash here would be a MISSED alert and a missed
    # auto-resume — strictly worse than a duplicate. Every malformed input
    # must resolve to "not announced" rather than raise.
    cases = [
        ("non-dict state", "nonsense", RESET),
        ("unparseable blocked_until", {**monitor_state(), "blocked_until": "soon-ish"}, RESET),
        ("null blocked_until", {**monitor_state(), "blocked_until": None}, RESET),
        ("naive-vs-aware mismatch", monitor_state(), RESET.replace(tzinfo=None)),
        ("None candidate", monitor_state(), None),
    ]
    for label, st, until in cases:
        got = lw.already_announced(st, until)
        assert got is False, f"{label}: expected fail-open False, got {got!r}"


def test_announce_text_one_wording_for_one_event():
    a = lw.announce_text("7:10pm (Europe/Stockholm)")
    b = lw.announce_text("19:10", "5h: 100%")
    assert "7:10pm" in a
    assert "Auto-resume is armed" in a
    assert b.startswith(lw.announce_text("19:10")) and b.endswith("5h: 100%")
