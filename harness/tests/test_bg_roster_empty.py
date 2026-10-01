"""An EMPTY background roster is known-empty, never "unknown".

`Get-BgAgents` used `return (ConvertFrom-BgRoster ...)`, which PowerShell
unrolls: an empty roster (`claude agents --json` printing `[]`, i.e. a stopped
bot) came back as $null, the "unknown" value. So the daemon deferred every
cold-start of a stopped bg bot by 3 ticks and launch.ps1 refused every manual
start or restart (a live bot stayed down after `botcorp restart`, 2026-10-01).
Unparsable output must still read as unknown.
"""
from __future__ import annotations

import os
import subprocess

from test_automation_python import ASSEMBLY, needs_win

PWSH = ["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"]


def _roster(tmp_path, printed: str) -> str:
    fake = tmp_path / "claude.cmd"
    fake.write_text(f"@echo off\r\necho {printed}\r\n", encoding="utf-8")
    home = tmp_path / "bot"
    (home / ".claude-x").mkdir(parents=True)
    script = (
        f". '{ASSEMBLY / 'daemon' / '_common.ps1'}' *> $null; "
        f"$P = @{{ ConfigDir = '{home / '.claude-x'}'; BotHome = '{home}' }}; "
        "$a = Get-BgAgents -Bot x -Paths $P -TimeoutSec 30; "
        "if ($null -eq $a) { 'UNKNOWN' } else { 'COUNT=' + @($a).Count }"
    )
    env = {**os.environ, "BOTCORP_CLAUDE_EXE": str(fake)}
    r = subprocess.run(PWSH + [script], capture_output=True, text=True, timeout=120, env=env, cwd=str(ASSEMBLY))
    return r.stdout.strip().splitlines()[-1] if r.stdout.strip() else r.stderr


@needs_win  # the stand-in claude is a .cmd
def test_an_empty_roster_is_known_empty(tmp_path):
    assert _roster(tmp_path, "[]") == "COUNT=0"


@needs_win
def test_a_one_row_roster_keeps_its_row(tmp_path):
    assert _roster(tmp_path, '[{"id":"a1","pid":1}]') == "COUNT=1"
