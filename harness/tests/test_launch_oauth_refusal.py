"""A bot with no vault oauth token refuses to launch; the machine-wide token never reaches a session.

On a shared host the HKCU user env carries CLAUDE_CODE_OAUTH_TOKEN for another
bot's account, and every process (so every launch) inherits it. launch.ps1 used
to fall back to it for a bot with no vault entry, billing that bot to the other
account.

Locked behaviour (daemon/launch.ps1):
- the inherited CLAUDE_CODE_OAUTH_TOKEN is removed from the launcher's env at
  once, so nothing it spawns (claude --bg, claude agents/stop/rm, a foreground
  claude) sees it;
- no vault oauth_token and no /login in the bot's own config home
  (.credentials.json) = exit 5, a launches.log line "refusing to launch",
  state exit_code 5, and no claude is started;
- with a config-home /login the launch proceeds, still without the inherited token.

Only fake values (`value-for-tests-...`) are used.
"""
from __future__ import annotations

import json
import os
import secrets
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ASSEMBLY = Path(__file__).resolve().parents[2]
VAULT = ASSEMBLY / "daemon" / "vault.ps1"
HKCU_TOKEN = "value-for-tests-hkcu-Z1k9"

pytestmark = pytest.mark.skipif(
    sys.platform != "win32" or shutil.which("pwsh") is None or shutil.which("node") is None,
    reason="Windows only (DPAPI vault) with pwsh and node on PATH",
)


@pytest.fixture
def bot(tmp_path):
    name = f"zz-o{secrets.token_hex(3)}"
    home = ASSEMBLY / "bots" / name
    home.mkdir(parents=True)
    rt = tmp_path / "rt"
    (rt / "state").mkdir(parents=True)
    # a fake claude that records the token it was given: USERPROFILE without
    # .local\bin\claude.exe makes Resolve-ClaudeExe take the PATH one
    profile = tmp_path / "profile"
    fake_bin = tmp_path / "bin"
    for d in (profile, fake_bin):
        d.mkdir()
    seen = tmp_path / "seen.txt"
    (fake_bin / "claude.cmd").write_text(f'@echo off\r\n>>"{seen}" echo [%CLAUDE_CODE_OAUTH_TOKEN%] %*\r\nexit /b 0\r\n', encoding="utf-8")
    env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE", "TELEGRAM_", "BOT_"))}
    env.update({"BOTCORP_HOME": str(rt), "USERPROFILE": str(profile), "PATH": f"{fake_bin}{os.pathsep}{env.get('PATH', '')}",
                "CLAUDE_CODE_OAUTH_TOKEN": HKCU_TOKEN, "BOT_TG_MUTE": "1"})
    (home / "bot.yaml").write_text(f"name: {name}\nharness:\n  service: manual\n  modules:\n    telegram: false\n"
                                   "secrets: [oauth_token]\n", encoding="utf-8")
    try:
        yield name, home, rt, env, seen
    finally:
        shutil.rmtree(home, ignore_errors=True)


def _launch(name: str, env: dict, *args: str) -> subprocess.CompletedProcess:
    # attested (a trusted start path minted the nonce), so the vault IS read and has no oauth_token
    seed = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
                           f". '{VAULT}'\n\"nonce=$(New-LaunchNonce -Bot '{name}')\""],
                          capture_output=True, text=True, timeout=180, cwd=str(ASSEMBLY), env=env)
    assert seed.returncode == 0 and "nonce=" in seed.stdout, seed.stderr
    nonce = next(ln for ln in seed.stdout.splitlines() if ln.startswith("nonce="))[len("nonce="):].strip()
    return subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(ASSEMBLY / "daemon" / "launch.ps1"),
                           "-Bot", name, *args], capture_output=True, text=True, timeout=300, cwd=str(ASSEMBLY),
                          env={**env, "BOTCORP_LAUNCH_NONCE": nonce})


@pytest.mark.parametrize("args", [("-StartedBy", "manual"), ("-Bg", "-StartedBy", "daemon-cold")])
def test_no_vault_token_refuses_and_never_passes_the_inherited_one(bot, args):
    name, home, rt, env, seen = bot
    r = _launch(name, env, *args)
    out = r.stdout + r.stderr
    assert r.returncode == 5, out
    assert "oauth: FAIL - no vault oauth_token and no /login in" in out and "refusing to launch" in out
    assert "is another account's and is never inherited" in out and "****Z1k9" in out
    assert HKCU_TOKEN not in out
    log = (rt / "logs" / name / "launches.log").read_text(encoding="utf-8-sig")
    assert "refusing to launch" in log and HKCU_TOKEN not in log
    state = json.loads((rt / "state" / f"{name}.json").read_text(encoding="utf-8-sig"))
    assert state["exit_code"] == 5 and state["status"] == "exited"
    # no claude was started for the session; any claude call on the way never saw the token
    calls = seen.read_text(encoding="utf-8", errors="replace") if seen.exists() else ""
    assert HKCU_TOKEN not in calls
    assert not [ln for ln in calls.splitlines() if "--plugin-dir" in ln], calls


def test_a_config_home_login_launches_without_the_inherited_token(bot):
    name, home, rt, env, seen = bot
    cfg = home / f".claude-{name}"
    cfg.mkdir()
    (cfg / ".credentials.json").write_text("{}", encoding="utf-8")
    r = _launch(name, env, "-StartedBy", "manual")
    out = r.stdout + r.stderr
    assert r.returncode == 0, out
    assert "the config home's own /login" in out and "refusing" not in out
    calls = seen.read_text(encoding="utf-8", errors="replace")
    launched = [ln for ln in calls.splitlines() if "--plugin-dir" in ln]
    assert launched and all(ln.startswith("[] ") for ln in launched), calls   # the claude ran, with no token at all
