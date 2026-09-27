"""R5c step 16: bot.yaml `account:` + `botcorp accounts use` + the `accounts remove` guard.

Locked behaviour:
- `accounts use <bot> <id>` from the operator writes bot.yaml `account: <id>`
  and one JSON line to <rt>/logs/<bot>/accounts.log; `none` deletes the key.
- from a bot session (BOT_NAME) it refuses with exit 3 and writes nothing.
- an unknown account, or one whose token check fails, is exit 2 with no writes.
- `accounts remove <id>` refuses (exit 2) while a bot.yaml names it.
- `config set <bot> account <id>` from a bot is widening: queued, not applied.
- validation checks the id shape only, so a bot naming a removed account still
  validates (a failed validation stops the launch).

Every run uses a temp BOTCORP_HOME / BOTCORP_BOTS_DIR; the token check's result
comes from its seeded 24 h cache, and the account token is a fake value.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from datetime import datetime, timezone

import pytest

from test_operator_only import ASSEMBLY, cli, make_bot, operator_env

FAKE_TOKEN = "sk-ant-oat01-" + "FAKE" * 7 + "-A1b2"

pytestmark = pytest.mark.skipif(
    sys.platform != "win32" or shutil.which("pwsh") is None or shutil.which("node") is None,
    reason="Windows only (DPAPI account vault) with pwsh and node on PATH",
)


@pytest.fixture
def ubox(tmp_path):
    rt, bots = tmp_path / "rt", tmp_path / "bots"
    (rt / "state").mkdir(parents=True)
    bots.mkdir()
    make_bot(bots, "fx")
    # never a real Claude Code: a cache miss runs this stand-in, which cannot start
    stand_in = tmp_path / "claude.exe"
    stand_in.write_bytes(b"not a program")
    env = {**operator_env(rt, bots), "BOTCORP_CLAUDE_EXE": str(stand_in)}
    r = subprocess.run(
        ["node", str(ASSEMBLY / "cli" / "botcorp.mjs"), "accounts", "add", "acc1"],
        capture_output=True, text=True, timeout=120, cwd=str(ASSEMBLY), env=env, input=FAKE_TOKEN + "\n")
    assert r.returncode == 0, r.stdout + r.stderr
    _token_check(rt, env, ok=True)
    return rt, bots, env, tmp_path


def _token_check(rt, env, ok: bool):
    """Seed the doctor's 24 h token-check cache (keyed by the vault fingerprint) with a result."""
    fp = json.loads(cli(env, "accounts", "list", "--json").stdout)[0]["fp"]
    (rt / "state" / "account-checks.json").write_text(json.dumps({fp: {"ok": ok, "at": datetime.now(timezone.utc).isoformat(), "detail": "haiku replied" if ok else "is_error=true exit 1"}}), encoding="utf-8")


def _yaml(bots):
    return (bots / "fx" / "bot.yaml").read_bytes()


def test_operator_use_writes_the_key_and_one_log_line(ubox):
    rt, bots, env, _ = ubox
    r = cli(env, "accounts", "use", "fx", "acc1", "--by", "ops@example.com")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "account: acc1" in _yaml(bots).decode()
    assert "session_env.oauth_last4 = A1b2" in r.stdout and "next idle" in r.stdout
    lines = (rt / "logs" / "fx" / "accounts.log").read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1
    rec = json.loads(lines[0])
    assert rec["by"] == "ops@example.com" and rec["from"] is None and rec["to"] == "acc1" and rec["at"]


def test_from_a_bot_it_refuses_and_writes_nothing(ubox):
    rt, bots, env, _ = ubox
    before = _yaml(bots)
    r = cli({**env, "BOT_NAME": "x"}, "accounts", "use", "fx", "acc1")
    assert r.returncode == 3, r.stdout + r.stderr
    assert _yaml(bots) == before
    assert not (rt / "logs" / "fx" / "accounts.log").exists()


def test_unknown_account_is_exit_2_with_no_writes(ubox):
    rt, bots, env, _ = ubox
    before = _yaml(bots)
    r = cli(env, "accounts", "use", "fx", "nope")
    assert r.returncode == 2, r.stdout + r.stderr
    assert _yaml(bots) == before
    assert not (rt / "logs" / "fx" / "accounts.log").exists()


def test_a_failed_token_check_is_exit_2_with_no_writes(ubox):
    rt, bots, env, _ = ubox
    _token_check(rt, env, ok=False)
    before = _yaml(bots)
    r = cli(env, "accounts", "use", "fx", "acc1")
    assert r.returncode == 2, r.stdout + r.stderr
    assert "token check" in r.stderr
    assert _yaml(bots) == before


def test_use_none_deletes_the_key(ubox):
    rt, bots, env, _ = ubox
    assert cli(env, "accounts", "use", "fx", "acc1").returncode == 0
    r = cli(env, "accounts", "use", "fx", "none")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "account" not in _yaml(bots).decode()
    lines = (rt / "logs" / "fx" / "accounts.log").read_text(encoding="utf-8").splitlines()
    assert json.loads(lines[-1])["from"] == "acc1" and json.loads(lines[-1])["to"] is None


def test_remove_refuses_while_a_bot_uses_the_account(ubox):
    rt, bots, env, _ = ubox
    assert cli(env, "accounts", "use", "fx", "acc1").returncode == 0
    r = cli(env, "accounts", "remove", "acc1")
    assert r.returncode == 2, r.stdout + r.stderr
    assert "fx" in r.stderr
    r = cli(env, "accounts", "list", "--json")
    assert [row["id"] for row in json.loads(r.stdout)] == ["acc1"]


def test_config_set_account_from_a_bot_is_queued(ubox):
    rt, bots, env, _ = ubox
    before = _yaml(bots)
    r = cli({**env, "BOT_NAME": "x"}, "config", "set", "fx", "account", "acc1")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "queued for operator approval" in r.stdout
    q = json.loads((rt / "state" / "fx.approvals.json").read_text(encoding="utf-8"))
    assert len(q) == 1 and q[0]["path"] == "account" and q[0]["value"] == "acc1" and q[0]["reason"] == "switches the Claude account"
    assert _yaml(bots) == before


def test_a_missing_account_still_validates(tmp_path):
    f = tmp_path / "gone" / "bot.yaml"
    f.parent.mkdir()
    f.write_text("name: gone\naccount: gone-acct\n", encoding="utf-8")
    r = subprocess.run(["node", str(ASSEMBLY / "daemon" / "botyaml.mjs"), str(f)], capture_output=True, text=True, timeout=60, cwd=str(ASSEMBLY))
    assert r.returncode == 0, r.stderr
    cfg = json.loads(r.stdout)
    assert cfg["account"] == "gone-acct" and cfg["_errors"] == []
    f.write_text("name: gone\naccount: Bad_Id\n", encoding="utf-8")
    r = subprocess.run(["node", str(ASSEMBLY / "daemon" / "botyaml.mjs"), str(f)], capture_output=True, text=True, timeout=60, cwd=str(ASSEMBLY))
    assert any(e.startswith("account:") for e in json.loads(r.stdout)["_errors"])
