"""v0.9.9: the cockpit routes for knowledge, models, helpers, agents and descriptions.

A real cockpit over fixture bots and a temp BOTCORP_HOME / BOTCORP_BOTS_DIR:
- knowledge: GET lists and reads; PUT / DELETE, global or a bot's, are refused
  (403) without the operator and applied with the approval token; a stale
  ifMatch is 409; a global doc lands in every bot's config home rules/;
- /api/models is {cc_version, tiers, models}; with this box's Claude Code pin
  the live list has at least 4 models, haiku without ultracode;
- /api/bots/<bot>/helpers says what auto-fix and the debrief do;
- /api/agents answers for the running bots only; an automation passes its
  description through.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from test_cockpit_api import Cockpit
from test_operator_only import make_bot, needs_node, operator_env

YAML = ("name: t\nharness:\n  service: manual\n  modules:\n    alert_triage: true\n"
        "automations:\n  - name: job\n    command: echo hi\n    trigger: { interval_min: 60 }\n    description: Says hi hourly\n")


@pytest.fixture
def v099(tmp_path):
    rt, bots = tmp_path / "rt", tmp_path / "bots"
    (rt / "state").mkdir(parents=True)
    make_bot(bots, "t", YAML)
    make_bot(bots, "u")
    pin = Path(os.path.expanduser("~")) / ".botcorp" / "state" / "cc.json"
    live = None
    try:
        live = json.loads(pin.read_text(encoding="utf-8")).get("pinned")
    except Exception:
        pass
    if live and Path(str(live.get("exe", ""))).is_file():
        (rt / "state" / "cc.json").write_text(json.dumps({"pinned": live}), encoding="utf-8")
    else:
        live = None
    c = Cockpit(operator_env(rt, bots))
    try:
        yield c, rt, bots, live
    finally:
        c.close()


@needs_node
def test_v099_knowledge_needs_the_operator(v099):
    c, rt, bots, _ = v099
    assert c.call("PUT", "/api/knowledge/house", {"content": "# House\n"})[0] == 403
    assert c.call("PUT", "/api/bots/t/knowledge/style", {"content": "# Style\n"})[0] == 403
    assert not (rt / "global" / "knowledge" / "house.md").exists()
    code, r = c.call("PUT", "/api/knowledge/house", {"content": "# House\n"}, token=True)
    assert code == 200 and r["ok"] and r["created"], r
    for b in ("t", "u"):
        assert (bots / b / f".claude-{b}" / "rules" / "botcorp-global-house.md").is_file()
    code, lst = c.call("GET", "/api/knowledge")
    assert code == 200 and [d["id"] for d in lst["docs"]] == ["house"]
    assert c.call("DELETE", "/api/knowledge/house")[0] == 403
    assert c.call("DELETE", "/api/knowledge/house", token=True)[0] == 200
    assert not (bots / "t" / ".claude-t" / "rules" / "botcorp-global-house.md").exists()


@needs_node
def test_v099_bot_knowledge_and_if_match(v099):
    c, rt, bots, _ = v099
    (bots / "t" / "CLAUDE.md").write_bytes(b"# t\n")
    code, doc = c.call("GET", "/api/bots/t/knowledge/CLAUDE")
    assert code == 200 and doc["content"] == "# t\n"
    (bots / "t" / "CLAUDE.md").write_bytes(b"# t, edited by the bot\n")
    code, r = c.call("PUT", "/api/bots/t/knowledge/CLAUDE", {"content": "# mine\n", "ifMatch": doc["sha256"]}, token=True)
    assert code == 409, r
    assert "edited by the bot" in (bots / "t" / "CLAUDE.md").read_text(encoding="utf-8")
    code, r = c.call("PUT", "/api/bots/t/knowledge/style", {"content": "# Style\n"}, token=True)
    assert code == 200, r
    code, lst = c.call("GET", "/api/bots/t/knowledge")
    assert [d["id"] for d in lst["docs"]] == ["CLAUDE", "style"]
    assert c.call("PUT", "/api/bots/t/knowledge/..%2Fx", {"content": "x"}, token=True)[0] in (400, 404)
    assert c.call("GET", "/api/bots/t/knowledge/nope")[0] == 404


@needs_node
def test_v099_models_helpers_agents_descriptions(v099):
    c, rt, bots, live = v099
    code, m = c.call("GET", "/api/models")
    assert code == 200 and {"cc_version", "tiers", "models"} <= set(m), m
    assert any(t["tier"] == "top" for t in m["tiers"])
    if live:
        assert len(m["models"]) >= 4 and m["cc_version"] == live["version"], m.get("error")
        haiku = [x for x in m["models"] if x["value"] == "haiku"]
        assert haiku and haiku[0]["ultracodeAvailable"] is False
    else:
        assert m["models"] == [] and m["error"]
    code, h = c.call("GET", "/api/bots/t/helpers")
    assert code == 200 and h["autoFix"]["on"] is True and h["autoFix"]["fed"] is False and h["debrief"]["writes"] == "context/session-log.md"
    code, a = c.call("GET", "/api/agents")
    assert code == 200 and a == []   # no bot is running
    code, au = c.call("GET", "/api/bots/t/automations")
    assert code == 200 and au["declared"][0]["description"] == "Says hi hourly"
    assert c.call("GET", "/api/bots/t/agents/abc123")[0] == 404
