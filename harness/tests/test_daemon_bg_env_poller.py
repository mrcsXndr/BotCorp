"""v0.1.5: a bg session's env, the transient Telegram token file, and a
Telegram poller that is measured instead of read back.

Locked behaviour (daemon/_common.ps1 dot-sourced under pwsh, cli/_lib.mjs
under node):
- Get-BgDaemonAction: no live daemon = spawn (claude --bg starts one with the
  launch's env), a live daemon with no live session = recycle, live sessions
  or an unreadable roster (-1) = inherit (never stopped from the launcher).
- Get-BgDaemon reads <config>/daemon.lock and never calls a dead pid, or a
  live pid that is not claude, a running daemon.
- ConvertFrom-BgRoster returns a FLAT array: the rows match by id and
  Test-BgAgentAlive sees their pid/state (the old parse nested the roster as
  one element, so neither ever worked); `[]` is an empty array, not $null.
- Complete-TgTokenFile deletes the token file whatever happened: once the
  plugin's bot.pid is alive under the given claude pid, after the wait runs
  out, and when bot.pid names a live process that is NOT below it.
- pollerVerdict: OWNED only with bot.pid alive under the bot's claude.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ASSEMBLY = Path(__file__).resolve().parents[2]
COMMON = ASSEMBLY / "daemon" / "_common.ps1"
LIB = (ASSEMBLY / "cli" / "_lib.mjs").as_uri()

needs_pwsh = pytest.mark.skipif(sys.platform != "win32" or shutil.which("pwsh") is None,
                                reason="Windows with pwsh on PATH")
needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="node not on PATH")


WINPS = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"


def _ps(body: str, timeout: int = 120, exe: str = "pwsh") -> str:
    """Dot-source _common.ps1, run `body`, return its (last) stdout line."""
    script = f". '{COMMON}'\n{body}"
    r = subprocess.run([exe, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
                       capture_output=True, text=True, timeout=timeout, cwd=str(ASSEMBLY))
    assert r.returncode == 0, r.stderr + r.stdout
    lines = [ln for ln in r.stdout.splitlines() if ln.strip()]
    assert lines, r.stderr
    return lines[-1]


def _node(expr: str) -> object:
    script = f"const m = await import({json.dumps(LIB)}); console.log(JSON.stringify({expr}));"
    r = subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, text=True,
                       timeout=120, cwd=str(ASSEMBLY))
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout.strip().splitlines()[-1])


@needs_pwsh
def test_daemon_action_truth_table():
    got = _ps("@((Get-BgDaemonAction -DaemonAlive $false -LiveWorkers 0), (Get-BgDaemonAction -DaemonAlive $false -LiveWorkers 3),"
              " (Get-BgDaemonAction -DaemonAlive $true -LiveWorkers 0), (Get-BgDaemonAction -DaemonAlive $true -LiveWorkers 1),"
              " (Get-BgDaemonAction -DaemonAlive $true -LiveWorkers -1)) -join ','")
    assert got == "spawn,spawn,recycle,inherit,inherit"


@needs_pwsh
def test_get_bg_daemon_reads_the_lock_and_guards_pid_reuse(tmp_path):
    cfg = tmp_path / "cfg"
    cfg.mkdir()
    # no lock at all
    assert _ps(f"$d = Get-BgDaemon -ConfigDir '{cfg}'; \"$($d.Alive) $($d.Pid)\"") == "False 0"
    # a lock naming a live process that is not claude (this pwsh itself)
    body = (f"@{{ pid = $PID; startedAt = 1790292870476; spawnedBy = @{{ pid = 42 }} }} | ConvertTo-Json | Set-Content '{cfg / 'daemon.lock'}';"
            f" $d = Get-BgDaemon -ConfigDir '{cfg}'; \"$($d.Alive) $($d.Pid -eq $PID) $($d.SpawnedByPid) $([bool]$d.StartedAt)\"")
    assert _ps(body) == "False True 42 True"
    # a lock naming a dead pid
    (cfg / "daemon.lock").write_text(json.dumps({"pid": 999999, "startedAt": 1}), encoding="utf-8")
    assert _ps(f"$d = Get-BgDaemon -ConfigDir '{cfg}'; \"$($d.Alive) $($d.Pid)\"") == "False 999999"


@needs_pwsh
@pytest.mark.parametrize("exe", ["pwsh", "winps"])
def test_roster_is_flat_so_rows_match_and_read_alive(exe):
    # Windows PowerShell 5.1 returns a JSON array from ConvertFrom-Json as ONE
    # object where pwsh 7 enumerates it; both must come out flat
    if exe == "winps":
        if not WINPS.is_file():
            pytest.skip("no Windows PowerShell 5.1")
        exe = str(WINPS)
    roster = json.dumps([
        {"id": "aaaa1111", "kind": "background", "sessionId": "s-1", "pid": None, "state": "stopped", "cwd": "C:\\x\\bots\\a"},
        {"id": "bbbb2222", "kind": "background", "sessionId": "s-2", "pid": None, "state": "blocked", "cwd": "C:\\x\\bots\\b"},
    ])
    body = (f"$a = ConvertFrom-BgRoster -Text 'backgrounded`n{roster}';"
            " $b = Find-BgAgent -Agents $a -BgId 'bbbb2222';"
            " $s = Find-BgAgent -Agents $a -SessionId 's-1';"
            " \"$($a.Count) $($a[0].GetType().Name) $($b.id) $(Test-BgAgentAlive $b) $($s.id) $(Test-BgAgentAlive $s)\"")
    assert _ps(body, exe=exe) == "2 PSCustomObject bbbb2222 True aaaa1111 False"
    # an empty roster is an empty array (known: none), not $null (unknown)
    assert _ps("$e = ConvertFrom-BgRoster -Text '[]'; \"$($null -eq $e) $(@($e).Count)\"", exe=exe) == "False 0"
    assert _ps("$e = ConvertFrom-BgRoster -Text 'no json here'; \"$($null -eq $e) $(@($e).Count)\"", exe=exe) == "False 0"


@needs_pwsh
def test_token_file_deleted_once_the_poller_is_up_under_claude(tmp_path):
    tok = tmp_path / ".env"
    tok.write_text("TELEGRAM_BOT_TOKEN=123456789:AAdummy\n", encoding="utf-8")
    pidf = tmp_path / "bot.pid"
    # a real child of this pwsh stands in for bun server.ts; this pwsh is "claude"
    body = (f"$c = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\\PING.EXE') -ArgumentList '-n','30','127.0.0.1' -WindowStyle Hidden -PassThru;"
            f" [IO.File]::WriteAllText('{pidf}', \"$($c.Id)\");"
            f" $r = Complete-TgTokenFile -TokenFile '{tok}' -BotPidFile '{pidf}' -ClaudePid $PID -TimeoutSec 10;"
            " Stop-Process -Id $c.Id -Force -ErrorAction SilentlyContinue;"
            " \"$($r.Up) $($r.Deleted) $($r.BotPid -eq $c.Id)\"")
    assert _ps(body) == "True True True"
    assert not tok.exists()


@needs_pwsh
def test_token_file_deleted_when_the_wait_runs_out(tmp_path):
    tok = tmp_path / ".env"
    tok.write_text("TELEGRAM_BOT_TOKEN=123456789:AAdummy\n", encoding="utf-8")
    body = (f"$r = Complete-TgTokenFile -TokenFile '{tok}' -BotPidFile '{tmp_path / 'absent.pid'}' -ClaudePid $PID -TimeoutSec 2;"
            " \"$($r.Up) $($r.Deleted) $($r.BotPid)\"")
    assert _ps(body) == "False True 0"
    assert not tok.exists()


@needs_pwsh
def test_token_file_deleted_when_bot_pid_is_not_below_claude(tmp_path):
    tok = tmp_path / ".env"
    tok.write_text("TELEGRAM_BOT_TOKEN=123456789:AAdummy\n", encoding="utf-8")
    pidf = tmp_path / "bot.pid"
    pidf.write_text(str(os.getpid()), encoding="utf-8")   # alive, but pytest is pwsh's PARENT
    body = (f"$r = Complete-TgTokenFile -TokenFile '{tok}' -BotPidFile '{pidf}' -ClaudePid $PID -TimeoutSec 2;"
            f" $p = Get-TgPoller -BotPidFile '{pidf}' -ClaudePid $PID;"
            " \"$($r.Up) $($r.Deleted) $($p.Alive) $($p.Up)\"")
    assert _ps(body) == "False True True False"
    assert not tok.exists()


@needs_pwsh
def test_debug_log_path_only_when_enabled(tmp_path):
    cfg = tmp_path / "cfg"
    got = _ps(f"\"[$(Get-DebugLogPath -ConfigDir '{cfg}' -Enabled $false -Stamp 's1')]|$(Get-DebugLogPath -ConfigDir '{cfg}' -Enabled $true -Stamp '20260925-010203')\"")
    off, on = got.split("|")
    assert off == "[]"
    assert Path(on) == cfg / "debug" / "20260925-010203.txt"


@needs_node
def test_harness_debug_defaults_off_and_must_be_boolean(tmp_path):
    botyaml = ASSEMBLY / "daemon" / "botyaml.mjs"

    def effective(text: str) -> dict:
        f = tmp_path / "bot.yaml"
        f.write_text(text, encoding="utf-8")
        r = subprocess.run(["node", str(botyaml), str(f)], capture_output=True, text=True, timeout=60)
        assert r.returncode == 0, r.stderr
        return json.loads(r.stdout)

    cfg = effective("name: alpha\n")
    assert cfg["harness"]["debug"] is False and cfg["_errors"] == []
    assert effective("name: alpha\nharness:\n  debug: true\n")["_errors"] == []
    assert any(e.startswith("harness.debug") for e in effective("name: alpha\nharness:\n  debug: yes-please\n")["_errors"])


@needs_node
def test_poller_verdict_truth_table():
    cases = [
        ({"alive": False, "telegram": True, "botPidAlive": False}, "none"),
        ({"alive": False, "telegram": True, "botPid": 7, "botPidAlive": True}, "ORPHAN"),
        ({"alive": True, "telegram": True, "recorded": "OWNED", "botPid": 0}, "DEAD"),
        ({"alive": True, "telegram": True, "recorded": "OWNED", "botPid": 7, "botPidAlive": False}, "DEAD"),
        ({"alive": True, "telegram": True, "recorded": "OWNED", "botPid": 7, "botPidAlive": True, "underClaude": False}, "DEAD"),
        ({"alive": True, "telegram": True, "recorded": "OWNED", "botPid": 7, "botPidAlive": True, "underClaude": True}, "OWNED"),
        ({"alive": True, "telegram": True, "recorded": "ALIVE", "botPid": 7, "botPidAlive": True, "underClaude": None}, "UNKNOWN"),
        ({"alive": True, "telegram": True, "recorded": "FOREIGN"}, "FOREIGN"),
        ({"alive": True, "telegram": False, "recorded": "NONE"}, "NONE"),
    ]
    got = _node(f"{json.dumps([c for c, _ in cases])}.map((c) => m.pollerVerdict(c))")
    assert got == [want for _, want in cases]


@needs_node
def test_is_descendant_walks_parents_and_stops_on_a_cycle():
    tree = {"500": 400, "400": 300, "300": 200, "900": 900, "901": 902, "902": 901}
    got = _node(f"[m.isDescendant({json.dumps(tree)}, 500, 300), m.isDescendant({json.dumps(tree)}, 500, 500),"
                f" m.isDescendant({json.dumps(tree)}, 300, 500), m.isDescendant({json.dumps(tree)}, 900, 1),"
                f" m.isDescendant({json.dumps(tree)}, 901, 5), m.isDescendant(null, 1, 1)]")
    assert got == [True, True, False, False, False, False]


@needs_node
def test_process_parents_knows_this_process():
    got = _node("(() => { const p = m.processParents(); return p ? { self: p.has(process.pid), parent: p.get(process.pid) === process.ppid } : null; })()")
    assert got == {"self": True, "parent": True}
