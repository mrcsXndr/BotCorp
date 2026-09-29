"""v0.8.0: admin bots (bot.yaml role: admin).

Locked behaviour (cli/_lib.mjs callerIdentity/requireOperator, cli/botcorp.mjs,
harness/hooks/operator-guard.sh + vault-guard.sh, daemon/launch.ps1):
- a caller is bot X only when BOT_NAME=X AND its BOTCORP_LAUNCH_ID matches
  <rt>/state/X/launch-id; a BOT_NAME set by hand (another bot's id, or none)
  is refused, exit 3;
- an admin bot may run accounts add|remove|seed|use, secrets set|delete,
  approve/reject, pair <id>, update --apply|--skip and start/stop/restart of
  another bot; each one is a line in state/admin-audit.jsonl with by bot:<name>,
  and the decision / registry logs name bot:<name> whatever --by says;
- a non-admin bot still gets exit 3 for all of them, and for start/stop/restart
  of any bot but its own;
- an admin bot never decides a `role` change (any bot's, its own included):
  named -> exit 3 and audited as refused; swept up by --all -> skipped;
- a `role` change always queues, even from the operator's own terminal;
- reading the vault stays forbidden: secrets export-bundle is operator-only
  (admin or not), vault-guard blocks .vault reads and the launch-id file;
- operator-guard lets an admin bot through (judged from the session's own env,
  never an inline BOT_NAME=), keeps cockpit expose|unexpose for the operator;
- launch.ps1 gives the session BOTCORP_LAUNCH_ID and writes the same id to
  state/<bot>/launch-id.

Every run uses a temp BOTCORP_HOME / BOTCORP_BOTS_DIR, never the real runtime.
"""
from __future__ import annotations

import json
import subprocess

import pytest

from test_cockpit_api import Cockpit, needs_win_node
from test_launch_account_token import _bot_token, _launch, _log, _yaml, abot  # noqa: F401 (abot is a fixture)
from test_hooks_fake_stdin import HARNESS, run_hook
from test_operator_only import ASSEMBLY, CLI, cli, make_bot, needs_node, operator_env, queue

ID_BOSS = "b0" * 32
ID_PEON = "e1" * 32
FAKE = "sk-ant-oat01-" + "FAKE" * 8 + "-Ad1n"


@pytest.fixture
def abox(tmp_path):
    rt, bots = tmp_path / "rt", tmp_path / "bots"
    (rt / "state").mkdir(parents=True)
    make_bot(bots, "boss", "name: boss\nrole: admin\nharness:\n  service: manual\n")
    make_bot(bots, "peon")
    for bot, lid in (("boss", ID_BOSS), ("peon", ID_PEON)):
        (rt / "state" / bot).mkdir()
        (rt / "state" / bot / "launch-id").write_text(lid, encoding="utf-8")
    op = operator_env(rt, bots)

    def as_bot(bot: str, launch_id: str | None) -> dict:
        e = {**op, "BOT_NAME": bot, "CLAUDECODE": "1", "BOT_HOME": str(bots / bot)}
        if launch_id is not None:
            e["BOTCORP_LAUNCH_ID"] = launch_id
        return e

    return rt, bots, op, as_bot


def _audit(rt) -> list[dict]:
    f = rt / "state" / "admin-audit.jsonl"
    return [json.loads(l) for l in f.read_text(encoding="utf-8").splitlines()] if f.exists() else []


def _cli_in(env: dict, stdin: str, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["node", str(CLI), *args], input=stdin, capture_output=True, text=True, timeout=120, cwd=str(ASSEMBLY), env=env)


# --- identity ------------------------------------------------------------------------------
@needs_node
def test_whoami_names_the_admin_and_refuses_a_spoof(abox):
    rt, bots, op, as_bot = abox
    assert json.loads(cli(as_bot("boss", ID_BOSS), "whoami", "--json").stdout)["admin"] is True
    assert json.loads(cli(op, "whoami", "--json").stdout)["operator"] is True
    peon = json.loads(cli(as_bot("peon", ID_PEON), "whoami", "--json").stdout)
    assert peon["admin"] is False and peon["spoofed"] is False
    for lid in (ID_PEON, None, "not-hex"):   # another bot's id, none, garbage
        w = json.loads(cli(as_bot("boss", lid), "whoami", "--json").stdout)
        assert w["admin"] is False and w["spoofed"] is True, w
    (rt / "state" / "boss" / "launch-id").unlink()   # no id recorded (a pre-0.8 launch): not an admin either
    assert json.loads(cli(as_bot("boss", ID_BOSS), "whoami", "--json").stdout)["admin"] is False


# --- accounts ------------------------------------------------------------------------------
@needs_win_node
def test_admin_adds_an_account_a_bot_cannot(abox):
    rt, bots, op, as_bot = abox
    r = _cli_in(as_bot("peon", ID_PEON), FAKE + "\n", "accounts", "add", "acc1")
    assert r.returncode == 3 and "operator-only" in r.stderr, r.stdout + r.stderr
    r = _cli_in(as_bot("boss", ID_PEON), FAKE + "\n", "accounts", "add", "acc1")   # BOT_NAME=boss with peon's id
    assert r.returncode == 3 and "launch id" in r.stderr, r.stdout + r.stderr
    assert not (rt / "accounts").exists()

    r = _cli_in(as_bot("boss", ID_BOSS), FAKE + "\n", "accounts", "add", "acc1", "--by", "operator:someone-else")
    assert r.returncode == 0 and "****Ad1n" in r.stdout, r.stdout + r.stderr
    assert [a["id"] for a in json.loads(cli(op, "accounts", "list", "--json").stdout)] == ["acc1"]
    audit = _audit(rt)
    assert [(a["by"], a["verb"], a.get("target")) for a in audit] == [("bot:boss", "accounts add", "acc1")]
    log = [json.loads(l) for l in (rt / "logs" / "accounts.log").read_text(encoding="utf-8").splitlines()]
    assert log[-1]["by"] == "bot:boss"   # --by cannot relabel an admin bot's action
    for f in (rt / "state" / "admin-audit.jsonl", rt / "logs" / "accounts.log"):
        assert FAKE not in f.read_text(encoding="utf-8")


# --- approvals -----------------------------------------------------------------------------
ROLE = {"id": "a01e01", "ts": "2026-09-29T10:00:00Z", "op": "set", "path": "role", "value": "admin", "requested_by": "bot:peon", "reason": "changes the bot role"}
PERM = {"id": "9e0001", "ts": "2026-09-29T10:01:00Z", "op": "set", "path": "permissions", "value": "default", "requested_by": "bot:peon", "reason": "test"}


@needs_node
def test_admin_approves_but_never_a_role_change(abox):
    rt, bots, op, as_bot = abox
    queue(rt, "peon", [ROLE, PERM])
    boss = as_bot("boss", ID_BOSS)

    r = cli(as_bot("peon", ID_PEON), "approve", "peon", PERM["id"])
    assert r.returncode == 3, r.stdout + r.stderr
    for verb in ("approve", "reject"):
        r = cli(boss, verb, "peon", ROLE["id"])
        assert r.returncode == 3 and "role" in r.stderr, r.stdout + r.stderr
    assert "role" not in (bots / "peon" / "bot.yaml").read_text(encoding="utf-8")

    r = cli(boss, "approve", "peon", "--all")
    assert r.returncode == 0 and f"skipped {ROLE['id']}" in r.stdout, r.stdout + r.stderr
    assert "permissions: default" in (bots / "peon" / "bot.yaml").read_text(encoding="utf-8")
    assert [e["id"] for e in json.loads((rt / "state" / "peon.approvals.json").read_text(encoding="utf-8"))] == [ROLE["id"]]
    hist = [json.loads(l) for l in (rt / "state" / "peon.approvals.history.jsonl").read_text(encoding="utf-8").splitlines()]
    assert [(h["id"], h["approved_by"]) for h in hist] == [(PERM["id"], "bot:boss")]
    refused = [a for a in _audit(rt) if a.get("refused")]
    assert len(refused) == 3 and all(a["by"] == "bot:boss" and ROLE["id"] in a["target"] for a in refused), _audit(rt)

    # its own role, too
    queue(rt, "boss", [{**ROLE, "value": None, "requested_by": "bot:boss"}])
    assert cli(boss, "approve", "boss", ROLE["id"]).returncode == 3

    # the operator decides it
    r = cli(op, "approve", "peon", ROLE["id"])
    assert r.returncode == 0, r.stdout + r.stderr
    assert "role: admin" in (bots / "peon" / "bot.yaml").read_text(encoding="utf-8")


@needs_node
def test_a_role_change_always_queues(abox):
    rt, bots, op, as_bot = abox
    for env in (op, as_bot("boss", ID_BOSS)):
        r = cli(env, "config", "set", "peon", "role", "admin", "--json")
        assert r.returncode == 0, r.stdout + r.stderr
        assert "queued for operator approval" in r.stdout and "role" in r.stdout
    assert "role" not in (bots / "peon" / "bot.yaml").read_text(encoding="utf-8")
    q = json.loads((rt / "state" / "peon.approvals.json").read_text(encoding="utf-8"))
    assert len(q) == 1 and q[0]["path"] == "role" and "role" in q[0]["reason"]   # the second was a duplicate
    # taking admin away queues too
    r = cli(op, "config", "set", "boss", "role", "null")
    assert "queued for operator approval" in r.stdout, r.stdout + r.stderr


@needs_node
def test_botyaml_validates_role(tmp_path):
    js = ("import { validate, loadBotYaml } from './daemon/botyaml.mjs';"
          "for (const r of ['admin', null, 'king']) { const c = loadBotYaml(process.argv[1]); c.role = r; console.log(JSON.stringify(validate(c).filter((e) => e.startsWith('role')))); }")
    make_bot(tmp_path, "v")
    r = subprocess.run(["node", "--input-type=module", "-e", js, str(tmp_path / "v" / "bot.yaml")], capture_output=True, text=True, cwd=str(ASSEMBLY), timeout=60)
    assert r.returncode == 0, r.stderr
    assert [json.loads(l) for l in r.stdout.splitlines()] == [[], [], ['role: admin or null (got "king")']]


# --- start / stop / restart ----------------------------------------------------------------
@needs_node
def test_only_an_admin_controls_another_bot(abox):
    rt, bots, op, as_bot = abox
    for verb in ("start", "stop", "restart"):
        r = cli(as_bot("peon", ID_PEON), verb, "boss")
        assert r.returncode == 3 and "operator-only" in r.stderr, (verb, r.stdout + r.stderr)
    # BOT_NAME=boss with peon's id does not pass as boss's own session
    r = cli(as_bot("boss", ID_PEON), "stop", "boss")
    assert r.returncode == 3 and "launch id" in r.stderr, r.stdout + r.stderr
    assert not _audit(rt)
    # the admin passes the gate (dry-run start: nothing launched) and is audited
    r = cli(as_bot("boss", ID_BOSS), "start", "peon", "--dry-run")
    assert "operator-only" not in r.stderr, r.stdout + r.stderr
    assert [(a["verb"], a["target"]) for a in _audit(rt)] == [("start peon", "peon")]


# --- the vault stays write-only ------------------------------------------------------------
@needs_node
def test_an_admin_still_cannot_read_the_vault(abox, tmp_path):
    rt, bots, op, as_bot = abox
    boss = as_bot("boss", ID_BOSS)
    r = _cli_in(boss, "pass\n", "secrets", "export-bundle", "peon", "--out", str(tmp_path / "out"))
    assert r.returncode == 3 and "operator-only" in r.stderr, r.stdout + r.stderr
    assert not (tmp_path / "out").exists()
    env = {**boss, "CLAUDE_PLUGIN_ROOT": str(HARNESS)}
    for tool, ti in (("Read", {"file_path": str(bots / "peon" / ".vault" / "secrets.json")}),
                     ("Bash", {"command": "node cli/botcorp.mjs secrets export-bundle peon --out x"}),
                     ("Read", {"file_path": str(rt / "state" / "boss" / "launch-id")}),
                     ("PowerShell", {"command": f"Get-Content {rt}\\state\\boss\\launch-id"})):
        p = run_hook("vault-guard.sh", env, json.dumps({"tool_name": tool, "tool_input": ti}))
        assert p.returncode == 2 and "BLOCKED" in p.stderr, (tool, ti, p.stderr)


# --- operator-guard ------------------------------------------------------------------------
def _guard(env, command):
    return run_hook("operator-guard.sh", {**env, "CLAUDE_PLUGIN_ROOT": str(HARNESS)}, json.dumps({"tool_name": "Bash", "tool_input": {"command": command}}))


@needs_node
@pytest.mark.parametrize("command", [
    "node cli/botcorp.mjs approve peon 9e0001",
    "node cli/botcorp.mjs accounts add acc1 --label x",
    "node cli/botcorp.mjs secrets set peon gh_token",
    "node cli/botcorp.mjs pair peon 12345",
    "node cli/botcorp.mjs update --apply v0.8.0",
    "node cli/botcorp.mjs restart peon",
])
def test_operator_guard_lets_an_admin_through(abox, command):
    rt, bots, op, as_bot = abox
    assert _guard(as_bot("boss", ID_BOSS), command).returncode == 0
    as_peon = command.replace("restart peon", "restart boss")   # peon restarting itself is allowed
    p = _guard(as_bot("peon", ID_PEON), as_peon)
    assert p.returncode == 2 and "BLOCKED" in p.stderr, p.stderr
    # an inline BOT_NAME changes nothing: the hook judges the session's own env
    p = _guard(as_bot("peon", ID_PEON), f"BOT_NAME=boss BOTCORP_LAUNCH_ID={ID_BOSS} {as_peon}")
    assert p.returncode == 2, p.stderr


@needs_node
def test_operator_guard_keeps_expose_and_allows_own_restart(abox):
    rt, bots, op, as_bot = abox
    for cmd in ("node cli/botcorp.mjs cockpit expose", "botcorp cockpit unexpose"):
        p = _guard(as_bot("boss", ID_BOSS), cmd)
        assert p.returncode == 2 and "operator" in p.stderr, p.stderr
    for cmd in ("node cli/botcorp.mjs restart peon --fresh", "node cli/botcorp.mjs status boss", "node cli/botcorp.mjs pair peon"):
        assert _guard(as_bot("peon", ID_PEON), cmd).returncode == 0, cmd


# --- cockpit -------------------------------------------------------------------------------
@needs_win_node
def test_cockpit_shows_admin_actions_and_never_runs_as_a_bot(abox):
    rt, bots, op, as_bot = abox
    queue(rt, "peon", [ROLE, PERM])
    assert cli(as_bot("boss", ID_BOSS), "approve", "peon", "--all").returncode == 0
    # a cockpit started from the admin bot's own shell still acts as the operator
    c = Cockpit(as_bot("boss", ID_BOSS))
    try:
        code, r = c.call("GET", "/api/approvals")
        assert code == 200, r
        assert [(a["by"], a["verb"], bool(a["refused"])) for a in r["admin"]] == [("bot:boss", "approve", True), ("bot:boss", "approve", False)]
        code, r = c.call("POST", f"/api/bots/peon/approvals/{ROLE['id']}/approve", {}, token=True)
        assert code == 200, r
    finally:
        c.close()
    assert "role: admin" in (bots / "peon" / "bot.yaml").read_text(encoding="utf-8")
    hist = [json.loads(l) for l in (rt / "state" / "peon.approvals.history.jsonl").read_text(encoding="utf-8").splitlines()]
    assert not hist[-1]["approved_by"].startswith("bot:"), hist[-1]


# --- launch --------------------------------------------------------------------------------
@needs_win_node
def test_launch_gives_the_session_its_id_and_records_the_copy(abot):
    name, home, rt, env, seen = abot
    (seen.parent / "bin" / "claude.cmd").write_text(f'@echo off\r\n>>"{seen}" echo [%BOTCORP_LAUNCH_ID%] %*\r\nexit /b 0\r\n', encoding="utf-8")
    _yaml(home, name, None)
    _bot_token(env, home, name)
    r = _launch(name, env)
    assert r.returncode == 0, r.stdout + r.stderr
    launched = [ln for ln in seen.read_text(encoding="utf-8", errors="replace").splitlines() if "--plugin-dir" in ln]
    got = launched[0].split("]", 1)[0].lstrip("[")
    assert len(got) == 64 and all(c in "0123456789abcdef" for c in got), got
    assert (rt / "state" / name / "launch-id").read_text(encoding="utf-8").strip() == got
    assert got not in _log(rt, name)
