"""D8: a failed roster read (`claude agents --json` -> $null) is unknown, not "none".

A bg bot whose claude_pid went stale (the supervisor restarted the worker) and
whose roster read failed was cold-started on the spot, and the cold-start kills
the bot.pid holder: the LIVE session's poller.

Locked behaviour:
- the tick defers the cold-start while the roster read fails, logs
  `roster unknown, deferring`, counts the failed reads in state roster_unknown,
  and cold-starts only on the third in a row; a known read resets the count;
- launch.ps1's duplicate guard refuses a manual/cli start when the roster read
  fails for a recorded bg_id, and lets the daemon's own starts through.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

ASSEMBLY = Path(__file__).resolve().parents[2]

pytestmark = pytest.mark.skipif(sys.platform != "win32" or shutil.which("pwsh") is None or shutil.which("node") is None,
                                reason="Windows with pwsh and node on PATH")


def _dead_pid() -> int:
    p = subprocess.Popen([sys.executable, "-c", ""])
    p.wait(timeout=60)
    return p.pid


@pytest.fixture
def box(tmp_path):
    rt, bots = tmp_path / "rt", tmp_path / "bots"
    (rt / "state").mkdir(parents=True)
    home = bots / "rx"
    (home / ".claude-rx").mkdir(parents=True)
    (home / "bot.yaml").write_text("name: rx\nharness:\n  modules:\n    telegram: false\n    janitor: false\n    usage_resume: false\n", encoding="utf-8")
    # a claude.exe that cannot start: every roster read fails
    stand_in = tmp_path / "claude.exe"
    stand_in.write_bytes(b"not a program")
    now = time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime())
    (rt / "cockpit.json").write_text('{"enabled": false}', encoding="utf-8")
    (rt / "state" / "daemon.json").write_text(json.dumps({"update_check_at": now, "cc_check_at": now}), encoding="utf-8")
    state = rt / "state" / "rx.json"
    state.write_text(json.dumps({"bot": "rx", "service": "bg", "claude_pid": _dead_pid(), "bg_id": "abc123", "session_id": "S1",
                                 "started_at": "2000-01-01T00:00:00+00:00"}), encoding="utf-8")
    env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE", "TELEGRAM_", "BOT_"))}
    env.update({"BOTCORP_HOME": str(rt), "BOTCORP_BOTS_DIR": str(bots), "BOTCORP_ROOT": str(ASSEMBLY), "BOTCORP_CLAUDE_EXE": str(stand_in),
                "BOTCORP_DAEMON_MUTEX": f"Global\\BotCorpDaemon-test-{os.urandom(8).hex()}", "BOT_TG_MUTE": "1"})
    node = tmp_path / "fake-node" / "node.exe"
    node.parent.mkdir()
    shutil.copy2(Path(os.environ["SystemRoot"]) / "System32" / "cmd.exe", node)
    sink = subprocess.Popen([str(node), "/c", "ping -n 300 127.0.0.1 >nul"], creationflags=subprocess.CREATE_NO_WINDOW)
    (rt / "state" / "otel.json").write_text(json.dumps({"pid": sink.pid}), encoding="utf-8")
    try:
        yield {"rt": rt, "env": env, "state": state}
    finally:
        subprocess.run(["taskkill", "/PID", str(sink.pid), "/T", "/F"], capture_output=True)


def _tick(b, *extra) -> str:
    r = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(ASSEMBLY / "daemon" / "tick.ps1"), *extra],
                       capture_output=True, text=True, timeout=300, cwd=str(ASSEMBLY), env=b["env"])
    assert r.returncode == 0, r.stderr
    return "\n".join((b["rt"] / p).read_text(encoding="utf-8-sig") for p in ("daemon.log", "logs/rx/daemon.log") if (b["rt"] / p).exists())


def _count(b):
    return json.loads(b["state"].read_text(encoding="utf-8-sig")).get("roster_unknown")


def test_the_tick_defers_an_unknown_roster_then_cold_starts_on_the_third(box):
    log = _tick(box)
    assert "roster=unknown" in log and "roster unknown, deferring (1/3" in log, log[-3000:]
    assert "ACTION=START" not in log, log[-3000:]
    assert _count(box) == 1
    log = _tick(box)
    assert "roster unknown, deferring (2/3" in log and "ACTION=START" not in log, log[-3000:]
    assert _count(box) == 2
    # the third failed read in a row: the cold-start goes ahead (a dry run: nothing launched, nothing recorded)
    log = _tick(box, "-DryRun")
    assert "DRYRUN would cold-start rx" in log, log[-3000:]
    assert _count(box) == 2


def test_a_live_session_resets_the_count(box, tmp_path):
    # a live process named claude.exe is the session: liveness is known, the count goes
    exe = tmp_path / "live" / "claude.exe"
    exe.parent.mkdir()
    shutil.copy2(Path(os.environ["SystemRoot"]) / "System32" / "cmd.exe", exe)
    p = subprocess.Popen([str(exe), "/c", "ping -n 300 127.0.0.1 >nul"], creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        st = json.loads(box["state"].read_text(encoding="utf-8"))
        st.update({"roster_unknown": 2, "claude_pid": p.pid})
        box["state"].write_text(json.dumps(st), encoding="utf-8")
        log = _tick(box)
        assert "alive=True" in log and "ACTION=START" not in log, log[-3000:]
        assert _count(box) is None
    finally:
        subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"], capture_output=True)


def _launch(b, started_by: str, *extra: str) -> str:
    r = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(ASSEMBLY / "daemon" / "launch.ps1"),
                        "-Bot", "rx", "-Bg", "-DryRun", "-StartedBy", started_by, *extra],
                       capture_output=True, text=True, timeout=300, cwd=str(ASSEMBLY), env=b["env"])
    assert r.returncode == 0, r.stderr
    return r.stdout


def test_launch_refuses_a_manual_start_on_an_unknown_roster(box):
    out = _launch(box, "cli")
    assert "roster read failed - refusing a possible duplicate" in out, out
    assert not any(ln.strip().startswith("argv:") for ln in out.splitlines()), out
    out = _launch(box, "daemon-cold")
    assert "refusing a possible duplicate" not in out, out


def test_botcorp_restart_starts_on_an_unknown_roster(box):
    # `botcorp restart` stopped the session itself (stop.ps1) before it starts
    # again: refusing then left a live bot down (2026-10-01).
    out = _launch(box, "cli", "-AfterStop")
    assert "refusing a possible duplicate" not in out, out
