"""QA pack B 5: the daemon tick runs `usage_monitor.py warn`.

Locked behaviour (daemon/tick.ps1 Invoke-UsageWarn, called from Invoke-BotTick
under module usage_resume):
- a window at 98% or more in the bot's <config>/botcorp/status.json runs the
  real `usage_monitor.py warn`, which appends ONE alerts.log line per window
  (a second tick adds none);
- below the line python is never started (cheap: status.json is read in pwsh);
- a missing status.json or a broken script is fail-open;
- the call sits inside the tick's usage_resume module gate.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

ASSEMBLY = Path(__file__).resolve().parents[2]
needs_win = pytest.mark.skipif(sys.platform != "win32" or shutil.which("pwsh") is None, reason="Windows + pwsh")

PROBE = r"""
param([string]$Tick, [string]$Home_, [string]$Cfg_, [string]$Rt, [string]$Py)
$ErrorActionPreference = 'Continue'
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Tick, [ref]$null, [ref]$null)
$fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Invoke-UsageWarn' }, $true)
. ([scriptblock]::Create($fn.Extent.Text))
$Harness = (Join-Path (Split-Path $Tick -Parent) '..\harness')
$pyExe = $Py
$script:calls = 0; $script:logs = @()
function Write-DaemonLog { param($Message, $Bot, [switch]$Quiet) $script:logs += "$Message" }
function Read-JsonFile { param($Path) try { Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json } catch { $null } }
function Get-BotEnv { param($Bot, $Cfg, $Paths) @{ BOT_NAME = $Bot; BOT_HOME = $Home_; CLAUDE_CONFIG_DIR = $Cfg_; BOTCORP_HOME = $Rt; BOT_TG_MUTE = '1'; PYTHONIOENCODING = 'utf-8' } }
function Invoke-Bounded {
    param($Exe, $Arguments, $TimeoutSec, $Label, [switch]$Capture, $Env, $WorkingDirectory, $Bot)
    $script:calls++
    foreach ($k in $Env.Keys) { Set-Item -Path "env:$k" -Value $Env[$k] }
    Push-Location $WorkingDirectory
    try { $o = & $Exe @Arguments 2>&1 | Out-String } finally { Pop-Location }
    [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = $o }
}
Invoke-UsageWarn -Bot 't' -Cfg $null -Paths @{ BotHome = $Home_; ConfigDir = $Cfg_ }
[pscustomobject]@{ calls = $script:calls; logs = @($script:logs) } | ConvertTo-Json -Compress
"""


def _box(tmp_path, pct):
    home, cfg, rt = tmp_path / "t", tmp_path / "cfg", tmp_path / "rt"
    (home / "memory" / "metrics").mkdir(parents=True, exist_ok=True)
    (cfg / "botcorp").mkdir(parents=True, exist_ok=True)
    if pct is not None:
        (cfg / "botcorp" / "status.json").write_text(json.dumps({
            "ts": time.time(), "rate_limits": {"five_hour": {"used_percentage": pct, "resets_at": int(time.time()) + 3600},
                                               "seven_day": {"used_percentage": 40, "resets_at": int(time.time()) + 86400}}}),
            encoding="utf-8")
    return home, cfg, rt


def _tick(tmp_path, home, cfg, rt):
    ps = tmp_path / "probe.ps1"
    ps.write_text(PROBE, encoding="utf-8")
    r = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(ps),
                        "-Tick", str(ASSEMBLY / "daemon" / "tick.ps1"), "-Home_", str(home), "-Cfg_", str(cfg),
                        "-Rt", str(rt), "-Py", sys.executable], capture_output=True, text=True, timeout=180)
    assert r.returncode == 0, r.stderr + r.stdout
    return json.loads(r.stdout.strip().splitlines()[-1])


def _alerts(home):
    f = home / "memory" / "metrics" / "alerts.log"
    return f.read_text(encoding="utf-8").splitlines() if f.exists() else []


@needs_win
def test_a_window_at_the_line_warns_once(tmp_path):
    home, cfg, rt = _box(tmp_path, 99)
    out = _tick(tmp_path, home, cfg, rt)
    assert out["calls"] == 1 and any("usage_warn: WARN 5h 99%" in l for l in out["logs"]), out
    assert len(_alerts(home)) == 1 and "Claude usage at 99% of the 5h window" in _alerts(home)[0]
    _tick(tmp_path, home, cfg, rt)
    assert len(_alerts(home)) == 1   # the same window is not warned twice


@needs_win
def test_below_the_line_or_no_status_starts_no_python(tmp_path):
    home, cfg, rt = _box(tmp_path, 60)
    assert _tick(tmp_path, home, cfg, rt)["calls"] == 0
    home, cfg, rt = _box(tmp_path / "none", None)
    assert _tick(tmp_path, home, cfg, rt)["calls"] == 0
    assert _alerts(home) == []


def test_the_tick_calls_it_under_the_usage_resume_gate():
    """Structural: parse tick.ps1 and find the call inside Invoke-BotTick's usage_resume block."""
    text = (ASSEMBLY / "daemon" / "tick.ps1").read_text(encoding="utf-8")
    body = text[text.index("function Invoke-BotTick"):]
    gate = body.index("if (Test-BotModule $cfg 'usage_resume') {")
    block = body[gate:body.index("}", gate)]
    assert "Invoke-UsageWarn -Bot $Bot" in block
