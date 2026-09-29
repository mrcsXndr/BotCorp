"""R5c step 17: a launch on bot.yaml `account:` runs on that account's token, else falls back to the bot's own.

Locked behaviour (daemon/launch.ps1):
- `account: <id>` + a readable account vault (<rt>/accounts/<id>) -> the
  session gets the account's token; launch-env.json records account=<id>,
  oauth_source=account;
- the account unreadable (account.json gone) -> the bot's own vault token,
  oauth_source=vault-fallback, and ONE launches.log line saying so;
- the account unreadable and no bot token and no /login -> the existing
  refusal (exit 5);
- no `account:` -> the bot's own token, oauth_source=vault (regression).

A real DPAPI vault with fake values, and a fake claude that records the token it got.
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
ACCT = "value-for-tests-acct-A1b2"
BOT = "value-for-tests-bot-C3d4"

pytestmark = pytest.mark.skipif(
    sys.platform != "win32" or shutil.which("pwsh") is None or shutil.which("node") is None,
    reason="Windows only (DPAPI vault) with pwsh and node on PATH",
)


def _ps(env: dict, body: str) -> None:
    r = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", body],
                       capture_output=True, text=True, timeout=180, cwd=str(ASSEMBLY), env=env)
    assert r.returncode == 0 and "done" in r.stdout, r.stdout + r.stderr


@pytest.fixture
def abot(tmp_path):
    name = f"zz-a{secrets.token_hex(3)}"
    home = ASSEMBLY / "bots" / name
    home.mkdir(parents=True)
    rt = tmp_path / "rt"
    (rt / "state").mkdir(parents=True)
    profile, fake_bin = tmp_path / "profile", tmp_path / "bin"
    for d in (profile, fake_bin):
        d.mkdir()
    seen = tmp_path / "seen.txt"
    (fake_bin / "claude.cmd").write_text(f'@echo off\r\n>>"{seen}" echo [%CLAUDE_CODE_OAUTH_TOKEN%] %*\r\nexit /b 0\r\n', encoding="utf-8")
    env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE", "TELEGRAM_", "BOT_")) and k != "BOTCORP_CLAUDE_EXE"}
    env.update({"BOTCORP_HOME": str(rt), "USERPROFILE": str(profile), "PATH": f"{fake_bin}{os.pathsep}{env.get('PATH', '')}", "BOT_TG_MUTE": "1"})
    r = subprocess.run(["node", str(ASSEMBLY / "cli" / "botcorp.mjs"), "accounts", "add", "acc1"], input=ACCT + "\n",
                       capture_output=True, text=True, timeout=120, cwd=str(ASSEMBLY), env=env)
    assert r.returncode == 0 and "****A1b2" in r.stdout, r.stdout + r.stderr
    try:
        yield name, home, rt, env, seen
    finally:
        shutil.rmtree(home, ignore_errors=True)


def _yaml(home, name, account: str | None):
    (home / "bot.yaml").write_text(f"name: {name}\nharness:\n  service: manual\n  modules:\n    telegram: false\n"
                                   f"secrets: [oauth_token]\n{f'account: {account}' if account else ''}\n", encoding="utf-8")


def _bot_token(env, home, name):
    _ps(env, f". '{VAULT}'; [void](Set-VaultSecret -BotHome '{home}' -Bot '{name}' -Key 'oauth_token' -Value '{BOT}'); 'done'")


def _launch(name: str, env: dict) -> subprocess.CompletedProcess:
    seed = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
                           f". '{VAULT}'\n\"nonce=$(New-LaunchNonce -Bot '{name}')\""],
                          capture_output=True, text=True, timeout=180, cwd=str(ASSEMBLY), env=env)
    assert seed.returncode == 0 and "nonce=" in seed.stdout, seed.stderr
    nonce = next(ln for ln in seed.stdout.splitlines() if ln.startswith("nonce="))[len("nonce="):].strip()
    return subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(ASSEMBLY / "daemon" / "launch.ps1"),
                           "-Bot", name, "-StartedBy", "manual"], capture_output=True, text=True, timeout=300, cwd=str(ASSEMBLY),
                          env={**env, "BOTCORP_LAUNCH_NONCE": nonce})


def _session_token(seen) -> str:
    launched = [ln for ln in seen.read_text(encoding="utf-8", errors="replace").splitlines() if "--plugin-dir" in ln]
    assert len(launched) == 1, launched
    return launched[0].split("]", 1)[0].lstrip("[")


def _record(home, name) -> dict:
    launches = json.loads((home / f".claude-{name}" / "botcorp" / "launch-env.json").read_text(encoding="utf-8-sig"))["launches"]
    assert len(launches) == 1
    return next(iter(launches.values()))


def _log(rt, name) -> str:
    return (rt / "logs" / name / "launches.log").read_text(encoding="utf-8-sig")


def test_account_token_reaches_the_session(abot):
    name, home, rt, env, seen = abot
    _yaml(home, name, "acc1")
    _bot_token(env, home, name)
    r = _launch(name, env)
    assert r.returncode == 0, r.stdout + r.stderr
    assert _session_token(seen) == ACCT
    rec = _record(home, name)
    assert rec["account"] == "acc1" and rec["oauth_source"] == "account" and rec["oauth_last4"] == "A1b2"
    assert "oauth: account acc1 ok (****A1b2)" in _log(rt, name)
    assert ACCT not in _log(rt, name) and ACCT not in r.stdout


def test_unreadable_account_falls_back_to_the_bot_token(abot):
    name, home, rt, env, seen = abot
    _yaml(home, name, "acc1")
    _bot_token(env, home, name)
    (rt / "accounts" / "acc1" / "account.json").unlink()
    r = _launch(name, env)
    assert r.returncode == 0, r.stdout + r.stderr
    assert _session_token(seen) == BOT
    rec = _record(home, name)
    assert rec["account"] == "acc1" and rec["oauth_source"] == "vault-fallback" and rec["oauth_last4"] == "C3d4"
    assert len([ln for ln in _log(rt, name).splitlines() if "fallback" in ln]) == 1


def test_unreadable_account_and_no_bot_token_refuses(abot):
    name, home, rt, env, seen = abot
    _yaml(home, name, "acc1")
    (rt / "accounts" / "acc1" / "account.json").unlink()
    r = _launch(name, env)
    assert r.returncode == 5, r.stdout + r.stderr
    assert "refusing to launch" in _log(rt, name)
    calls = seen.read_text(encoding="utf-8", errors="replace") if seen.exists() else ""
    assert not [ln for ln in calls.splitlines() if "--plugin-dir" in ln], calls


def test_a_failover_in_state_picks_the_backup_and_records_why(abot):
    """v0.8.0: account: null + backup_accounts: [acc1]; the tick failed over (state account_active acc1, just now)."""
    name, home, rt, env, seen = abot
    (home / "bot.yaml").write_text(f"name: {name}\nharness:\n  service: manual\n  modules:\n    telegram: false\n"
                                   "secrets: [oauth_token]\nbackup_accounts: [acc1]\n", encoding="utf-8")
    _bot_token(env, home, name)
    now = subprocess.run(["node", "-e", "console.log(new Date().toISOString())"], capture_output=True, text=True).stdout.strip()
    (rt / "state" / f"{name}.json").write_text(json.dumps({"bot": name, "account_active": {"id": "acc1", "reason": "failover"}, "account_switch_at": now}), encoding="utf-8")
    r = _launch(name, env)
    assert r.returncode == 0, r.stdout + r.stderr
    assert _session_token(seen) == ACCT
    rec = _record(home, name)
    assert rec["account"] == "acc1" and rec["account_reason"] == "failover" and rec["oauth_source"] == "account"
    assert "account: acc1 (failover" in _log(rt, name)


def test_no_account_keeps_the_bot_token(abot):
    name, home, rt, env, seen = abot
    _yaml(home, name, None)
    _bot_token(env, home, name)
    r = _launch(name, env)
    assert r.returncode == 0, r.stdout + r.stderr
    assert _session_token(seen) == BOT
    rec = _record(home, name)
    assert rec["account"] == "" and rec["oauth_source"] == "vault" and rec["oauth_last4"] == "C3d4"
    assert "account" not in _log(rt, name)
