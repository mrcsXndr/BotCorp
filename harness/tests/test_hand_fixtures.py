"""'_' fixtures (bots/_canary) are driven by hand, never by the daemon.

Locked behaviour:
- `botcorp start _canary --dry-run` is accepted and reaches launch.ps1 -DryRun
  (nothing launched, no nonce minted); `stop` and `observe` take the name too;
- every other verb keeps NAME_RE (`sync _canary` is a usage error), and a name
  that is only underscores or has two is still refused;
- `status` / `observe --all` never list a '_' folder;
- pty-host accepts the name (an attach host can serve the canary);
- a -ProbeOnly tick logs the real bot next to it and never the fixture, even with
  a state file that says it runs.

Every run uses a temp BOTCORP_HOME / BOTCORP_BOTS_DIR and its own daemon mutex.
"""
from __future__ import annotations

import json
import os
import secrets
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ASSEMBLY = Path(__file__).resolve().parents[2]
CLI = ASSEMBLY / "cli" / "botcorp.mjs"

pytestmark = pytest.mark.skipif(sys.platform != "win32" or shutil.which("pwsh") is None or shutil.which("node") is None,
                                reason="Windows with pwsh and node on PATH")


@pytest.fixture
def box(tmp_path):
    rt = tmp_path / "rt"
    (rt / "state").mkdir(parents=True)
    bots = tmp_path / "bots"
    (bots / "_canary").mkdir(parents=True)
    shutil.copy2(ASSEMBLY / "bots" / "_canary" / "bot.yaml", bots / "_canary" / "bot.yaml")
    (bots / "zz-real").mkdir()
    (bots / "zz-real" / "bot.yaml").write_text("name: zz-real\nharness:\n  service: manual\n  modules:\n    telegram: false\n", encoding="utf-8")
    env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE", "TELEGRAM_", "BOT_"))}
    env.update({"BOTCORP_HOME": str(rt), "BOTCORP_BOTS_DIR": str(bots), "BOTCORP_ROOT": str(ASSEMBLY),
                "BOTCORP_DAEMON_MUTEX": f"Global\\BotCorpDaemon-test-{secrets.token_hex(8)}", "BOT_TG_MUTE": "1"})
    return rt, bots, env


def _cli(env, *args):
    return subprocess.run(["node", str(CLI), *args], capture_output=True, text=True, timeout=240, cwd=str(ASSEMBLY), env=env)


def test_start_dry_run_takes_the_fixture(box):
    rt, _, env = box
    r = _cli(env, "start", "_canary", "--dry-run")
    assert r.returncode == 0, r.stderr + r.stdout
    assert "argv:" in r.stdout and "(dry-run) nothing launched" in r.stdout, r.stdout
    assert "attested: NO" in r.stdout, r.stdout
    st = rt / "state" / "_canary.json"
    assert not st.exists() or "nonce_sha256" not in st.read_text(encoding="utf-8")


def test_stop_and_observe_take_the_fixture(box):
    rt, _, env = box
    r = _cli(env, "stop", "_canary")
    assert r.returncode == 0, r.stderr + r.stdout
    assert (rt / "state" / "_canary.paused").exists()
    r = _cli(env, "observe", "_canary", "--json")
    assert r.returncode == 0, r.stderr
    o = json.loads(r.stdout)
    assert o["bot"] == "_canary" and o["alive"] is False and o["phase"] in ("stopped", "down"), o


def test_other_verbs_and_bad_names_are_refused(box):
    _, _, env = box
    assert _cli(env, "sync", "_canary").returncode == 2
    for bad in ("_", "__canary", "_Canary"):
        r = _cli(env, "start", bad, "--dry-run")
        assert r.returncode == 2, (bad, r.stdout, r.stderr)


def test_listings_skip_the_fixture(box):
    _, _, env = box
    r = _cli(env, "observe", "--all", "--json")
    assert r.returncode == 0, r.stderr
    assert [o["bot"] for o in json.loads(r.stdout)] == ["zz-real"]
    r = _cli(env, "status", "--json")
    assert r.returncode == 0, r.stderr
    assert [s["name"] for s in json.loads(r.stdout)] == ["zz-real"]


def test_pty_host_takes_the_fixture_name(box):
    _, _, env = box
    r = subprocess.run(["node", str(ASSEMBLY / "daemon" / "pty-host.mjs"), "--stop", "_canary"],
                       capture_output=True, text=True, timeout=60, cwd=str(ASSEMBLY), env=env)
    assert r.returncode == 0 and "not running" in r.stdout, r.stderr + r.stdout


def test_a_probe_tick_never_touches_the_fixture(box):
    rt, _, env = box
    # a state file that says it runs, on this very process: a tick that listed the fixture would log it alive
    (rt / "state" / "_canary.json").write_text(json.dumps({"bot": "_canary", "claude_pid": os.getpid(), "bg_id": "abc123", "schema": 2}), encoding="utf-8")
    r = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(ASSEMBLY / "daemon" / "tick.ps1"), "-ProbeOnly"],
                       capture_output=True, text=True, timeout=300, cwd=str(ASSEMBLY), env=env)
    assert r.returncode == 0, r.stderr
    log = (rt / "daemon.log").read_text(encoding="utf-8")
    assert "[zz-real]" in log, log[-2000:]     # positive control: the tick did walk the bots
    assert "_canary" not in log, log[-2000:]
