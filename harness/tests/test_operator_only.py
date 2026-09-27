"""R5a step 1: approve / reject are operator-only.

Locked behaviour:
- `botcorp approve|reject` refuse with exit 3 when BOT_NAME or CLAUDECODE is in
  the env (a bot session has both): a bot can no longer approve its own queued
  widening change. `approve --list` stays readable from a bot.
- from the operator's env they apply, and the decided entry is stamped with
  approved_by / rejected_by (+ _at) in state/<bot>.approvals.history.jsonl;
  --by names the decider (the cockpit passes its Access identity).
- the cockpit's runCli spawns the CLI without BOT_NAME and CLAUDECODE.

Every run uses a temp BOTCORP_HOME / BOTCORP_BOTS_DIR, never the real runtime.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

ASSEMBLY = Path(__file__).resolve().parents[2]
CLI = ASSEMBLY / "cli" / "botcorp.mjs"

needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="node on PATH")


def operator_env(rt: Path, bots: Path) -> dict:
    """The operator's terminal: no bot-session markers, temp runtime + bots dir."""
    env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE", "TELEGRAM_", "BOT_"))}
    env.update({"BOTCORP_HOME": str(rt), "BOTCORP_BOTS_DIR": str(bots), "BOT_TG_MUTE": "1", "PYTHONIOENCODING": "utf-8"})
    return env


def make_bot(bots: Path, name: str, yaml_text: str | None = None) -> Path:
    home = bots / name
    home.mkdir(parents=True, exist_ok=True)
    (home / "bot.yaml").write_text(yaml_text or f"name: {name}\nharness:\n  service: manual\n", encoding="utf-8")
    return home


def cli(env: dict, *args: str, timeout: int = 120) -> subprocess.CompletedProcess:
    return subprocess.run(["node", str(CLI), *args], capture_output=True, text=True, timeout=timeout, cwd=str(ASSEMBLY), env=env)


def queue(rt: Path, bot: str, entries: list) -> Path:
    f = rt / "state" / f"{bot}.approvals.json"
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(entries), encoding="utf-8")
    return f


@pytest.fixture
def box(tmp_path):
    rt, bots = tmp_path / "rt", tmp_path / "bots"
    (rt / "state").mkdir(parents=True)
    bots.mkdir()
    make_bot(bots, "t")
    return rt, bots, operator_env(rt, bots)


ENTRY = {"id": "abc123", "ts": "2026-09-27T00:00:00Z", "path": "harness.modules.remote_control", "value": True,
         "requested_by": "bot:t", "reason": "enables Remote Control"}


@needs_node
@pytest.mark.parametrize("marker", ["BOT_NAME", "CLAUDECODE"])
def test_approve_refuses_in_a_bot_session(box, marker):
    rt, bots, env = box
    q = queue(rt, "t", [ENTRY])
    r = cli({**env, marker: "x"}, "approve", "t", "abc123")
    assert r.returncode == 3, r.stdout + r.stderr
    assert "operator-only" in r.stderr
    assert json.loads(q.read_text(encoding="utf-8")) == [ENTRY]
    assert "remote_control" not in (bots / "t" / "bot.yaml").read_text(encoding="utf-8")


@needs_node
def test_reject_refuses_in_a_bot_session(box):
    rt, bots, env = box
    q = queue(rt, "t", [ENTRY])
    r = cli({**env, "BOT_NAME": "t"}, "reject", "t", "abc123")
    assert r.returncode == 3, r.stdout + r.stderr
    assert json.loads(q.read_text(encoding="utf-8")) == [ENTRY]


@needs_node
def test_list_stays_readable_from_a_bot(box):
    rt, bots, env = box
    queue(rt, "t", [ENTRY])
    r = cli({**env, "BOT_NAME": "t"}, "approve", "t", "--list", "--json")
    assert r.returncode == 0, r.stderr
    assert json.loads(r.stdout)[0]["id"] == "abc123"


@needs_node
def test_operator_approve_applies_and_stamps_approved_by(box):
    rt, bots, env = box
    q = queue(rt, "t", [ENTRY])
    r = cli(env, "approve", "t", "abc123", "--by", "ops@example.com")
    assert r.returncode == 0, r.stdout + r.stderr
    assert json.loads(q.read_text(encoding="utf-8")) == []
    assert "remote_control: true" in (bots / "t" / "bot.yaml").read_text(encoding="utf-8")
    hist = [json.loads(l) for l in (rt / "state" / "t.approvals.history.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    assert len(hist) == 1 and hist[0]["id"] == "abc123"
    assert hist[0]["approved_by"] == "ops@example.com" and hist[0]["approved_at"]
    log = (rt / "logs" / "t" / "approvals.log").read_text(encoding="utf-8")
    assert "APPROVED abc123" in log and "by ops@example.com" in log


@needs_node
def test_operator_reject_stamps_rejected_by_and_reason(box):
    rt, bots, env = box
    queue(rt, "t", [ENTRY])
    r = cli(env, "reject", "t", "abc123", "--by", "ops@example.com", "--reason", "not now")
    assert r.returncode == 0, r.stdout + r.stderr
    hist = json.loads((rt / "state" / "t.approvals.history.jsonl").read_text(encoding="utf-8").splitlines()[0])
    assert hist["rejected_by"] == "ops@example.com" and hist["rejected_reason"] == "not now"
    assert "remote_control" not in (bots / "t" / "bot.yaml").read_text(encoding="utf-8")


@needs_node
def test_cockpit_runcli_env_drops_the_bot_markers():
    script = (
        "process.env.BOT_NAME='somebot'; process.env.CLAUDECODE='1';"
        "const { cliEnv } = await import(process.argv[1]);"
        "const e = cliEnv();"
        "console.log(JSON.stringify({ bot: 'BOT_NAME' in e, cc: 'CLAUDECODE' in e, path: !!(e.PATH || e.Path) }));"
    )
    url = (ASSEMBLY / "cockpit" / "cli.mjs").as_uri()
    r = subprocess.run(["node", "--input-type=module", "-e", script, url], capture_output=True, text=True, timeout=60, cwd=str(ASSEMBLY))
    assert r.returncode == 0, r.stderr
    assert json.loads(r.stdout.strip().splitlines()[-1]) == {"bot": False, "cc": False, "path": True}
