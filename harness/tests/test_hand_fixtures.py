"""'_' fixtures (bots/_canary) are driven by hand, never by the daemon.

Locked behaviour:
- `botcorp start _canary --dry-run` is accepted and reaches launch.ps1 -DryRun
  (nothing launched, no nonce minted); `stop` and `observe` take the name too;
- `sync _canary` passes: its bot.yaml `name:` is the folder name;
- every other verb keeps NAME_RE (`status _canary` is a usage error), and a name
  that is only underscores or has two is still refused;
- `status` / `observe --all` never list a '_' folder, nor does the cockpit's
  /api/bots; the cockpit's bot, send and inbox routes take it by name;
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


def test_sync_takes_the_fixture(box):
    # its bot.yaml `name:` is the folder name, which sync checks after validate()
    _, bots, env = box
    r = _cli(env, "sync", "_canary")
    assert r.returncode == 0 and "sync: _canary ok" in r.stdout, r.stderr + r.stdout
    assert (bots / "_canary" / ".claude" / "settings.json").exists()


def test_secrets_take_the_fixture(box):
    # a real start needs the fixture's own oauth_token in its vault
    _, _, env = box
    r = _cli(env, "secrets", "list", "_canary", "--json")
    assert r.returncode == 0 and "bad bot name" not in r.stderr, r.stderr + r.stdout
    assert _cli(env, "secrets", "list", "__canary", "--json").returncode == 2


def test_other_verbs_and_bad_names_are_refused(box):
    _, _, env = box
    assert _cli(env, "status", "_canary").returncode == 2
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


def test_the_cockpit_addresses_the_fixture_by_name_only(box):
    # never listed, but its page, send and inbox routes take the name
    import socket
    import time
    import urllib.error
    import urllib.request
    rt, _, env = box
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    srv = subprocess.Popen(["node", str(ASSEMBLY / "cockpit" / "server.mjs"), "--port", str(port)], cwd=str(ASSEMBLY), env=env,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        base = f"http://127.0.0.1:{port}"
        deadline = time.time() + 60
        while True:
            try:
                urllib.request.urlopen(base + "/healthz", timeout=5).read()
                break
            except OSError:
                assert time.time() < deadline and srv.poll() is None, "cockpit did not come up"
                time.sleep(0.5)
        cookie = urllib.request.urlopen(base + "/", timeout=30).headers["Set-Cookie"].split(";")[0]

        def call(method, path, body=None):
            req = urllib.request.Request(base + path, method=method, headers={"Cookie": cookie, "Content-Type": "application/json"},
                                         data=json.dumps(body).encode() if body is not None else None)
            try:
                with urllib.request.urlopen(req, timeout=120) as r:
                    return r.status, json.loads(r.read())
            except urllib.error.HTTPError as e:
                return e.code, json.loads(e.read())

        assert [b["name"] for b in call("GET", "/api/bots")[1]] == ["zz-real"]
        code, bot = call("GET", "/api/bots/_canary")
        assert code == 200 and bot["name"] == "_canary" and bot["running"] is False, bot
        # stopped (no state file): queued, then failed at once, never typed
        code, item = call("POST", "/api/bots/_canary/send", {"text": "canary ping"})
        assert code == 200 and item["status"] == "queued", item
        end = time.time() + 60
        while (rows := call("GET", "/api/bots/_canary/inbox")[1])[-1]["status"] != "failed":
            assert time.time() < end, rows
            time.sleep(0.3)
        assert rows[-1]["id"] == item["id"] and "session stopped" in rows[-1]["detail"], rows
        for bad in ("_", "__canary", "_Canary"):
            assert call("GET", f"/api/bots/{bad}")[0] == 404, bad
        assert call("POST", "/api/bots/__canary/send", {"text": "hi"})[0] == 404
    finally:
        srv.kill()


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
