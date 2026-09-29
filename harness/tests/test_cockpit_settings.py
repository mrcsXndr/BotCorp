"""v0.8.1: the cockpit Settings sheet's routes.

A real cockpit on a loopback port over a temp BOTCORP_HOME / BOTCORP_BOTS_DIR:
- GET /api/bots/:name/config returns the effective config (defaults merged,
  harness.modules included) and the paths bot.yaml sets itself;
- POST /api/bots/:name/config {path, value} runs `config set`: a non-widening
  value applies (bot.yaml changes), a widening one queues with the cockpit's
  identity as requested_by and shows in GET /api/approvals, and approving it
  through the approvals route applies it; shape errors are 400 before the
  approval-token gate, a CLI refusal is 400 with its reason;
- GET /api/cockpit returns the version, the Claude Code pin and the exposure.
"""
from __future__ import annotations

import pytest

from test_cockpit_api import Cockpit, _audit, needs_win_node
from test_operator_only import make_bot, operator_env


@pytest.fixture
def scockpit(tmp_path):
    rt, bots = tmp_path / "rt", tmp_path / "bots"
    (rt / "state").mkdir(parents=True)
    make_bot(bots, "t", "name: t\npermissions: default\nharness:\n  service: manual\n")
    env = operator_env(rt, bots)
    c = Cockpit(env)
    try:
        yield c, rt, bots, env
    finally:
        c.close()


def _yaml(bots, bot):
    import yaml
    return yaml.safe_load((bots / bot / "bot.yaml").read_text(encoding="utf-8"))


@needs_win_node
def test_get_returns_the_effective_config_and_what_the_file_sets(scockpit):
    c, rt, bots, env = scockpit
    code, r = c.call("GET", "/api/bots/t/config")
    assert code == 200, r
    assert r["config"]["permissions"] == "default" and r["config"]["harness"]["modules"]["debrief"] is False
    assert set(r["set"]) == {"name", "permissions", "harness.service"}
    assert c.call("GET", "/api/bots/nope/config")[0] == 404


@needs_win_node
def test_post_applies_a_plain_value_and_refuses_bad_ones(scockpit):
    c, rt, bots, env = scockpit
    url = "/api/bots/t/config"
    assert c.call("POST", url, {"path": "harness.modules.debrief", "value": ["x"]}, token=True)[0] == 400
    assert c.call("POST", url, {"path": "Bad Path", "value": True}, token=True)[0] == 400
    assert c.call("POST", url, {"path": "harness.modules.debrief", "value": True})[0] == 403
    assert "debrief" not in (_yaml(bots, "t").get("harness") or {}).get("modules", {})

    code, r = c.call("POST", url, {"path": "harness.modules.debrief", "value": True}, token=True)
    assert code == 200 and r["applied"] and r["queued"] is None, r
    assert _yaml(bots, "t")["harness"]["modules"]["debrief"] is True
    # the CLI's refusal comes back as 400 with its reason, and nothing is written
    code, r = c.call("POST", url, {"path": "harness.no_such_key", "value": 1}, token=True)
    assert code == 400 and "unknown path" in (r.get("err") or r.get("error") or ""), r
    code, r = c.call("POST", url, {"path": "harness.session", "value": "tmux"}, token=True)
    assert code == 400 and "harness.session" in (r.get("err") or r.get("error") or ""), r
    assert "session" not in _yaml(bots, "t")["harness"]
    audit = [a for a in _audit(rt, 6) if a["path"] == url]
    assert audit[-1]["config"] == "harness.session" and "value" not in audit[-1]


@needs_win_node
def test_a_widening_value_queues_and_is_decided_on_the_same_page(scockpit):
    c, rt, bots, env = scockpit
    code, r = c.call("POST", "/api/bots/t/config", {"path": "permissions", "value": "bypass"}, token=True)
    assert code == 200 and r["ok"] and not r["applied"] and r["queued"], r
    assert _yaml(bots, "t")["permissions"] == "default"
    code, a = c.call("GET", "/api/approvals")
    entry = next(p for p in a["pending"] if p["bot"] == "t" and p["id"] == r["queued"])
    assert entry["path"] == "permissions" and entry["requested_by"] == "local", entry
    # the same widening value again is a duplicate, not a second entry
    code, r2 = c.call("POST", "/api/bots/t/config", {"path": "permissions", "value": "bypass"}, token=True)
    assert code == 200 and r2["duplicate"], r2
    code, d = c.call("POST", f"/api/bots/t/approvals/{r['queued']}/approve", None, token=True)
    assert code == 200 and d["ok"], d
    assert _yaml(bots, "t")["permissions"] == "bypass"
    assert not [p for p in c.call("GET", "/api/approvals")[1]["pending"] if p["bot"] == "t"]


@needs_win_node
def test_host_section(scockpit):
    c, rt, bots, env = scockpit
    code, h = c.call("GET", "/api/cockpit")
    assert code == 200, h
    assert h["version"] and h["exposure"] == "loopback"
    assert set(h["cc"]) == {"pinned", "candidate"}
