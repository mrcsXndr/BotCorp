"""QA pack C 5: the OTel sink runs only while some bot has module telemetry on.

Locked behaviour (daemon/tick.ps1 Invoke-OtelSinkKeepalive, lifted out by the
parser and run with stubs):
- wanted (a bot has telemetry on), sink dead -> started;
- not wanted, sink dead -> nothing started;
- not wanted, sink alive -> stopped, unless a bot.yaml was unreadable (unsure);
- the tick reads every bot.yaml once, after the update apply, decides from
  them, and Invoke-BotTick reuses those configs.
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
param([string]$Tick, [string]$Root, [string]$Wanted, [string]$Unsure, [string]$Alive, [string]$Late = '')
$ErrorActionPreference = 'Continue'
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Tick, [ref]$null, [ref]$null)
$fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Invoke-OtelSinkKeepalive' }, $true)
# $PSScriptRoot is empty in a lifted function: point it at the fake daemon folder
$ProbeDaemon = Join-Path $Root 'daemon'
. ([scriptblock]::Create($fn.Extent.Text.Replace('$PSScriptRoot', '$ProbeDaemon')))
$script:acts = @()
$StateDir = Join-Path $Root 'state'
$nodeExe = 'node.exe'
$BotCorp = $Root
function Write-DaemonLog { param($Message, $Bot, [switch]$Quiet) }
function Read-JsonFile { param($Path) try { Get-Content -Raw -LiteralPath $Path -ErrorAction Stop | ConvertFrom-Json } catch { $null } }
function Test-ProcAlive { param($P, $Names) $Alive -eq '1' }
function Start-Hidden {
    param($Exe, $Arguments, $WorkingDirectory)
    $script:acts += 'start'
    # the real sink writes otel.json a moment after it is spawned
    if ($Late -eq '1') { [void](Start-Job -ScriptBlock { param($f) Start-Sleep -Milliseconds 1500; Set-Content -LiteralPath $f -Value '{"pid":4242,"port":4318}' } -ArgumentList (Join-Path $StateDir 'otel.json')) }
    4242
}
function Stop-BotProcessTree { param($ProcId, $Bot, $Why) $script:acts += "stop $ProcId"; $true }
Invoke-OtelSinkKeepalive -Wanted ($Wanted -eq '1') -Unsure ($Unsure -eq '1')
if ($Late -eq '1') { (Get-Content -Raw -LiteralPath (Join-Path $StateDir 'otel.json') | ConvertFrom-Json).pid; exit 0 }
ConvertTo-Json -Compress -InputObject @($script:acts)
"""


def _acts(tmp: Path, wanted: str, unsure: str, alive: str, late: str = ""):
    (tmp / "daemon").mkdir(exist_ok=True)
    (tmp / "daemon" / "otel-sink.mjs").write_text("// stub\n", encoding="utf-8")
    (tmp / "state").mkdir(exist_ok=True)
    (tmp / "state" / "otel.json").write_text(json.dumps({"pid": 777, "port": 4318}), encoding="utf-8")
    ps = tmp / "probe.ps1"
    ps.write_text(PROBE, encoding="utf-8")
    r = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(ps),
                        "-Tick", str(ASSEMBLY / "daemon" / "tick.ps1"), "-Root", str(tmp),
                        "-Wanted", wanted, "-Unsure", unsure, "-Alive", alive, "-Late", late], capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stderr + r.stdout
    return json.loads(r.stdout.strip().splitlines()[-1])


@needs_win
@pytest.mark.parametrize("wanted,unsure,alive,expect", [
    ("1", "0", "0", ["start"]),
    ("1", "0", "1", []),
    ("0", "0", "0", []),
    ("0", "0", "1", ["stop 777"]),
    ("0", "1", "1", []),
])
def test_the_sink_follows_the_telemetry_module(tmp_path, wanted, unsure, alive, expect):
    assert _acts(tmp_path, wanted, unsure, alive) == expect


@needs_win
def test_a_started_sink_is_waited_for_until_its_otel_json_exists(tmp_path):
    # QA pack D 6: a bot launched later in the tick reads otel.json; the keepalive
    # must not return before the new sink has written it.
    assert _acts(tmp_path, "1", "0", "0", late="1") == 4242


def test_the_tick_decides_from_every_bot_yaml_after_the_apply():
    text = (ASSEMBLY / "daemon" / "tick.ps1").read_text(encoding="utf-8")
    main = text[text.index("# --- single instance"):]
    assert main.index("Invoke-UpdateApply") < main.index("$script:BotCfg[$b] = Get-BotConfig -Bot $b") < main.index("Invoke-OtelSinkKeepalive -Wanted")
    assert "(Test-BotModule $_ 'telemetry')" in main
    body = text[text.index("function Invoke-BotTick"):]
    assert "$script:BotCfg[$Bot]" in body
