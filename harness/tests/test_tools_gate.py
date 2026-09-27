"""R5c step 20: the clean-day record and `tools <bot> gate`.

Every `tools <bot> scan` upserts <rt>/state/<bot>.registry-days.json (worst of
the day, skipped when `tools:` is absent). `gate` counts consecutive clean days
ending today (a day not yet scanned today is not a gap); a dirty or missing day
breaks the streak. `botcorp new` starts a bot with an empty, enforced registry.
The daily tick scan fires only for a bot with a `tools:` list.
"""
from __future__ import annotations

import json
from datetime import date, timedelta

import pytest

from test_cc_gate import _sha, _tick_dry, needs_pwsh, tick_box  # noqa: F401 (tick_box is a fixture)
from test_operator_only import box, cli, needs_node  # noqa: F401

CLEAN = {"scans": 2, "worst": {"unregistered": 0, "missing": 0, "automation_unregistered": 0, "underclassified": 0}}


def _seed(rt, days: dict) -> None:
    (rt / "state" / "t.registry-days.json").write_text(json.dumps(days), encoding="utf-8")


def _week(dirty_day: int | None = None, gap_day: int | None = None) -> dict:
    """Days 1..7, day 7 = today."""
    out = {}
    for i in range(1, 8):
        if i == gap_day:
            continue
        row = json.loads(json.dumps(CLEAN))
        if i == dirty_day:
            row["worst"]["unregistered"] = 1
        out[(date.today() - timedelta(days=7 - i)).isoformat()] = row
    return out


@needs_node
def test_seven_clean_days_pass_the_gate(box):
    rt, bots, env = box
    _seed(rt, _week())
    r = cli(env, "tools", "t", "gate")
    assert r.returncode == 0 and "clean 7/7 consecutive days" in r.stdout, r.stdout + r.stderr


@needs_node
def test_a_dirty_day_breaks_the_streak(box):
    rt, bots, env = box
    _seed(rt, _week(dirty_day=4))
    r = cli(env, "tools", "t", "gate")
    assert r.returncode == 1 and "clean 3/7 consecutive days" in r.stdout, r.stdout + r.stderr
    d = json.loads(cli(env, "tools", "t", "gate", "--days", "3", "--json").stdout)
    assert d == {"bot": "t", "days": 3, "clean": 3, "ready": True}


@needs_node
def test_a_missing_day_breaks_the_streak(box):
    rt, bots, env = box
    _seed(rt, _week(gap_day=5))
    r = cli(env, "tools", "t", "gate")
    assert r.returncode == 1 and "clean 2/7" in r.stdout, r.stdout


@needs_node
def test_today_not_yet_scanned_is_not_a_gap(box):
    rt, bots, env = box
    week = _week()
    week.pop(date.today().isoformat())
    _seed(rt, week)
    assert "clean 6/7" in cli(env, "tools", "t", "gate").stdout


@needs_node
def test_scan_records_worst_of_day_only_with_a_registry(box):
    rt, bots, env = box
    f = rt / "state" / "t.registry-days.json"
    assert cli(env, "tools", "t", "scan", "--json").returncode == 0
    assert not f.exists()                                    # (f) no tools: list, no record
    home = bots / "t"
    (home / "bot.yaml").write_text("name: t\nharness:\n  service: manual\ntools: []\n", encoding="utf-8")
    (home / "tools").mkdir()
    (home / "tools" / "a.py").write_text("print(1)\n", encoding="utf-8")
    assert cli(env, "tools", "t", "scan", "--json").returncode == 0
    (home / "tools" / "a.py").unlink()
    assert cli(env, "tools", "t", "scan", "--json").returncode == 0
    row = json.loads(f.read_text(encoding="utf-8"))[date.today().isoformat()]
    assert row["scans"] == 2 and row["worst"]["unregistered"] == 1   # the clean second scan does not wash the day


@needs_node
def test_new_writes_an_empty_enforced_registry(box):
    rt, bots, env = box
    r = cli(env, "new", "--name", "tmpbot", "--yes", "--no-launch", "--no-modules", "telegram")
    assert r.returncode == 0, r.stdout + r.stderr
    text = (bots / "tmpbot" / "bot.yaml").read_text(encoding="utf-8")
    assert "tools: []" in text and "tools_registry: enforce" in text, text
    d = json.loads(cli(env, "tools", "tmpbot", "scan", "--json").stdout)
    assert d["registry"] == "enforce" and d["unregistered"] == []


def _alive_on_pin(t: dict, tools: bool) -> None:
    rt, home = t["rt"], t["home"]
    cc = json.loads((rt / "state" / "cc.json").read_text(encoding="utf-8"))
    cc["pinned"].update(exe=str(t["old"]), sha256=_sha(t["old"]), version="2.1.282")
    (rt / "state" / "cc.json").write_text(json.dumps(cc), encoding="utf-8")
    if tools:
        (home / "bot.yaml").write_text((home / "bot.yaml").read_text(encoding="utf-8") + "tools: []\n", encoding="utf-8")


@needs_pwsh
@pytest.mark.parametrize("tools", [True, False])
def test_tick_scans_daily_only_a_registry_bot(tick_box, tools):
    _alive_on_pin(tick_box, tools)
    log = _tick_dry(tick_box)
    assert "state: alive=True" in log, log[-3000:]
    assert ("DRYRUN would run the daily tools registry scan" in log) == tools, log[-3000:]
