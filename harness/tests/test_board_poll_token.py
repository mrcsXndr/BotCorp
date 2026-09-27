"""R5a step 10: the board poll reads its GitHub token from the vault.

Invoke-BoardPoll (daemon/tick.ps1) is lifted out of the script by the
PowerShell parser and run with stubs for the vault read, the child runner and
the log: a declared `gh_token` puts GH_PROJECTS_TOKEN into the poll's env only;
a failing read logs one line and the poll still runs; an undeclared key never
touches the vault.
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
param([string]$Tick, [string]$Root, [string]$Mode, [string]$Declared)
$ErrorActionPreference = 'Continue'
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Tick, [ref]$null, [ref]$null)
$fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Invoke-BoardPoll' }, $true)
. ([scriptblock]::Create($fn.Extent.Text))
$Harness = $Root
$pyExe = 'python'
$script:logs = @(); $script:vault = @(); $script:ran = $false; $script:token = $null; $script:parentToken = $null
function Write-DaemonLog { param($Message, $Bot, [switch]$Quiet) $script:logs += "$Message" }
function Get-BotEnv { param($Bot, $Cfg, $Paths) @{ BOT_NAME = $Bot } }
function Invoke-Bounded {
    param($Exe, $Arguments, $TimeoutSec, $Label, [switch]$Capture, $Env, $WorkingDirectory, $Bot)
    $script:ran = $true; $script:token = $Env['GH_PROJECTS_TOKEN']
    [pscustomobject]@{ ExitCode = 0; Output = '' }
}
function Get-VaultSecret {
    param($BotHome, $Bot, $Key, $Reason)
    $script:vault += "$Key/$Reason"
    if ($Mode -eq 'throw') { throw 'vault locked' }
    'x'
}
$cfg = [pscustomobject]@{ secrets = @($Declared -split ',' | Where-Object { $_ }) }
Invoke-BoardPoll -Bot 't' -Cfg $cfg -Paths @{ BotHome = $Root }
[pscustomobject]@{ ran = $script:ran; token = $script:token; vault = @($script:vault); logs = @($script:logs); leaked = "$env:GH_PROJECTS_TOKEN" } | ConvertTo-Json -Compress
"""


def _probe(tmp_path, mode, declared):
    (tmp_path / "tools" / "v2").mkdir(parents=True, exist_ok=True)
    (tmp_path / "tools" / "v2" / "gh_projects.py").write_text("", encoding="utf-8")
    ps = tmp_path / "probe.ps1"
    ps.write_text(PROBE, encoding="utf-8")
    r = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(ps),
                        "-Tick", str(ASSEMBLY / "daemon" / "tick.ps1"), "-Root", str(tmp_path), "-Mode", mode, "-Declared", declared],
                       capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stderr + r.stdout
    return json.loads(r.stdout.strip().splitlines()[-1])


@needs_win
def test_declared_token_reaches_the_poll_env_only(tmp_path):
    out = _probe(tmp_path, "ok", "oauth_token,gh_token")
    assert out["ran"] is True and out["token"] == "x", out
    assert out["vault"] == ["gh_token/board"] and out["logs"] == [] and out["leaked"] == "", out


@needs_win
def test_a_failed_read_logs_once_and_still_polls(tmp_path):
    out = _probe(tmp_path, "throw", "gh_token")
    assert out["ran"] is True and out["token"] is None, out
    assert len(out["logs"]) == 1 and "gh_token unreadable" in out["logs"][0] and "host gh" in out["logs"][0], out


@needs_win
def test_undeclared_key_never_reads_the_vault(tmp_path):
    out = _probe(tmp_path, "ok", "oauth_token")
    assert out["ran"] is True and out["token"] is None and out["vault"] == [], out
