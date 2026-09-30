"""v0.8.6 R9: the daemon probes getUpdates while the poller reads OWNED.

Locked behaviour:
- Get-TgSlotHealth: 401/404 = rejected; a 409 = ok, or stolen when the
  plugin's own process has no connection to Telegram (never on "not
  measurable"); only 200s = deaf; anything else = unknown;
- Test-TgConnection: $null without a pid, $false for a process with no
  connection to the host, $true for one with an established connection;
- a real tick with a live OWNED poller probes with the vault token (codes
  only, no offset), counts bad probes in a row, and on the second sends ONE
  CRITICAL line through tg_send.py --alert (alerts.log); the next bad probe
  within BOT_TG_ALERT_EVERY_MIN (120) is held, not sent again.
"""
from __future__ import annotations

import http.server
import json
import os
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

ASSEMBLY = Path(__file__).resolve().parents[2]
COMMON = ASSEMBLY / "daemon" / "_common.ps1"

needs_pwsh = pytest.mark.skipif(sys.platform != "win32" or shutil.which("pwsh") is None or shutil.which("node") is None,
                                reason="Windows with pwsh and node on PATH")


def _ps(body: str) -> str:
    r = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", f". '{COMMON}'\n{body}"],
                       capture_output=True, text=True, timeout=120, cwd=str(ASSEMBLY))
    assert r.returncode == 0, r.stderr
    return r.stdout.strip().splitlines()[-1]


@needs_pwsh
def test_slot_health_reads_the_probe_codes():
    cases = [
        ("@(200, 409)", "$null", "ok"),
        ("@(200, 409)", "$true", "ok"),
        ("@(200, 409)", "$false", "stolen"),
        ("@(200, 200, 200, 200)", "$null", "deaf"),
        ("@(200, 200, 200, 200)", "$true", "deaf"),
        ("@(401)", "$null", "rejected"),
        ("@(200, 404)", "$null", "rejected"),
        ("@(200, 0)", "$null", "unknown"),
        ("@()", "$null", "unknown"),
    ]
    body = "$o = @(); " + "; ".join(f"$o += (Get-TgSlotHealth -Codes {c} -OwnConn {own})" for c, own, _ in cases) + "; $o -join ','"
    assert _ps(body) == ",".join(w for _, _, w in cases)


@needs_pwsh
def test_connection_check_sees_an_established_connection():
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)
    cli = socket.create_connection(srv.getsockname())
    conn, _ = srv.accept()
    try:
        # this process holds a connection to 127.0.0.1 (positive control); pid 0 is not measurable
        got = _ps(f"\"$(Test-TgConnection -ProcId {os.getpid()} -HostName '127.0.0.1')|$($null -eq (Test-TgConnection -ProcId 0))\"")
        assert got == "True|True"
    finally:
        cli.close()
        conn.close()
        srv.close()
    idle = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    try:
        assert _ps(f"Test-TgConnection -ProcId {idle.pid} -HostName '127.0.0.1'") == "False"
    finally:
        idle.kill()


class _Tg(http.server.BaseHTTPRequestHandler):
    paths: list = []

    def do_GET(self):  # noqa: N802
        type(self).paths.append(self.path)
        body = json.dumps({"ok": True, "result": []}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


@pytest.fixture
def live_bot(tmp_path):
    """A bot in a temp bots dir, alive (a process named claude.exe) with an
    OWNED poller (its child is bot.pid), a telegram_token in the vault, and a
    runtime home whose cockpit / update check / otel sink need nothing."""
    name = f"zz-t{secrets.token_hex(3)}"
    home = tmp_path / "bots" / name
    home.mkdir(parents=True)
    rt = tmp_path / "rt"
    (rt / "state").mkdir(parents=True)
    env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE", "TELEGRAM_", "BOT_"))}
    env.update({"BOTCORP_HOME": str(rt), "BOTCORP_BOTS_DIR": str(tmp_path / "bots"), "BOT_TG_MUTE": "1",
                "BOTCORP_DAEMON_MUTEX": f"Global\\BotCorpDaemon-test-{secrets.token_hex(8)}"})
    (home / "bot.yaml").write_text(f"name: {name}\nharness:\n  service: manual\n  modules:\n    telegram: true\n    janitor: false\n"
                                   "    usage_resume: false\n", encoding="utf-8")
    r = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
                        f". '{ASSEMBLY / 'daemon' / 'vault.ps1'}'; [void](Set-VaultSecret -BotHome '{home}' -Bot '{name}' -Key telegram_token -Value 'not-a-real-value')"],
                       capture_output=True, text=True, timeout=120, cwd=str(ASSEMBLY), env=env)
    assert r.returncode == 0, r.stderr
    exe = tmp_path / "claude.exe"
    shutil.copy2(Path(os.environ["SystemRoot"]) / "System32" / "cmd.exe", exe)
    fake = subprocess.Popen([str(exe), "/c", "ping -n 300 127.0.0.1 >nul"], creationflags=subprocess.CREATE_NO_WINDOW)
    node = tmp_path / "fake-node" / "node.exe"
    node.parent.mkdir()
    shutil.copy2(Path(os.environ["SystemRoot"]) / "System32" / "cmd.exe", node)
    sink = subprocess.Popen([str(node), "/c", "ping -n 300 127.0.0.1 >nul"], creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        child = 0
        for _ in range(50):
            out = subprocess.run(["pwsh", "-NoProfile", "-Command", f"(Get-CimInstance Win32_Process -Filter 'ParentProcessId={fake.pid}' | Where-Object Name -eq 'PING.EXE').ProcessId"],
                                 capture_output=True, text=True, timeout=60).stdout.strip()
            if out.isdigit():
                child = int(out)
                break
            time.sleep(0.2)
        assert child, "fake poller child did not start"
        tg = home / f".claude-{name}" / "channels" / "telegram"
        tg.mkdir(parents=True)
        (tg / "bot.pid").write_text(f"{child}\n", encoding="utf-8")
        (rt / "cockpit.json").write_text('{"enabled": false}', encoding="utf-8")
        (rt / "state" / "daemon.json").write_text(json.dumps({"update_check_at": time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime())}), encoding="utf-8")
        (rt / "state" / "otel.json").write_text(json.dumps({"pid": sink.pid}), encoding="utf-8")
        yield name, home, rt, env, fake.pid
    finally:
        for p in (fake, sink):
            subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"], capture_output=True)


def _tick(env):
    return subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(ASSEMBLY / "daemon" / "tick.ps1")],
                          capture_output=True, text=True, timeout=400, cwd=str(ASSEMBLY), env=env)


@needs_pwsh
def test_a_deaf_owned_poller_alerts_once_per_window(live_bot):
    name, home, rt, env, claude_pid = live_bot
    state = rt / "state" / f"{name}.json"
    # one bad probe already counted: this tick's is the second in a row
    state.write_text(json.dumps({"bot": name, "claude_pid": claude_pid, "status": "running", "poller": "OWNED", "service": "bg", "bg_id": "",
                                 "tg_probe_bad": 1}), encoding="utf-8")
    _Tg.paths = []
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Tg)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    env = {**env, "BOTCORP_TG_API_BASE": f"http://127.0.0.1:{srv.server_address[1]}", "BOT_TG_PROBE_EVERY_MIN": "0"}
    try:
        r = _tick(env)
        assert r.returncode == 0, r.stderr
        log = (rt / "daemon.log").read_text(encoding="utf-8")
        assert f"[{name}] tg probe: deaf (codes 200,200,200,200; bad 2/2)" in log, log[-3000:]
        assert f"[{name}] tg alert sent" in log, log[-3000:]
        alerts = (home / "memory" / "metrics" / "alerts.log").read_text(encoding="utf-8")
        assert alerts.count("CRITICAL") == 1 and "inbound Telegram is down" in alerts, alerts
        assert _Tg.paths and all(p == "/botnot-a-real-value/getUpdates?timeout=0&limit=1" for p in _Tg.paths), _Tg.paths
        assert "not-a-real-value" not in log
        st = json.loads(state.read_text(encoding="utf-8"))
        assert st["tg_probe_bad"] == 2 and st["tg_probe_health"] == "deaf" and st.get("tg_alert_at")

        r = _tick(env)   # still deaf: counted, but the alert is held for the window
        assert r.returncode == 0, r.stderr
        log = (rt / "daemon.log").read_text(encoding="utf-8")
        assert "bad 3/2" in log and f"[{name}] tg alert held" in log, log[-3000:]
        assert (home / "memory" / "metrics" / "alerts.log").read_text(encoding="utf-8").count("CRITICAL") == 1
    finally:
        srv.shutdown()


@needs_pwsh
def test_the_probe_is_off_unless_the_interval_is_set(live_bot):
    # it interrupts the plugin's own long-poll; opt-in until measured on a live bot
    name, home, rt, env, claude_pid = live_bot
    state = rt / "state" / f"{name}.json"
    state.write_text(json.dumps({"bot": name, "claude_pid": claude_pid, "status": "running", "poller": "OWNED", "service": "bg", "bg_id": "",
                                 "tg_probe_bad": 1}), encoding="utf-8")
    _Tg.paths = []
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Tg)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    env = {k: v for k, v in env.items() if k != "BOT_TG_PROBE_EVERY_MIN"}
    env["BOTCORP_TG_API_BASE"] = f"http://127.0.0.1:{srv.server_address[1]}"
    try:
        r = _tick(env)
        assert r.returncode == 0, r.stderr
        assert _Tg.paths == [], _Tg.paths
        assert "tg probe:" not in (rt / "daemon.log").read_text(encoding="utf-8")
    finally:
        srv.shutdown()
