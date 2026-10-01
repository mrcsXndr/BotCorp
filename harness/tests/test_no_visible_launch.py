"""(v0.9.11) The visible launch mode is gone: no BotCorp-Launch task, no launch-visible.ps1.

- daemon/launch-visible.ps1 is deleted and nothing in the daemon, CLI or cockpit
  starts it, writes its launch-request.json or calls Start-VisibleLaunchTask;
  install.ps1 registers the daemon task only (-Unregister still removes a
  BotCorp-Launch task left from before).
- tick.ps1's Start-BotCold (lifted out by the parser, run with stubs) cold-starts
  a pty bot through pty-host even from a headless tick with a logged-in user,
  where it used to hand the launch to the BotCorp-Launch task.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ASSEMBLY = Path(__file__).resolve().parents[2]
needs_win = pytest.mark.skipif(sys.platform != "win32" or shutil.which("pwsh") is None, reason="Windows + pwsh")


def test_the_visible_launch_path_is_gone():
    assert not (ASSEMBLY / "daemon" / "launch-visible.ps1").exists()
    hits = []
    for d in ("daemon", "cli", "cockpit", "core"):
        for p in (ASSEMBLY / d).rglob("*"):
            if p.is_file() and p.suffix in (".ps1", ".mjs", ".js") and "node_modules" not in p.parts and "dist" not in p.parts and "tests" not in p.parts:
                # code lines only: a comment naming the old path starts nothing
                code = "\n".join(ln for ln in p.read_text(encoding="utf-8", errors="replace").splitlines() if not ln.lstrip().startswith(("#", "//")))
                hits += [f"{p.relative_to(ASSEMBLY)}: {w}" for w in ("launch-visible", "Start-VisibleLaunchTask", "launch-request.json") if w in code]
    assert hits == []
    install = (ASSEMBLY / "daemon" / "install.ps1").read_text(encoding="utf-8")
    assert "Register-ScheduledTask -TaskName $launchTask" not in install and "LaunchTaskOnly" not in install


PROBE = r"""
param([string]$Tick)
$ErrorActionPreference = 'Continue'
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Tick, [ref]$null, [ref]$null)
$fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Start-BotCold' }, $true)
. ([scriptblock]::Create($fn.Extent.Text))
$script:calls = @()
function Write-DaemonLog { param($Message, $Bot, [switch]$Quiet) }
function Read-JsonFile { param($Path) $null }
function Write-BotState { param($Bot, $Updates) }
function Test-Headless { $true }
function Get-InteractiveSessionId { 1 }
function Start-VisibleLaunchTask { param($Bot, $SessionId) $script:calls += 'visible-task'; 'BotCorp-Launch task' }
function Start-PtyHost { param($Bot, [switch]$Fresh) $script:calls += 'pty-host'; 4242 }
$how = Start-BotCold -Bot 't' -Paths @{ BotPidFile = 'C:\nonexistent\bot.pid'; PtyFile = 'C:\nonexistent\t.pty.json' } -Service 'pty'
[pscustomobject]@{ how = "$how"; calls = @($script:calls) } | ConvertTo-Json -Compress
"""


@needs_win
def test_a_pty_cold_start_goes_to_pty_host_with_a_user_logged_in(tmp_path):
    probe = tmp_path / "probe.ps1"
    probe.write_text(PROBE, encoding="utf-8")
    r = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-File", str(probe), "-Tick", str(ASSEMBLY / "daemon" / "tick.ps1")],
                       capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout.strip().splitlines()[-1])
    assert out["calls"] == ["pty-host"] and "pty-host" in out["how"], out
