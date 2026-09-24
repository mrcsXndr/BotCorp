"""A card the Director moves itself must not TG-alert the Director.

The supervisor polls the board each tick and alerts on every card that entered
Ready. That is correct for a card the operator drags on their phone, and pure
noise for one the bot just moved.

Runs on a temp snapshot; never touches the live gh_project.snapshot.json.
"""
from __future__ import annotations

import json

import pytest

import gh_projects as g


@pytest.fixture
def snap(tmp_path, monkeypatch):
    path = tmp_path / "gh_project.snapshot.json"
    monkeypatch.setattr(g, "SNAP_PATH", path)
    return path


def classify(prev_rows, cur_rows):
    """The exact kind[] poll() would emit for these two states."""
    prev = {x["id"]: x for x in prev_rows}
    out = []
    for i in cur_rows:
        o = prev.get(i["id"])
        if not o:
            out.append("added")
        elif o.get("status") != i.get("status"):
            out.append("queued" if (i.get("status") or "").lower() in ("ready", "do asap", "asap") else "moved")
    return out


CARD = {"id": "PVTI_test", "title": "a card", "status": "Backlog"}
LIVE = [{**CARD, "status": "Ready"}]


def test_un_acked_move_would_alert():
    # Baseline: without the ack, this is exactly the alert the operator received.
    assert classify([CARD], LIVE) == ["queued"]


def test_acked_move_is_silent(snap):
    snap.write_text(json.dumps([dict(CARD)]), encoding="utf-8")
    g.snapshot_ack("PVTI_test", "Ready")
    rows = json.loads(snap.read_text(encoding="utf-8"))
    assert rows[0]["status"] == "Ready"
    assert classify(rows, LIVE) == []


def test_someone_elses_move_still_alerts(snap):
    # A move the operator makes must still alert — the ack is narrow on purpose.
    snap.write_text(json.dumps([dict(CARD)]), encoding="utf-8")
    g.snapshot_ack("PVTI_test", "Ready")
    acked = json.loads(snap.read_text(encoding="utf-8"))
    other_live = [{**CARD, "status": "Ready"}, {"id": "PVTI_his", "title": "his card", "status": "Ready"}]
    snap_with_his = acked + [{"id": "PVTI_his", "title": "his card", "status": "Backlog"}]
    assert classify(snap_with_his, other_live) == ["queued"]


def test_unknown_id_does_not_mutate_the_snapshot(snap):
    snap.write_text(json.dumps([dict(CARD)]), encoding="utf-8")
    before = snap.read_text(encoding="utf-8")
    g.snapshot_ack("PVTI_not_in_snapshot", "Ready")
    assert snap.read_text(encoding="utf-8") == before


def test_missing_snapshot_is_a_safe_no_op(snap):
    # Missing snapshot must not raise — board writes come first.
    assert not snap.exists()
    g.snapshot_ack("PVTI_test", "Ready")  # must not raise
