"""v0.9.13: a deaf Telegram poller is found without touching the slot.

The tick only knew that the plugin's bot.pid was alive under claude (OWNED).
A plugin that left its poll loop after repeated 409s stays alive and deaf, and
the getUpdates probe that could see it interrupts the live poller, so it is
opt-in. A polling plugin always holds its long-poll connection; a deaf one
holds none. Locked behaviour:
- Get-TgLinkVerdict (_common.ps1): deaf after 3 ticks in a row with no
  established connection while Telegram is reachable; any connection resets
  the count; unmeasurable or unreachable keeps it;
- Get-TgLinkCount reads the local TCP table: 0 for a process without
  connections, >= 1 for one holding a connection (the positive control);
- a real dry-run tick with an OWNED poller that holds no connection on its
  third tick decides to restart it (the DEAD poller's heal); on the first, no
  action. Nothing is sent to Telegram: reachability is a TCP connect to a
  loopback stand-in (BOTCORP_TG_API_BASE).
"""
from __future__ import annotations

import json
import os
import secrets
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

ASSEMBLY = Path(__file__).resolve().parents[2]
COMMON = ASSEMBLY / "daemon" / "_common.ps1"
needs_win = pytest.mark.skipif(sys.platform != "win32" or shutil.which("pwsh") is None, reason="Windows + pwsh")


def _ps(body: str, env: dict | None = None) -> str:
    r = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", f". '{COMMON}'\n{body}"],
                       capture_output=True, text=True, timeout=180, cwd=str(ASSEMBLY), env=env)
    assert r.returncode == 0, r.stderr
    return r.stdout.strip().splitlines()[-1]


@needs_win
def test_the_verdict_needs_three_quiet_reachable_ticks():
    cases = [
        "Get-TgLinkVerdict -Conns 0 -Reachable $true -Misses 0",     # 1st quiet tick
        "Get-TgLinkVerdict -Conns 0 -Reachable $true -Misses 1",     # 2nd
        "Get-TgLinkVerdict -Conns 0 -Reachable $true -Misses 2",     # 3rd: deaf
        "Get-TgLinkVerdict -Conns 1 -Reachable $true -Misses 2",     # a connection resets
        "Get-TgLinkVerdict -Conns 0 -Reachable $false -Misses 2",    # an outage is not counted
        "Get-TgLinkVerdict -Conns $null -Reachable $true -Misses 2",  # unmeasurable: no verdict
    ]
    body = "$o = @(); " + "; ".join(f"$v = {c}; $o += \"$($v.Misses)/$($v.Deaf)\"" for c in cases) + "; $o -join ','"
    assert _ps(body) == "1/False,2/False,3/True,0/False,2/False,2/False"


@needs_win
def test_the_link_count_reads_the_tcp_table(tmp_path):
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)
    port = srv.getsockname()[1]
    holder = subprocess.Popen([sys.executable, "-c", f"import socket,time; s=socket.create_connection(('127.0.0.1',{port})); time.sleep(60)"])
    idle = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    try:
        conn, _ = srv.accept()
        got = _ps(f"\"$(Get-TgLinkCount -ProcId {holder.pid})|$(Get-TgLinkCount -ProcId {idle.pid})|$($null -eq (Get-TgLinkCount -ProcId 0))\"")
        conn.close()
    finally:
        for p in (holder, idle):
            p.kill()
        srv.close()
    held, none, unmeasurable = got.split("|")
    assert int(held) >= 1 and none == "0" and unmeasurable == "True", got


@pytest.fixture
def deaf_bot(tmp_path):
    name = f"zz-l{secrets.token_hex(3)}"
    bots = tmp_path / "bots"
    home = bots / name
    (home / f".claude-{name}" / "channels" / "telegram").mkdir(parents=True)
    (home / "bot.yaml").write_text(f"name: {name}\nharness:\n  service: manual\n  modules:\n    telegram: true\n    janitor: false\n"
                                   "    usage_resume: false\n", encoding="utf-8")
    rt = tmp_path / "rt"
    (rt / "state").mkdir(parents=True)
    env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE", "TELEGRAM_", "BOT_"))}
    env.update(BOTCORP_HOME=str(rt), BOTCORP_BOTS_DIR=str(bots), BOT_TG_MUTE="1",
               BOTCORP_DAEMON_MUTEX=f"Global\\BotCorpDaemon-test-{secrets.token_hex(8)}")
    return name, home, rt, env


def _tick(name, home, rt, env, tmp_path, misses, extra_state=None):
    srv = socket.socket()                       # the reachable "Bot API": a TCP connect, nothing else
    srv.bind(("127.0.0.1", 0))
    srv.listen(8)
    env = dict(env, BOTCORP_TG_API_BASE=f"http://127.0.0.1:{srv.getsockname()[1]}")
    exe = tmp_path / "claude.exe"               # an alive "claude" whose child is the plugin (bot.pid), with no connection
    shutil.copy2(Path(os.environ["SystemRoot"]) / "System32" / "cmd.exe", exe)
    fake = subprocess.Popen([str(exe), "/c", "ping -n 200 127.0.0.1 >nul"], creationflags=subprocess.CREATE_NO_WINDOW)
    node = tmp_path / "fake-node" / "node.exe"
    node.parent.mkdir(exist_ok=True)
    shutil.copy2(Path(os.environ["SystemRoot"]) / "System32" / "cmd.exe", node)
    sink = subprocess.Popen([str(node), "/c", "ping -n 200 127.0.0.1 >nul"], creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        plugin = 0
        for _ in range(50):
            out = subprocess.run(["pwsh", "-NoProfile", "-Command", f"(Get-CimInstance Win32_Process -Filter 'ParentProcessId={fake.pid}' | Where-Object Name -eq 'PING.EXE').ProcessId"],
                                 capture_output=True, text=True, timeout=60).stdout.strip()
            if out:
                plugin = int(out.splitlines()[0])
                break
            time.sleep(0.2)
        assert plugin, "the fake plugin process never started"
        (home / f".claude-{name}" / "channels" / "telegram" / "bot.pid").write_text(str(plugin), encoding="utf-8")
        old = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 3600))
        (rt / "state" / f"{name}.json").write_text(json.dumps({"bot": name, "claude_pid": fake.pid, "status": "running", "service": "bg",
                                                                "bg_id": "", "started_at": old, "poller": "OWNED", "tg_link_miss": misses, **(extra_state or {})}), encoding="utf-8")
        (rt / "cockpit.json").write_text('{"enabled": false}', encoding="utf-8")
        (rt / "state" / "daemon.json").write_text(json.dumps({"update_check_at": time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime())}), encoding="utf-8")
        (rt / "state" / "otel.json").write_text(json.dumps({"pid": sink.pid}), encoding="utf-8")
        r = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(ASSEMBLY / "daemon" / "tick.ps1"), "-DryRun"],
                           capture_output=True, text=True, timeout=400, cwd=str(ASSEMBLY), env=env)
    finally:
        for p in (fake, sink):
            subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"], capture_output=True)
        srv.close()
    assert r.returncode == 0, r.stderr
    return [ln for ln in (rt / "daemon.log").read_text(encoding="utf-8").splitlines() if f"[{name}]" in ln]


@needs_win
def test_a_tick_heals_a_poller_quiet_for_three_ticks(deaf_bot, tmp_path):
    name, home, rt, env = deaf_bot
    lines = _tick(name, home, rt, env, tmp_path, misses=2)
    assert any("state: alive=True" in ln and "poller=OWNED" in ln for ln in lines), lines
    assert any("tg link: poller bot.pid=" in ln and "(3/3) -> deaf" in ln for ln in lines), lines
    assert any(f"DRYRUN would restart {name}" in ln and "poller deaf" in ln for ln in lines), lines


@needs_win
def test_the_first_quiet_tick_is_no_action(deaf_bot, tmp_path):
    name, home, rt, env = deaf_bot
    lines = _tick(name, home, rt, env, tmp_path, misses=0)
    assert any("tg link: poller bot.pid=" in ln and "(1/3)" in ln for ln in lines), lines   # positive control: measured
    assert not any("would restart" in ln for ln in lines), lines


@needs_win
def test_still_deaf_after_a_deaf_restart_is_not_restarted_again(deaf_bot, tmp_path):
    # a revoked token or a stolen slot leaves the new plugin deaf too: one restart per episode, not a loop into the start cap
    name, home, rt, env = deaf_bot
    lines = _tick(name, home, rt, env, tmp_path, misses=2, extra_state={"tg_deaf_restarted": 1})
    assert any("(3/3) -> deaf" in ln for ln in lines), lines                                 # positive control: still measured deaf
    assert any("still deaf after a deaf restart" in ln for ln in lines), lines
    assert not any("would restart" in ln for ln in lines), lines
