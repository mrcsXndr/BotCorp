"""State schema v2: `desired` / `launch` / `observed`, no `status` field.

Locked behaviour:
- the tick's Update-BotStatesV2 (daemon/_common.ps1) rewrites every
  <BOTCORP_HOME>/state/<bot>.json from v1 (flat status / exit_code / stopped_at /
  stopped_by) into the blocks, keeps the vault attestation inside `launch`, leaves
  non-bot files (updates.json, ...) alone, and a second run changes no byte. It is
  not a harness/migrations script: that number (botYamlSchema) is bot.yaml's;
- the readers (core/state.mjs stateView, cli/_lib.mjs sessionAliveVerdict) read an
  un-migrated v1 file the same way as its migrated v2 form;
- Set-BotLaunchPhase keeps the attestation, and a new attestation (New-LaunchNonce)
  keeps the phase;
- a real tick persists core/observe.mjs's record as `observed`, and the write
  leaves no `status` behind;
- core/state.mjs phase() derives the one phase from `observed` (+ `desired`, `launch`);
- a bot whose claude process is gone reads alive:false in `botcorp observe` and
  phase "down" in the cockpit's /api/bots/<bot>.

Every run uses a temp BOTCORP_HOME / BOTCORP_BOTS_DIR and its own daemon mutex.
"""
from __future__ import annotations

import json
import os
import secrets
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

ASSEMBLY = Path(__file__).resolve().parents[2]
COMMON = ASSEMBLY / "daemon" / "_common.ps1"

pytestmark = pytest.mark.skipif(sys.platform != "win32" or shutil.which("pwsh") is None or shutil.which("node") is None,
                                reason="Windows with pwsh and node on PATH")

ATTEST = {"nonce_sha256": "ab" * 32, "minted_by_pid": 4242, "at": "2026-09-01T10:00:00.0000000Z", "at_unix": 1788256800, "consumed_at": "2026-09-01T10:00:05.0000000Z"}
V1_RUNNING = {"bot": "alpha", "status": "running", "exit_code": 0, "claude_pid": 999999, "bg_id": "abc123", "session_id": "S1",
              "started_by": "daemon-cold", "started_at": "2026-09-01T10:00:00Z", "updated_at": "2026-09-01T10:03:00Z", "poller": "OWNED", "launch": ATTEST}
V1_STOPPED = {"bot": "beta", "status": "stopped", "stopped_at": "2026-09-02T08:00:00Z", "stopped_by": "cli", "claude_pid": None, "updated_at": "2026-09-02T07:00:00Z"}
V1_FAILED = {"bot": "gamma", "status": "exited", "exit_code": 5, "updated_at": "2026-09-03T09:00:00Z"}


@pytest.fixture
def rt(tmp_path):
    home = tmp_path / "rt"
    (home / "state").mkdir(parents=True)
    env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE", "TELEGRAM_", "BOT_"))}
    env.update({"BOTCORP_HOME": str(home), "BOTCORP_BOTS_DIR": str(tmp_path / "bots"), "BOTCORP_ROOT": str(ASSEMBLY),
                "BOTCORP_DAEMON_MUTEX": f"Global\\BotCorpDaemon-test-{secrets.token_hex(8)}", "BOT_TG_MUTE": "1"})
    (tmp_path / "bots").mkdir()
    return home, env


def _ps(body: str, env: dict) -> str:
    r = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", f". '{COMMON}'\n{body}"],
                       capture_output=True, text=True, timeout=180, cwd=str(ASSEMBLY), env=env)
    assert r.returncode == 0, r.stderr + r.stdout
    return [ln for ln in r.stdout.splitlines() if ln.strip()][-1]


def _node(body: str, env: dict) -> object:
    state = (ASSEMBLY / "core" / "state.mjs").as_uri()
    lib = (ASSEMBLY / "cli" / "_lib.mjs").as_uri()
    script = f"const s = await import({json.dumps(state)}); const l = await import({json.dumps(lib)}); console.log(JSON.stringify({body}));"
    r = subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, text=True, timeout=120, cwd=str(ASSEMBLY), env=env)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout.strip().splitlines()[-1])


def _write(path: Path, obj: dict) -> None:
    path.write_text(json.dumps(obj, indent=2) + "\n", encoding="utf-8")


def _read(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def test_the_migration_folds_v1_into_the_blocks_and_runs_idempotently(rt):
    home, env = rt
    st = home / "state"
    for rec in (V1_RUNNING, V1_STOPPED, V1_FAILED):
        _write(st / f"{rec['bot']}.json", rec)
    updates = {"releases": [{"tag": "v9.9.9", "status": "pending"}]}
    _write(st / "updates.json", updates)
    other = {"bot": "someone-else", "status": "running"}          # `bot` does not name the file: not a bot state file
    _write(st / "delta.json", other)
    v1_views = {b: _node(f"s.stateView({json.dumps(r)})", env) for b, r in (("alpha", V1_RUNNING), ("beta", V1_STOPPED), ("gamma", V1_FAILED))}

    migrate = "$r = Update-BotStatesV2; \"$($r.Seen) $($r.Changed) $($r.Failed)\""
    assert _ps(migrate, env) == "3 3 0"

    a = _read(st / "alpha.json")
    assert "status" not in a and "exit_code" not in a and a["schema"] == 2
    assert a["desired"] == {"state": "running", "by": "daemon-cold", "at": "2026-09-01T10:00:00Z"}
    assert a["launch"]["phase"] == "up" and a["launch"]["exit_code"] == 0
    assert {k: a["launch"][k] for k in ("nonce_sha256", "minted_by_pid", "at_unix")} == {k: ATTEST[k] for k in ("nonce_sha256", "minted_by_pid", "at_unix")}
    assert a["launch"]["consumed_at"], "the attestation survives the fold"
    assert a["claude_pid"] == 999999 and a["bg_id"] == "abc123" and a["poller"] == "OWNED"
    b = _read(st / "beta.json")
    assert b["desired"] == {"state": "stopped", "by": "cli", "at": "2026-09-02T08:00:00Z"}
    assert "stopped_at" not in b and "stopped_by" not in b and "phase" not in b.get("launch", {})
    g = _read(st / "gamma.json")
    assert g["launch"] == {"phase": "exited", "phase_at": "2026-09-03T09:00:00Z", "exit_code": 5}
    assert _read(st / "updates.json") == updates and _read(st / "delta.json") == other

    # the readers see an un-migrated v1 file exactly as its migrated v2 form
    for bot, want in v1_views.items():
        got = _node(f"s.stateView({json.dumps(_read(st / f'{bot}.json'))})", env)
        assert got["desired"] == want["desired"], bot
        assert got["launch"].get("phase") == want["launch"].get("phase") and got["launch"].get("exit_code") == want["launch"].get("exit_code"), bot
    verdicts = _node("[" + ",".join(f"l.sessionAliveVerdict({{ running: false, state: {json.dumps(x)} }}).level" for x in
                                    (V1_RUNNING, _read(st / "alpha.json"), V1_STOPPED, _read(st / "beta.json"), V1_FAILED, _read(st / "gamma.json"))) + "]", env)
    assert verdicts == ["FAIL", "FAIL", "INFO", "INFO", "FAIL", "FAIL"]

    before = {p.name: p.read_bytes() for p in st.iterdir()}
    assert _ps(migrate, env) == "3 0 0"
    assert {p.name: p.read_bytes() for p in st.iterdir()} == before


def test_phase_and_attestation_share_the_launch_block(rt):
    home, env = rt
    f = home / "state" / "alpha.json"
    _write(f, V1_RUNNING)
    _ps("Set-BotLaunchPhase -Bot alpha -Phase restarting -Updates @{ started_by = 'daemon-restart' }; 'ok'", env)
    s = _read(f)
    assert s["launch"]["phase"] == "restarting" and s["launch"]["nonce_sha256"] == ATTEST["nonce_sha256"] and s["started_by"] == "daemon-restart"
    assert "status" not in s and s["desired"]["state"] == "running"
    _ps("[void](New-LaunchNonce -Bot alpha); 'ok'", env)
    s = _read(f)
    assert s["launch"]["phase"] == "restarting" and s["launch"]["nonce_sha256"] != ATTEST["nonce_sha256"] and s["launch"]["consumed_at"] is None


def test_a_real_tick_persists_observed(rt, tmp_path):
    home, env = rt
    name = f"zz-s{secrets.token_hex(3)}"
    bh = tmp_path / "bots" / name
    bh.mkdir()
    # manual + janitor off: the tick never cold-starts it and runs nothing on this box
    (bh / "bot.yaml").write_text(f"name: {name}\nharness:\n  service: manual\n  modules:\n    telegram: false\n    janitor: false\n", encoding="utf-8")
    p = subprocess.Popen([sys.executable, "-c", ""])
    p.wait()
    dead = p.pid
    _write(home / "state" / f"{name}.json", {"bot": name, "status": "running", "claude_pid": dead, "service": "bg", "bg_id": ""})
    (home / "cockpit.json").write_text('{"enabled": false}', encoding="utf-8")
    _write(home / "state" / "daemon.json", {"update_check_at": time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime())})
    node = tmp_path / "fake-node" / "node.exe"
    node.parent.mkdir()
    shutil.copy2(Path(os.environ["SystemRoot"]) / "System32" / "cmd.exe", node)
    sink = subprocess.Popen([str(node), "/c", "ping -n 120 127.0.0.1 >nul"], creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        _write(home / "state" / "otel.json", {"pid": sink.pid})
        r = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(ASSEMBLY / "daemon" / "tick.ps1")],
                           capture_output=True, text=True, timeout=300, cwd=str(ASSEMBLY), env=env)
    finally:
        subprocess.run(["taskkill", "/PID", str(sink.pid), "/T", "/F"], capture_output=True)
    assert r.returncode == 0, r.stderr
    log = (home / "daemon.log").read_text(encoding="utf-8")
    assert "ACTION=START" not in log and "observe:" not in log, log[-2000:]
    assert "state file rewritten to schema v2" in log, "the tick migrates a v1 file before it observes"
    s = _read(home / "state" / f"{name}.json")
    assert "status" not in s and s["schema"] == 2
    o = s["observed"]
    assert o["bot"] == name and o["alive"] is False and o["activity"] == "down" and o["at"]


def test_phase_is_derived_from_observed_and_desired(rt):
    _home, env = rt
    now = 1_790_000_000_000
    iso = lambda ms: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ms / 1000))
    cases = [
        ({"desired": {"state": "running"}}, {"alive": True, "activity": "working"}, "working"),
        ({"desired": {"state": "running"}}, {"alive": True, "activity": "idle"}, "idle"),
        ({"desired": {"state": "running"}}, {"alive": True, "activity": "blocked"}, "blocked"),
        ({"desired": {"state": "running"}}, {"alive": True, "activity": "unknown"}, "unknown"),
        ({"desired": {"state": "running"}, "launch": {"phase": "restarting", "phase_at": iso(now - 60_000)}}, {"alive": False}, "starting"),
        ({"desired": {"state": "running"}, "launch": {"phase": "starting", "phase_at": iso(now - 600_000)}}, {"alive": False}, "down"),
        ({"desired": {"state": "stopped"}, "launch": {"phase": "up"}}, {"alive": False}, "stopped"),
        ({"desired": {"state": "running"}, "launch": {"phase": "exited", "exit_code": 0}}, {"alive": False}, "stopped"),
        ({"desired": {"state": "running"}, "launch": {"phase": "exited", "exit_code": 5}}, {"alive": False}, "down"),
        ({"desired": {"state": "running"}, "launch": {"phase": "up"}}, {"alive": False}, "down"),
        (None, {"alive": False}, "stopped"),
        ({"status": "running"}, {"alive": False}, "down"),                      # a v1 file reads the same
        ({"desired": {"state": "running"}, "observed": {"alive": True, "activity": "idle"}}, None, "idle"),   # the persisted record by default
    ]
    got = _node("[" + ",".join(f"s.phase({json.dumps(st)}, {'undefined' if o is None else json.dumps(o)}, {now})" for st, o, _ in cases) + "]", env)
    assert got == [want for _, _, want in cases]


def _free_port() -> int:
    import socket
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_a_dead_claude_reads_down_in_observe_and_the_cockpit(rt, tmp_path):
    import urllib.request
    home, env = rt
    name = f"zz-d{secrets.token_hex(3)}"
    bh = tmp_path / "bots" / name
    bh.mkdir()
    (bh / "bot.yaml").write_text(f"name: {name}\nharness:\n  service: manual\n  modules:\n    telegram: false\n", encoding="utf-8")
    p = subprocess.Popen([sys.executable, "-c", ""])
    p.wait()
    _write(home / "state" / f"{name}.json", {"bot": name, "schema": 2, "claude_pid": p.pid, "bg_id": "abc123",
                                             "desired": {"state": "running", "by": "daemon-cold", "at": "2026-09-01T10:00:00Z"},
                                             "launch": {"phase": "up", "phase_at": "2026-09-01T10:00:05Z", "exit_code": 0}})

    r = subprocess.run(["node", str(ASSEMBLY / "cli" / "botcorp.mjs"), "observe", name, "--json"], capture_output=True, text=True, timeout=120, cwd=str(ASSEMBLY), env=env)
    assert r.returncode == 0, r.stderr
    o = json.loads(r.stdout)
    assert o["bot"] == name and o["alive"] is False and o["activity"] == "down" and o["phase"] == "down" and o["claude_pid"] is None

    port = _free_port()
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
        page = urllib.request.urlopen(base + "/", timeout=30)
        cookie = page.headers["Set-Cookie"].split(";")[0]
        bot = json.loads(urllib.request.urlopen(urllib.request.Request(base + f"/api/bots/{name}", headers={"Cookie": cookie}), timeout=60).read())
    finally:
        subprocess.run(["taskkill", "/PID", str(srv.pid), "/T", "/F"], capture_output=True)
    assert bot["running"] is False and bot["activity"] == "down" and bot["phase"] == "down"
    assert "no live claude process" in bot["down"]
