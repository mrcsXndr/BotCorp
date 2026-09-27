"""tools/infra/hub_push.py: payload whitelist, size cap, no leaked strings,
and interval_s throttling.

bot.yaml is parsed via the ONE real parser (daemon/botyaml.mjs — node must be
on PATH; no mock there). Only urllib.request.urlopen / hub_push._post are
stubbed, so no test here ever reaches a real network.

No conftest.py assumed for the import itself — conftest only puts
tools/ and tools/v2/ on sys.path, not tools/infra/ — so this file adds that
directory locally, same pattern as test_tg_send_gate.py.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pytest

HARNESS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HARNESS / "tools"))
sys.path.insert(0, str(HARNESS / "tools" / "infra"))
import hub_push as hp  # noqa: E402

BOT_YAML = """
name: tmphub
integrations:
  hub:
    url: https://hub.example.test/api/ingest
    interval_s: 300
"""

# Same class of check the tool's own --dry-run leak scan uses.
LEAK_RE = re.compile(r"(token|C:\\\\|/Users/)", re.IGNORECASE)


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    bot_home = tmp_path / "bot_home"
    bot_home.mkdir()
    (bot_home / "bot.yaml").write_text(BOT_YAML, encoding="utf-8")
    monkeypatch.setenv("BOT_HOME", str(bot_home))
    monkeypatch.setenv("BOTCORP_HOME", str(tmp_path / "botcorp_home"))
    monkeypatch.setenv("BOT_NAME", "tmphub")
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude_config"))
    monkeypatch.setenv("BOT_MODULES", "cost_meter,hub")
    return bot_home


def test_bots_payload_only_has_whitelisted_keys_and_fits_cap(isolated):
    payload = hp.build_bots_payload()
    assert set(payload.keys()) == {"kind", "ts", "box", "bots"}
    assert payload["kind"] == "bots"
    assert len(payload["bots"]) == 1
    item = payload["bots"][0]
    assert set(item.keys()) <= hp.BOTS_ITEM_KEYS
    if "rate_limits" in item:
        assert set(item["rate_limits"].keys()) <= hp.RATE_LIMIT_KEYS

    body = json.dumps(payload)
    assert len(body) < 4096
    assert not LEAK_RE.search(body)


def test_activity_payload_only_has_whitelisted_keys_and_fits_cap(isolated):
    payload = hp.build_activity_payload()
    assert set(payload.keys()) == {"kind", "ts", "box", "bot", "items"}
    for item in payload["items"]:
        assert set(item.keys()) <= hp.ACTIVITY_ITEM_KEYS

    body = json.dumps(payload)
    assert len(body) < 4096
    assert not LEAK_RE.search(body)


def test_usage_payload_only_has_whitelisted_keys_and_fits_cap(isolated):
    payload = hp.build_usage_payload()
    assert payload["kind"] == "usage"
    assert set(payload.keys()) <= (hp.USAGE_KEYS | {"kind", "ts", "box"})

    body = json.dumps(payload)
    assert len(body) < 4096
    assert not LEAK_RE.search(body)


def test_main_dry_run_never_touches_the_network(isolated, monkeypatch, capsys):
    def _boom(*a, **k):
        raise AssertionError("dry-run must never touch the network")
    monkeypatch.setattr(hp.urllib.request, "urlopen", _boom)

    assert hp.main(["hub_push.py", "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert '"kind": "bots"' in out
    assert '"kind": "activity"' in out
    assert '"kind": "usage"' in out


def test_interval_throttling_skips_the_second_push(isolated, monkeypatch):
    posted = []

    def _fake_post(url, token, payload):
        posted.append(payload["kind"])
        return {}

    monkeypatch.setattr(hp, "_post", _fake_post)

    assert hp.main(["hub_push.py"]) == 0
    assert len(posted) == 3  # bots, activity, usage all pushed once

    assert hp.main(["hub_push.py"]) == 0
    assert len(posted) == 3, "second push within interval_s must be throttled"


def test_no_hub_url_configured_is_a_noop(tmp_path, monkeypatch):
    bot_home = tmp_path / "bot_home_nohub"
    bot_home.mkdir()
    (bot_home / "bot.yaml").write_text("name: nohubbot\n", encoding="utf-8")
    monkeypatch.setenv("BOT_HOME", str(bot_home))
    monkeypatch.setenv("BOTCORP_HOME", str(tmp_path / "botcorp_home_nohub"))
    monkeypatch.setenv("BOT_NAME", "nohubbot")
    monkeypatch.setenv("BOT_MODULES", "cost_meter,hub")

    posted = []
    monkeypatch.setattr(hp, "_post", lambda *a, **k: posted.append(1))

    assert hp.main(["hub_push.py"]) == 0
    assert posted == []


def _telemetry_with_one_subagent_hour(tmp_path):
    import sqlite3
    from datetime import datetime, timezone
    db = tmp_path / "botcorp_home" / "state" / "tmphub" / "telemetry.db"
    db.parent.mkdir(parents=True)
    con = sqlite3.connect(str(db))
    con.execute("CREATE TABLE rollup_hourly (hour TEXT, session_id TEXT, agent_type TEXT, model TEXT, "
                "n_requests INTEGER, in_tok INTEGER, out_tok INTEGER, cache_tok INTEGER, usd REAL)")
    con.execute("INSERT INTO rollup_hourly VALUES (?,?,?,?,?,?,?,?,?)",
                (datetime.now(timezone.utc).strftime("%Y-%m-%dT%H"), "s1", "Explore", "m", 3, 10, 20, 0, 1.25))
    con.commit()
    con.close()


# v0.7.3: the telemetry rollup's only reader is this push, so it runs here
# (it was declared in harness/automations.yaml, which nothing ever loaded).
def test_push_refreshes_the_subagent_rollup_when_telemetry_is_on(isolated, tmp_path, monkeypatch):
    _telemetry_with_one_subagent_hour(tmp_path)
    monkeypatch.setenv("BOT_MODULES", "cost_meter,hub,telemetry")
    assert hp.main(["hub_push.py", "--dry-run"]) == 0
    assert (isolated / "memory" / "metrics" / "subagents.csv").exists()
    assert hp.build_usage_payload()["subagent_usd_7d"] == 1.25


def test_push_leaves_the_rollup_alone_when_telemetry_is_off(isolated, tmp_path):
    _telemetry_with_one_subagent_hour(tmp_path)
    assert hp.main(["hub_push.py", "--dry-run"]) == 0
    assert not (isolated / "memory" / "metrics" / "subagents.csv").exists()


def test_hub_module_disabled_is_a_noop(isolated, monkeypatch):
    monkeypatch.setenv("BOT_MODULES", "cost_meter")  # no 'hub'
    posted = []
    monkeypatch.setattr(hp, "_post", lambda *a, **k: posted.append(1))

    assert hp.main(["hub_push.py"]) == 0
    assert posted == []
