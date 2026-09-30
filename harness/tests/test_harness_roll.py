"""QA pack C 1: a deferred update restart is retried on every tick.

Before: the tick restarted live bots onto a new release only on the tick that
applied it; a bot whose session was busy then was deferred and never asked
again, and kept running the old harness. Now daemon/tick.ps1 Get-HarnessRoll
(lifted out by the parser, run against a temp state dir) compares the
`harness_version` session_start.py recorded for the bot with the applied
release in <rt>/state/harness.json on every tick:
- a mismatch -> "restart onto vX (launched on vY)", v prefixes normalised;
- the same version, no recorded version, or no applied release -> nothing;
- once per applied tag (`harness_roll_to`), so a launch that keeps recording
  another version cannot restart-loop;
- Invoke-BotTick asks it outside the apply tick, through the busy gate and
  the start cap, and records `harness_roll_to` only with the restart.
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

PROBE = r"""
param([string]$Tick, [string]$StateDir, [string]$StateJson)
$ErrorActionPreference = 'Continue'
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Tick, [ref]$null, [ref]$null)
$fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-HarnessRoll' }, $true)
. ([scriptblock]::Create($fn.Extent.Text))
function Write-DaemonLog { param($Message, $Bot, [switch]$Quiet) }
function Read-JsonFile { param($Path) try { Get-Content -Raw -LiteralPath $Path -ErrorAction Stop | ConvertFrom-Json } catch { $null } }
$st = $(if ($StateJson) { $StateJson | ConvertFrom-Json } else { $null })
$r = Get-HarnessRoll -Bot 't' -State $st
[pscustomobject]@{ why = "$($r.Why)"; to = "$($r.To)" } | ConvertTo-Json -Compress
"""


def _roll(tmp: Path, *, tag="v0.9.6", state=None):
    sd = tmp / "state"
    sd.mkdir(parents=True, exist_ok=True)
    if tag is not None:
        (sd / "harness.json").write_text(json.dumps({"tag": tag, "sha": "abc"}), encoding="utf-8")
    ps = tmp / "probe.ps1"
    ps.write_text(PROBE, encoding="utf-8")
    r = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(ps),
                        "-Tick", str(ASSEMBLY / "daemon" / "tick.ps1"), "-StateDir", str(sd),
                        "-StateJson", json.dumps(state) if state is not None else ""],
                       capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stderr + r.stdout
    return json.loads(r.stdout.strip().splitlines()[-1])


@needs_win
def test_a_session_on_the_old_release_restarts_onto_the_applied_one(tmp_path):
    out = _roll(tmp_path, state={"harness_version": "0.9.5"})
    assert out == {"why": "restart onto v0.9.6 (launched on v0.9.5)", "to": "0.9.6"}


@needs_win
def test_v_prefixes_are_normalised(tmp_path):
    assert _roll(tmp_path, state={"harness_version": "0.9.6"})["why"] == ""
    assert _roll(tmp_path, tag="0.9.6", state={"harness_version": "v0.9.6"})["why"] == ""
    assert _roll(tmp_path, tag="0.9.7", state={"harness_version": "v0.9.6"})["why"] == "restart onto v0.9.7 (launched on v0.9.6)"


@needs_win
@pytest.mark.parametrize("case", ["no-recorded-version", "no-state", "no-applied-release"])
def test_nothing_known_means_no_restart(tmp_path, case):
    state = {"no-recorded-version": {"session_id": "x"}, "no-state": None}.get(case, {"harness_version": "0.9.5"})
    out = _roll(tmp_path, tag=None if case == "no-applied-release" else "v0.9.6", state=state)
    assert out["why"] == "", out


@needs_win
def test_once_per_applied_tag(tmp_path):
    # restarted onto 0.9.6 already, yet the launch still records 0.9.5: no loop
    assert _roll(tmp_path, state={"harness_version": "0.9.5", "harness_roll_to": "0.9.6"})["why"] == ""
    # a later release is a new tag: asked again
    out = _roll(tmp_path, tag="v0.9.7", state={"harness_version": "0.9.5", "harness_roll_to": "0.9.6"})
    assert out["why"] == "restart onto v0.9.7 (launched on v0.9.5)"


def test_the_tick_asks_every_tick_and_marks_only_with_the_restart():
    text = (ASSEMBLY / "daemon" / "tick.ps1").read_text(encoding="utf-8")
    body = text[text.index("function Invoke-BotTick"):]
    ask = body.index("Get-HarnessRoll -Bot $Bot -State $st")
    # asked on every tick, not only when the apply happened this tick
    assert "if ($script:RestartAllWhy -and $action -eq 'none' -and $alive)" not in body
    assert "if ($action -eq 'none' -and $alive) {" in body[ask - 200:ask]
    mark = body.index("harness_roll_to = $harnessRoll")
    assert ask < body.index("Get-RecentStartCount") < body.index("Test-SessionBusy -Bot $Bot -LimitBlocked:$stuck") < mark < body.index("Start-RestartDetached")
