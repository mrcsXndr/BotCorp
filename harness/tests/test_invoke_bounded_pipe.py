"""Code review 2026-09-30, D16: Invoke-Bounded (daemon/_common.ps1) bounds the
child, and it must bound the read of its output too. A grandchild that inherited
the redirected stdout (as `claude --bg` starting its supervisor does) keeps the
pipe open after the child exits; reading it with no timeout hung the tick while
it held the global mutex.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

ASSEMBLY = Path(__file__).resolve().parents[2]
COMMON = ASSEMBLY / "daemon" / "_common.ps1"

pytestmark = pytest.mark.skipif(sys.platform != "win32" or shutil.which("pwsh") is None, reason="Windows with pwsh on PATH")


def _env(tmp_path: Path) -> dict:
    env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE", "TELEGRAM_", "BOT_"))}
    env.update({"BOTCORP_HOME": str(tmp_path / "rt"), "BOTCORP_BOTS_DIR": str(tmp_path / "bots"), "BOTCORP_ROOT": str(ASSEMBLY), "BOT_TG_MUTE": "1"})
    (tmp_path / "rt" / "state").mkdir(parents=True, exist_ok=True)
    (tmp_path / "bots").mkdir(exist_ok=True)
    return env


def test_a_grandchild_holding_the_pipe_does_not_hang_the_caller(tmp_path):
    # cmd prints a line, starts ping in the background (it inherits stdout), and exits at once.
    body = (f". '{COMMON}'\n"
            "$sw = [Diagnostics.Stopwatch]::StartNew()\n"
            "$r = Invoke-Bounded -Exe $env:ComSpec -Arguments @('/d', '/c', 'echo first & start /b ping -n 40 127.0.0.87') -TimeoutSec 20 -Label 'pipe test' -Capture\n"
            "Write-Output \"ELAPSED=$([int]$sw.Elapsed.TotalSeconds) EXIT=$($r.ExitCode) KILLED=$($r.Killed)\"\n"
            "Get-CimInstance Win32_Process -Filter \"Name='PING.EXE'\" | Where-Object { $_.CommandLine -match '127\\.0\\.0\\.87' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }")
    t0 = time.monotonic()
    r = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", body],
                       env=_env(tmp_path), capture_output=True, text=True, timeout=120)
    wall = time.monotonic() - t0
    out = r.stdout
    assert "EXIT=0" in out and "KILLED=False" in out, out + r.stderr
    elapsed = int(out.split("ELAPSED=")[1].split()[0])
    # ping runs ~39 s; the bounded read gives up after a few seconds
    assert elapsed < 20, f"Invoke-Bounded waited {elapsed}s on a pipe the child no longer owned (wall {wall:.0f}s)"
