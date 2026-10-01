"""v0.9.13: alert triage's headless run gets the bot's own Claude token.

The daemon ran `alert_triage.py scan` with Get-BotEnv only, so the scan (and
the detached `claude --print` it spawns, which inherits the scan's env) ran on
whatever CLAUDE_CODE_OAUTH_TOKEN the daemon inherited: on a shared host, the
HKCU user env of another account. Invoke-AlertTriage now drops the inherited
CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY and injects the bot's oauth_token
through Get-JobSecretEnv, the path automations use.

Invoke-AlertTriage is lifted out of tick.ps1 by the parser and run on the real
_common.ps1 (so the real Invoke-Bounded spawns the child) with the vault read
and the busy check stubbed; a fake alert_triage.py records the env it got.
Fake values only.
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
needs_win = pytest.mark.skipif(sys.platform != "win32" or shutil.which("pwsh") is None, reason="Windows + pwsh")

PROBE = r"""
param([string]$Daemon, [string]$Root, [string]$Py, [string]$Declared)
$ErrorActionPreference = 'Continue'
. (Join-Path $Daemon '_common.ps1')
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $Daemon 'tick.ps1'), [ref]$null, [ref]$null)
$fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Invoke-AlertTriage' }, $true)
. ([scriptblock]::Create($fn.Extent.Text))
$Harness = Join-Path $Root 'harness'
$pyExe = $Py
$script:vault = @()
function Test-SessionBusy { param($Bot, [switch]$LimitBlocked) $false }
function Get-VaultSecret { param($BotHome, $Bot, $Key, $Reason, $Nonce) $script:vault += "$Key/$Reason"; "bot-own-$Key" }
$cfg = [pscustomobject]@{ secrets = @($Declared -split ',' | Where-Object { $_ }); account = $null; backup_accounts = @(); _modules = @() }
Invoke-AlertTriage -Bot 't' -Cfg $cfg -Paths @{ BotHome = (Join-Path $Root 'bot'); ConfigDir = (Join-Path $Root 'cfg') }
[pscustomobject]@{ vault = @($script:vault) } | ConvertTo-Json -Compress
"""

FAKE_SCAN = """import json, os
keys = ("CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY")
with open(os.path.join(os.environ["BOT_HOME"], "child-env.json"), "w", encoding="utf-8") as f:
    json.dump({k: os.environ.get(k) for k in keys}, f)
"""


def _run(tmp_path: Path, declared: str) -> tuple[dict, dict]:
    (tmp_path / "harness" / "tools" / "v2").mkdir(parents=True)
    (tmp_path / "harness" / "tools" / "v2" / "alert_triage.py").write_text(FAKE_SCAN, encoding="utf-8")
    (tmp_path / "bot").mkdir()
    ps = tmp_path / "probe.ps1"
    ps.write_text(PROBE, encoding="utf-8")
    env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE", "TELEGRAM_", "BOT_", "ANTHROPIC_", "OAUTH_"))}
    env.update(BOTCORP_HOME=str(tmp_path / "rt"), BOT_TG_MUTE="1", BOT_TRIAGE_EVERY_MIN="0",
               CLAUDE_CODE_OAUTH_TOKEN="inherited-foreign", ANTHROPIC_API_KEY="inherited-foreign-key")
    r = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(ps),
                        "-Daemon", str(ASSEMBLY / "daemon"), "-Root", str(tmp_path), "-Py", sys.executable, "-Declared", declared],
                       capture_output=True, text=True, timeout=180, env=env)
    assert r.returncode == 0, r.stderr + r.stdout
    out = json.loads(r.stdout.strip().splitlines()[-1])
    child = json.loads((tmp_path / "bot" / "child-env.json").read_text(encoding="utf-8"))
    return out, child


@needs_win
def test_the_triage_run_carries_the_bot_token_not_the_inherited_one(tmp_path):
    out, child = _run(tmp_path, "oauth_token,telegram_token")
    assert child == {"CLAUDE_CODE_OAUTH_TOKEN": "bot-own-oauth_token", "ANTHROPIC_API_KEY": None}, child
    assert out["vault"] == ["oauth_token/automation"], out           # only the key it needs is decrypted


@needs_win
def test_without_a_declared_oauth_token_it_gets_none_and_not_the_inherited_one(tmp_path):
    out, child = _run(tmp_path, "telegram_token")
    assert child == {"CLAUDE_CODE_OAUTH_TOKEN": None, "ANTHROPIC_API_KEY": None}, child
    assert out["vault"] == [], out
