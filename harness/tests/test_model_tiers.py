"""v0.8.5 step 14c: model tiers in bot.yaml.

Locked behaviour (daemon/botyaml.mjs, daemon/sync.mjs, cockpit/server.mjs):
- `model` is a tier from harness/models.json (top | workhorse | tiny | hyper)
  or an explicit model id; anything else is a validation error;
- the default is `top`, and sync writes the tier's id (top -> claude-opus-5-5)
  and, when bot.yaml sets no `effort`, the tier's effort (none for tiny: the
  key is left out); an explicit id with no effort keeps high;
- a tier resolves before the context window is computed (tiny = 200k);
- GET /api/models lists the tiers that are not opt-in, by name.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from test_cockpit_api import Cockpit, needs_win_node
from test_operator_only import make_bot, operator_env

ASSEMBLY = Path(__file__).resolve().parents[2]
BOTYAML = ASSEMBLY / "daemon" / "botyaml.mjs"
SYNC = ASSEMBLY / "daemon" / "sync.mjs"
TIERS = json.loads((ASSEMBLY / "harness" / "models.json").read_text(encoding="utf-8"))["tiers"]

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node not on PATH")


def _node(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["node", *args], capture_output=True, text=True, timeout=60)


def _effective(tmp_path: Path, text: str) -> dict:
    f = tmp_path / "x" / "bot.yaml"
    f.parent.mkdir(exist_ok=True)
    f.write_text(text, encoding="utf-8")
    r = _node(str(BOTYAML), str(f))
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def _settings(tmp_path: Path, yaml_text: str) -> dict:
    root = tmp_path / "root"
    if not (root / "templates").exists():
        shutil.copytree(ASSEMBLY / "templates", root / "templates")
    home = root / "bots" / "mt"
    home.mkdir(parents=True, exist_ok=True)
    (home / "bot.yaml").write_text(yaml_text, encoding="utf-8")
    r = _node(str(SYNC), "mt", "--botcorp", str(root))
    assert r.returncode == 0, r.stdout + r.stderr
    return json.loads((home / ".claude" / "settings.json").read_text(encoding="utf-8"))


def test_the_default_is_top_and_resolves_to_opus_5_5(tmp_path):
    cfg = _effective(tmp_path, "name: mt\n")
    assert cfg["model"] == "top" and cfg["effort"] is None and cfg["_errors"] == []
    s = _settings(tmp_path, "name: mt\n")
    assert s["model"] == "claude-opus-5-5" == TIERS["top"]["id"]
    assert s["effortLevel"] == "high"


@pytest.mark.parametrize("tier", ["top", "workhorse", "tiny", "hyper"])
def test_every_tier_validates_and_syncs_to_its_id_and_effort(tmp_path, tier):
    assert _effective(tmp_path, f"name: mt\nmodel: {tier}\n")["_errors"] == []
    s = _settings(tmp_path, f"name: mt\nmodel: {tier}\n")
    assert s["model"] == TIERS[tier]["id"]
    if TIERS[tier]["effort"] is None:
        assert "effortLevel" not in s
    else:
        assert s["effortLevel"] == TIERS[tier]["effort"]


def test_an_explicit_id_passes_and_an_explicit_effort_wins(tmp_path):
    for model in ("claude-sonnet-5-5", "claude-opus-5-5[1m]", "claude-haiku-4-5-20251001", "opus"):
        assert _effective(tmp_path, f"name: mt\nmodel: {model}\n")["_errors"] == [], model
    s = _settings(tmp_path, "name: mt\nmodel: claude-sonnet-5-5\n")
    assert (s["model"], s["effortLevel"]) == ("claude-sonnet-5-5", "high")
    s = _settings(tmp_path, "name: mt\nmodel: workhorse\neffort: xhigh\n")
    assert (s["model"], s["effortLevel"]) == (TIERS["workhorse"]["id"], "xhigh")


@pytest.mark.parametrize("model", ["foo", "Top", "", "gpt-5", 5])
def test_anything_else_is_refused(tmp_path, model):
    errs = _effective(tmp_path, f"name: mt\nmodel: {json.dumps(model)}\n")["_errors"]
    assert any(e.startswith("model:") for e in errs), errs


def test_a_tier_resolves_before_the_context_window(tmp_path):
    cfg = _effective(tmp_path, "name: mt\nmodel: tiny\n")
    assert cfg["_context_window"] == 140000   # 70% of Haiku's 200k, not of 1M
    assert _effective(tmp_path, "name: mt\n")["_context_window"] == 700000


@needs_win_node
def test_api_models_lists_the_tiers_that_are_not_opt_in(tmp_path):
    rt, bots = tmp_path / "rt", tmp_path / "bots"
    (rt / "state").mkdir(parents=True)
    make_bot(bots, "t")
    c = Cockpit(operator_env(rt, bots))
    try:
        code, body = c.call("GET", "/api/models")
    finally:
        c.close()
    assert code == 200
    want = [{"tier": k, "id": t["id"], "name": t["name"], "effort": t["effort"]} for k, t in TIERS.items() if not t.get("opt_in")]
    assert body == want and "hyper" not in [m["tier"] for m in body]
