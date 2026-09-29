"""v0.7.3: the operator gates beyond approve / reject.

Locked behaviour:
- `pair <bot> <id>`, `cockpit expose|unexpose`, `update --apply|--skip`,
  `cc rollback`, `secrets set|delete` (any bot) and `accounts add|remove|seed`
  refuse with exit 3 when BOT_NAME or CLAUDECODE is in the env, and change
  nothing. `--requested-by` is refused there too, so a bot cannot label its own
  queued entry `operator:...`.
- the same verbs still work from the operator's env (the positive control).
- the cockpit's pair, secret-set and release Apply/Skip routes need the
  per-boot approval token on loopback, like approve.

Every run uses a temp BOTCORP_HOME / BOTCORP_BOTS_DIR, never the real runtime.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys

import pytest

from test_cockpit_api import Cockpit
from test_operator_only import ASSEMBLY, CLI, cli, make_bot, needs_node, operator_env

needs_win = pytest.mark.skipif(sys.platform != "win32" or shutil.which("pwsh") is None or shutil.which("node") is None,
                               reason="Windows only (DPAPI vault) with pwsh and node on PATH")
FAKE = "value-for-tests-" + "x" * 20 + "-Zz9Q"
RELEASES = {"releases": [{"tag": "v9.9.9", "status": "pending", "date": "2026-09-27"}]}


@pytest.fixture
def box(tmp_path):
    rt, bots = tmp_path / "rt", tmp_path / "bots"
    (rt / "state").mkdir(parents=True)
    bots.mkdir()
    make_bot(bots, "t")
    (rt / "state" / "updates.json").write_text(json.dumps(RELEASES), encoding="utf-8")
    return rt, bots, operator_env(rt, bots)


GATED = [
    (("pair", "t", "12345"), None),
    (("cockpit", "expose", "--team", "acme", "--aud", "aud1234", "--yes"), None),
    (("cockpit", "unexpose"), None),
    (("update", "--apply", "v9.9.9"), None),
    (("update", "--skip", "v9.9.9"), None),
    (("update", "--rollback", "v0.0.1"), None),
    (("update", "--cancel", "v9.9.9"), None),
    (("cc", "rollback"), None),
    (("secrets", "set", "t", "api_key"), FAKE + "\n"),
    (("secrets", "delete", "t", "api_key"), None),
    (("accounts", "add", "acc1"), FAKE + "\n"),
    (("accounts", "remove", "acc1"), None),
    (("accounts", "seed"), None),
    (("config", "set", "t", "harness.modules.remote_control", "true", "--requested-by", "operator:me"), None),
]


def cli_in(env: dict, stdin: str | None, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["node", str(CLI), *args], input=stdin, capture_output=True, text=True, timeout=120, cwd=str(ASSEMBLY), env=env)


def _snapshot(rt, bots):
    files = [p for root in (rt, bots) for p in sorted(root.rglob("*")) if p.is_file()]
    return {str(p): p.read_bytes() for p in files}


@needs_node
@pytest.mark.parametrize("marker", ["BOT_NAME", "CLAUDECODE"])
@pytest.mark.parametrize("args,stdin", GATED, ids=[" ".join(a[:2]) for a, _ in GATED])
def test_refused_in_a_bot_session_and_nothing_changes(box, marker, args, stdin):
    rt, bots, env = box
    (rt / "access.json").write_text(json.dumps({"team": "old", "aud": "old"}), encoding="utf-8")   # unexpose must not remove it
    before = _snapshot(rt, bots)
    r = cli_in({**env, marker: "x"}, stdin, *args)
    assert r.returncode == 3, r.stdout + r.stderr
    assert "operator-only" in r.stderr
    assert _snapshot(rt, bots) == before


# ---- positive controls: the operator's env ---------------------------------------------------

@needs_node
def test_operator_pairs(box):
    rt, bots, env = box
    r = cli(env, "pair", "t", "12345")
    assert r.returncode == 0, r.stdout + r.stderr
    acc = json.loads((bots / "t" / ".claude-t" / "channels" / "telegram" / "access.json").read_text(encoding="utf-8"))
    assert "12345" in [str(x) for x in acc["allowFrom"]]


@needs_node
def test_pair_list_and_deny_stay_open_to_a_bot(box):
    rt, bots, env = box
    assert cli({**env, "BOT_NAME": "t"}, "pair", "t", "--list", "--json").returncode == 0
    assert cli({**env, "BOT_NAME": "t"}, "pair", "t", "--deny", "12345").returncode == 0


@needs_node
def test_operator_exposes_and_unexposes(box):
    rt, bots, env = box
    r = cli(env, "cockpit", "expose", "--team", "acme", "--aud", "aud1234", "--yes")
    assert r.returncode == 0, r.stdout + r.stderr
    assert json.loads((rt / "access.json").read_text(encoding="utf-8")) == {"team": "acme", "aud": "aud1234"}
    r = cli(env, "cockpit", "unexpose")
    assert r.returncode == 0, r.stdout + r.stderr
    assert not (rt / "access.json").exists()


@needs_node
@pytest.mark.parametrize("flag,status", [("--apply", "apply_requested"), ("--skip", "skipped")])
def test_operator_decides_a_release(box, flag, status):
    rt, bots, env = box
    r = cli(env, "update", flag, "v9.9.9", "--requested-by", "operator:ops")
    assert r.returncode == 0, r.stdout + r.stderr
    rel = json.loads((rt / "state" / "updates.json").read_text(encoding="utf-8"))["releases"][0]
    assert rel["status"] == status and rel["decided_by"] == "operator:ops"


@needs_win
def test_operator_cc_rollback_reaches_the_pin_script(box):
    rt, bots, env = box
    r = cli(env, "cc", "rollback")
    # nothing pinned in the temp runtime: cc.ps1 itself refuses, which proves the CLI let it through
    assert r.returncode != 3 and "operator-only" not in r.stderr, r.stdout + r.stderr
    assert "rollback refused" in r.stdout + r.stderr


@needs_node
def test_a_bot_queues_under_its_own_name(box):
    rt, bots, env = box
    r = cli({**env, "BOT_NAME": "t"}, "config", "set", "t", "harness.modules.remote_control", "true")
    assert r.returncode == 0, r.stdout + r.stderr
    q = json.loads((rt / "state" / "t.approvals.json").read_text(encoding="utf-8"))
    assert [e["requested_by"] for e in q] == ["bot:t"]


@needs_win
def test_operator_sets_and_deletes_a_secret(box):
    rt, bots, env = box
    r = cli_in(env, FAKE + "\n", "secrets", "set", "t", "api_key")
    assert r.returncode == 0, r.stdout + r.stderr
    rows = json.loads(cli(env, "secrets", "list", "t", "--json").stdout)
    assert any(x["key"] == "api_key" for x in rows)
    r = cli(env, "secrets", "delete", "t", "api_key")
    assert r.returncode == 0, r.stdout + r.stderr
    assert not any(x["key"] == "api_key" for x in json.loads(cli(env, "secrets", "list", "t", "--json").stdout))


@needs_win
def test_operator_adds_seeds_and_removes_an_account(box):
    rt, bots, env = box
    r = cli_in(env, FAKE + "\n", "accounts", "add", "acc1")
    assert r.returncode == 0, r.stdout + r.stderr
    assert cli(env, "accounts", "seed", "--json").returncode == 0
    assert cli(env, "accounts", "remove", "acc1").returncode == 0
    assert json.loads(cli(env, "accounts", "list", "--json").stdout or "[]") == []


# ---- the cockpit routes -----------------------------------------------------------------------

@pytest.fixture
def cockpit(box):
    rt, bots, env = box
    c = Cockpit(env)
    try:
        yield c, rt, bots
    finally:
        c.close()


@needs_node
def test_cockpit_pair_needs_the_token(cockpit):
    c, rt, bots = cockpit
    code, body = c.call("POST", "/api/bots/t/pair", {"senderId": "12345"})
    assert code == 403 and body["need"] == "approve-token", body
    assert not (bots / "t" / ".claude-t" / "channels" / "telegram" / "access.json").exists()
    code, body = c.call("POST", "/api/bots/t/pair", {"senderId": "12345"}, token=True)
    assert code == 200 and body["ok"], body


@needs_node
@pytest.mark.parametrize("action,status", [("apply", "apply_requested"), ("skip", "skipped")])
def test_cockpit_release_decision_needs_the_token(cockpit, action, status):
    c, rt, bots = cockpit
    f = rt / "state" / "updates.json"
    code, body = c.call("POST", f"/api/updates/v9.9.9/{action}")
    assert code == 403 and body["need"] == "approve-token", body
    assert json.loads(f.read_text(encoding="utf-8")) == RELEASES
    code, body = c.call("POST", f"/api/updates/v9.9.9/{action}", token=True)
    assert code == 200 and body["ok"], body
    assert json.loads(f.read_text(encoding="utf-8"))["releases"][0]["status"] == status


@needs_node
def test_cockpit_secret_set_needs_the_token(cockpit):
    c, rt, bots = cockpit
    code, body = c.call("PUT", "/api/bots/t/secrets/api_key", {"value": FAKE})
    assert code == 403 and body["need"] == "approve-token", body
    assert not (bots / "t" / ".vault").exists()


@needs_win
def test_cockpit_secret_set_with_the_token_stores_it(cockpit):
    c, rt, bots = cockpit
    code, body = c.call("PUT", "/api/bots/t/secrets/api_key", {"value": FAKE}, token=True)
    assert code == 200 and body == {"key": "api_key", "ok": True}, body


# ---- the token also lands in an owner-only file (a daemon-started cockpit has no terminal) ----

@needs_node
def test_cockpit_writes_its_token_to_an_owner_only_file(cockpit):
    c, rt, bots = cockpit
    f = rt / "state" / "cockpit-approve-token"
    assert f.read_text(encoding="utf-8").strip() == c.token
    assert not (rt / "state" / "cockpit-approve-token.tmp").exists()
    c.token = f.read_text(encoding="utf-8").strip()
    code, body = c.call("POST", "/api/bots/t/pair", {"senderId": "12345"}, token=True)
    assert code == 200 and body["ok"], body
    if sys.platform == "win32":
        acl = subprocess.run(["icacls", str(f)], capture_output=True, text=True).stdout
        aces = [l.strip().removeprefix(str(f)).strip() for l in acl.splitlines()[:-1] if l.strip()]
        assert len(aces) == 1 and "(I)" not in aces[0], acl
        assert aces[0].lower().split(":")[0].endswith("\\" + os.environ["USERNAME"].lower()), acl
    else:
        assert (f.stat().st_mode & 0o777) == 0o600
