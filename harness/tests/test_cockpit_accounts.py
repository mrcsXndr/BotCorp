"""v0.8.0: the cockpit Accounts sheet's routes.

A real cockpit on a loopback port over a temp BOTCORP_HOME / BOTCORP_BOTS_DIR:
- POST /api/accounts adds an account: refused (403, need approve-token) without
  the per-boot approval token, 400 on a bad id or a token shape that cannot be a
  setup token, 200 with the token; the token travels in the body and reaches
  `accounts add` on stdin, so neither the audit line nor the CLI reply carries
  it (only its last 4); <rt>/logs/accounts.log names the identity;
- GET /api/accounts lists every account with state (ok | limited | failed |
  no-token), the bots on it and their meters, plus every bot with the account
  it runs on and the one bot.yaml wants;
- DELETE /api/accounts/:id removes an account, 409 while a bot.yaml names it.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest

from test_cockpit_api import Cockpit, _audit, needs_win_node
from test_operator_only import cli, make_bot, operator_env

FAKE = "sk-ant-oat01-" + "FAKE" * 8 + "-Z9y8"


@pytest.fixture
def ccockpit(tmp_path):
    rt, bots = tmp_path / "rt", tmp_path / "bots"
    (rt / "state").mkdir(parents=True)
    make_bot(bots, "t")
    make_bot(bots, "u")
    stand_in = tmp_path / "claude.exe"   # never a real Claude Code: a token check would run this, which cannot start
    stand_in.write_bytes(b"not a program")
    env = {**operator_env(rt, bots), "BOTCORP_CLAUDE_EXE": str(stand_in)}
    c = Cockpit(env)
    try:
        yield c, rt, bots, env
    finally:
        c.close()


def _cache_checks(rt, env, ok=True):
    rows = json.loads(cli(env, "accounts", "list", "--json").stdout)
    now = datetime.now(timezone.utc).isoformat()
    (rt / "state" / "account-checks.json").write_text(json.dumps({a["fp"]: {"ok": ok, "at": now, "detail": "haiku replied" if ok else "is_error=true exit 1"} for a in rows}), encoding="utf-8")


@needs_win_node
def test_add_needs_the_token_then_adds_without_leaking_the_secret(ccockpit):
    c, rt, bots, env = ccockpit
    body = {"id": "acc1", "label": "Spare seat", "plan": "max", "token": FAKE}
    code, r = c.call("POST", "/api/accounts", body)
    assert code == 403 and r["need"] == "approve-token", r
    assert c.call("POST", "/api/accounts", {**body, "id": "Bad!"}, token=True)[0] == 400
    assert c.call("POST", "/api/accounts", {**body, "token": "short"}, token=True)[0] == 400
    assert c.call("POST", "/api/accounts", {**body, "token": "has a space " + FAKE}, token=True)[0] == 400
    assert not (rt / "accounts").exists()

    code, r = c.call("POST", "/api/accounts", body, token=True)
    assert code == 200 and r["ok"], r
    assert "****Z9y8" in r["out"] and FAKE not in r["out"] and FAKE not in r["err"], r
    rows = json.loads(cli(env, "accounts", "list", "--json").stdout)
    # v0.8.5: the body's plan is ignored (the CLI detects it; no override from the cockpit)
    assert [(a["id"], a["label"], a["plan"], a["plan_source"]) for a in rows] == [("acc1", "Spare seat", None, None)]
    assert rows[0]["masked"].endswith("Z9y8")

    audit = [a for a in _audit(rt, 5) if a["path"] == "/api/accounts"]
    assert [a["result"] for a in audit] == [403, 400, 400, 400, 200], audit
    assert audit[-1]["identity"] == "local" and audit[-1]["account"] == "acc1" and audit[-1]["action"] == "add"
    assert FAKE not in (rt / "state" / "cockpit-audit.jsonl").read_text(encoding="utf-8")
    log = [json.loads(l) for l in (rt / "logs" / "accounts.log").read_text(encoding="utf-8").splitlines()]
    assert log[-1]["action"] == "add" and log[-1]["id"] == "acc1" and log[-1]["by"] == "local"
    assert FAKE not in (rt / "logs" / "accounts.log").read_text(encoding="utf-8")


@needs_win_node
def test_list_carries_state_bots_and_meters(ccockpit):
    c, rt, bots, env = ccockpit
    for acc in ("acc1", "acc2"):
        assert c.call("POST", "/api/accounts", {"id": acc, "token": FAKE}, token=True)[0] == 200
    _cache_checks(rt, env, ok=True)
    until = (datetime.now(timezone.utc) + timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%SZ")
    (rt / "state" / "accounts.json").write_text(json.dumps({"accounts": {"acc2": {"blocked_until": until, "window": "5h", "bots": []}}}), encoding="utf-8")
    assert c.call("POST", "/api/bots/t/account", {"id": "acc1"}, token=True)[0] == 200

    code, r = c.call("GET", "/api/accounts")
    assert code == 200, r
    by = {a["id"]: a for a in r["accounts"]}
    assert set(by) == {"acc1", "acc2"}
    assert by["acc1"]["state"] == "ok" and by["acc1"]["check"]["ok"] is True and by["acc1"]["wanted_by"] == ["t"]
    assert by["acc2"]["state"] == "limited" and by["acc2"]["window"] == "5h" and by["acc2"]["blocked_until"].startswith(until[:16])
    assert all(set(a) >= {"id", "label", "plan", "masked", "state", "bots", "fiveHour", "sevenDay", "failed"} for a in r["accounts"])
    bots_by = {b["bot"]: b for b in r["bots"]}
    assert bots_by["t"]["account_wanted"] == "acc1" and bots_by["t"]["account_pending"] is True
    assert bots_by["u"]["account_wanted"] is None and bots_by["u"]["account_pending"] is False

    # a cached FAIL reads as failed
    _cache_checks(rt, env, ok=False)
    code, r = c.call("GET", "/api/accounts")
    assert {a["id"]: a["state"] for a in r["accounts"]} == {"acc1": "failed", "acc2": "failed"}
    assert all(a["failed"]["why"] for a in r["accounts"])


@needs_win_node
def test_remove_refuses_while_a_bot_names_the_account(ccockpit):
    c, rt, bots, env = ccockpit
    assert c.call("POST", "/api/accounts", {"id": "acc1", "token": FAKE}, token=True)[0] == 200
    _cache_checks(rt, env, ok=True)
    assert c.call("POST", "/api/bots/t/account", {"id": "acc1"}, token=True)[0] == 200
    assert c.call("DELETE", "/api/accounts/acc1")[0] == 403
    code, r = c.call("DELETE", "/api/accounts/acc1", token=True)
    assert code == 409 and "t" in r["error"], r
    assert json.loads(cli(env, "accounts", "list", "--json").stdout)[0]["id"] == "acc1"
    assert c.call("POST", "/api/bots/t/account", {"id": "none"}, token=True)[0] == 200
    code, r = c.call("DELETE", "/api/accounts/acc1", token=True)
    assert code == 200 and r["ok"], r
    assert json.loads(cli(env, "accounts", "list", "--json").stdout) == []
    audit = [a for a in _audit(rt, 8) if a["path"] == "/api/accounts/acc1"]
    assert [a["result"] for a in audit] == [403, 409, 200] and audit[-1]["action"] == "remove", audit
    log = [json.loads(l) for l in (rt / "logs" / "accounts.log").read_text(encoding="utf-8").splitlines()]
    assert [(e["action"], e["id"]) for e in log] == [("add", "acc1"), ("remove", "acc1")]


def _chain(bots, bot):
    import yaml
    cfg = yaml.safe_load((bots / bot / "bot.yaml").read_text(encoding="utf-8"))
    return cfg.get("account"), cfg.get("backup_accounts")


@needs_win_node
def test_chain_route_sets_primary_and_backups(ccockpit):
    c, rt, bots, env = ccockpit
    for acc in ("acc1", "acc2", "acc3"):
        assert c.call("POST", "/api/accounts", {"id": acc, "token": FAKE}, token=True)[0] == 200
    _cache_checks(rt, env, ok=True)
    url = "/api/bots/t/accounts"
    # shape checks come before the approval token; the gate before any write
    assert c.call("POST", url, {"primary": "acc1", "backups": ["a1", "a2", "a3", "a4", "a5", "a6"]}, token=True)[0] == 400
    assert c.call("POST", url, {"primary": "acc1", "backups": ["acc2", "acc2"]}, token=True)[0] == 400
    assert c.call("POST", url, {"primary": "acc1", "backups": ["acc1"]}, token=True)[0] == 400
    assert c.call("POST", url, {"primary": "Bad!", "backups": []}, token=True)[0] == 400
    assert c.call("POST", url, {"primary": "acc1", "backups": ["acc2"]})[0] == 403
    assert _chain(bots, "t") == (None, None)

    code, r = c.call("POST", url, {"primary": "acc1", "backups": ["acc2", "acc3"]}, token=True)
    assert code == 200 and r["ok"], r
    assert _chain(bots, "t") == ("acc1", ["acc2", "acc3"])
    code, r = c.call("GET", "/api/accounts")
    assert {b["bot"]: b for b in r["bots"]}["t"]["backups"] == ["acc2", "acc3"]

    # the new primary was a backup and the old primary becomes one: cleared first, no half-way failure
    code, r = c.call("POST", url, {"primary": "acc2", "backups": ["acc1"]}, token=True)
    assert code == 200 and r["ok"], r
    assert [s["step"] for s in r["steps"]] == ["accounts backups", "accounts use", "accounts backups"]
    assert _chain(bots, "t") == ("acc2", ["acc1"])

    # an unknown backup after a primary change: the CLI refuses (exit 2 -> 409) and the whole chain is put back
    code, r = c.call("POST", url, {"primary": "acc1", "backups": ["acc3", "nope"]}, token=True)
    assert code == 409 and not r["ok"] and "nope" in r["err"], r
    assert _chain(bots, "t") == ("acc2", ["acc1"])

    # nothing to change is fine; backups [] removes them
    assert c.call("POST", url, {"primary": "acc2", "backups": ["acc1"]}, token=True)[1]["steps"] == []
    assert c.call("POST", url, {"primary": "acc2", "backups": []}, token=True)[0] == 200
    assert _chain(bots, "t") == ("acc2", None)
    log = [json.loads(l) for l in (rt / "logs" / "t" / "accounts.log").read_text(encoding="utf-8").splitlines()]
    assert all(e["by"] == "local" for e in log), log
