"""D9: the session-0 stray sweep must not kill a live session's tool call.

It killed any session-0 pwsh older than 10 min naming the bot folder: a bg
session's own long PowerShell tool call matched every exclusion, and a prefix
match made bots\\x-mirror count as bots\\x.

Locked behaviour (Get-StrayShells, the tick's pick; Get-ProcessOwnerRecord):
- a shell under a claude.exe is never a stray;
- bots\\x matches only the whole folder, never bots\\x-mirror;
- a plain old shell naming the folder is still picked.
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
COMMON = ASSEMBLY / "daemon" / "_common.ps1"

pytestmark = pytest.mark.skipif(sys.platform != "win32" or shutil.which("pwsh") is None, reason="Windows with pwsh on PATH")


def _ps(body: str, env: dict) -> str:
    r = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", f". '{COMMON}'\n{body}"],
                       capture_output=True, text=True, timeout=180, cwd=str(ASSEMBLY), env=env)
    assert r.returncode == 0, r.stderr + r.stdout
    return [ln for ln in r.stdout.splitlines() if ln.strip()][-1]


def _shell(cmdline_path: Path, parent: Path | None = None) -> subprocess.Popen:
    ps = f"Start-Sleep 120 # '{cmdline_path}'"
    if parent:   # cmd copy named claude.exe -> pwsh: a tool call of a live session
        return subprocess.Popen(f'"{parent}" /c pwsh -NoProfile -NonInteractive -Command "{ps}"', creationflags=subprocess.CREATE_NO_WINDOW)
    return subprocess.Popen(["pwsh", "-NoProfile", "-NonInteractive", "-Command", ps], creationflags=subprocess.CREATE_NO_WINDOW)


def _pwsh_under(pid: int) -> int:
    for _ in range(100):
        out = subprocess.run(["pwsh", "-NoProfile", "-Command", f"(Get-CimInstance Win32_Process -Filter 'ParentProcessId={pid}' | Where-Object Name -eq 'pwsh.exe').ProcessId"],
                             capture_output=True, text=True, timeout=60).stdout.strip()
        if out.isdigit():
            return int(out)
        time.sleep(0.2)
    raise AssertionError("pwsh child did not start")


def test_a_tool_call_and_a_mirror_folder_are_not_strays(tmp_path):
    bots = tmp_path / "bots"
    (bots / "sx").mkdir(parents=True)
    (bots / "sx" / "bot.yaml").write_text("name: sx\n", encoding="utf-8")
    rt = tmp_path / "rt"
    (rt / "state").mkdir(parents=True)
    env = {**os.environ, "BOTCORP_HOME": str(rt), "BOTCORP_BOTS_DIR": str(bots)}
    claude = tmp_path / "claude.exe"
    shutil.copy2(Path(os.environ["SystemRoot"]) / "System32" / "cmd.exe", claude)
    procs = []
    try:
        stray = _shell(bots / "sx" / "launch.log"); procs.append(stray)
        mirror = _shell(bots / "sx-mirror" / "x"); procs.append(mirror)
        host = _shell(bots / "sx" / "tool.ps1", parent=claude); procs.append(host)
        tool = _pwsh_under(host.pid)
        time.sleep(1)
        body = (f"$all = Get-CimInstance Win32_Process\n"
                f"$sid = (Get-Process -Id {stray.pid}).SessionId\n"
                f"$picked = @(Get-StrayShells -All $all -BotDir (Join-Path $script:BotsDir 'sx') -SessionId $sid -MinAgeMin 0 | ForEach-Object {{ $_.Pid }})\n"
                f"$blind = @(Get-StrayShells -All @($all | Where-Object Name -ne 'claude.exe') -BotDir (Join-Path $script:BotsDir 'sx') -SessionId $sid -MinAgeMin 0 | ForEach-Object {{ $_.Pid }})\n"
                f"$own = Get-ProcessOwnerRecord -ProcId {mirror.pid}\n"
                "[pscustomobject]@{ picked = $picked; blind = $blind; mirrorOurs = $own.Ours; mirrorBot = $own.Bot } | ConvertTo-Json -Compress")
        got = json.loads(_ps(body, env))
        picked = got["picked"] if isinstance(got["picked"], list) else [got["picked"]]
        blind = got["blind"] if isinstance(got["blind"], list) else [got["blind"]]
        assert stray.pid in picked, got
        assert tool not in picked, "a live session's tool call is never a stray"
        assert tool in blind, "control: without its claude.exe parent the same shell is picked"
        assert mirror.pid not in picked, "bots\\sx-mirror is not bots\\sx"
        assert got["mirrorOurs"] is False, got
    finally:
        for p in procs:
            subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"], capture_output=True)
