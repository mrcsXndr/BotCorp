"""R5a step 15b: a job never inherits another account's Claude credentials.

On a shared host the HKCU user env carries CLAUDE_CODE_OAUTH_TOKEN for some
other bot, and the daemon (so every job) inherits it. daemon/automations.ps1
drops an inherited CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY from the job
env; a job that declares `secrets: [oauth_token]` gets the bot's own token as
both OAUTH_TOKEN and CLAUDE_CODE_OAUTH_TOKEN (the session's name for it).

End to end: `automations.ps1 -RunNow` on a fixture bot under <assembly>/bots/
with a temp BOTCORP_HOME, its vault seeded with a test value, and the parent
env carrying the foreign token.
"""
from __future__ import annotations

import json
import os
import secrets
import shutil
import subprocess

import pytest

from test_automation_python import ASSEMBLY, _last_log, _run_now, _runs, _wait_runs, needs_win

VAULT = ASSEMBLY / "daemon" / "vault.ps1"
JOB = "    trigger: {interval_min: 600}\n    command: 'echo [%CLAUDE_CODE_OAUTH_TOKEN%][%OAUTH_TOKEN%][%ANTHROPIC_API_KEY%]'\n    timeout_min: 1\n"


@pytest.fixture
def oauth_bot(tmp_path):
    name = f"zz-o{secrets.token_hex(3)}"
    home = ASSEMBLY / "bots" / name
    home.mkdir(parents=True)
    rt = tmp_path / "rt"
    (rt / "state").mkdir(parents=True)
    env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE", "TELEGRAM_", "BOT_", "ANTHROPIC_", "OAUTH_"))}
    env.update(BOTCORP_HOME=str(rt), BOT_TG_MUTE="1", CLAUDE_CODE_OAUTH_TOKEN="foreign", ANTHROPIC_API_KEY="foreign-key")
    try:
        yield name, home, rt, env
    finally:
        shutil.rmtree(home, ignore_errors=True)


@needs_win
def test_jobs_never_see_a_foreign_account(oauth_bot):
    name, home, rt, env = oauth_bot
    (home / "bot.yaml").write_text(
        f"name: {name}\nharness:\n  service: manual\n  modules:\n    telegram: false\n"
        "secrets: [oauth_token]\n"
        f"automations:\n  - name: plain\n{JOB}  - name: mine\n{JOB}    secrets: [oauth_token]\n",
        encoding="utf-8")
    seed = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
                           f". '{VAULT}'; [void](Set-VaultSecret -BotHome '{home}' -Bot '{name}' -Key 'oauth_token' -Value 'mine'); 'seeded'"],
                          capture_output=True, text=True, timeout=120, env=env)
    assert seed.returncode == 0 and "seeded" in seed.stdout, seed.stderr
    for i, job in enumerate(("plain", "mine"), 1):
        _run_now(name, env, job)
        _wait_runs(rt, name, i)
    # cmd echoes an unset %VAR% back verbatim
    assert _last_log(rt, name, "plain") == "[%CLAUDE_CODE_OAUTH_TOKEN%][%OAUTH_TOKEN%][%ANTHROPIC_API_KEY%]"
    assert _last_log(rt, name, "mine") == "[mine][mine][%ANTHROPIC_API_KEY%]"
    assert {r["automation"]: r["exit"] for r in _runs(rt, name)} == {"plain": 0, "mine": 0}


ACCT = "value-for-tests-acct-A1b2"


def _account_bot(name, home, rt, env):
    """bot.yaml account: acc1 + a job declaring oauth_token; the bot vault holds 'mine', the account ACCT."""
    (home / "bot.yaml").write_text(
        f"name: {name}\nharness:\n  service: manual\n  modules:\n    telegram: false\n"
        f"secrets: [oauth_token]\naccount: acc1\nautomations:\n  - name: mine\n{JOB}    secrets: [oauth_token]\n",
        encoding="utf-8")
    seed = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
                           f". '{VAULT}'; [void](Set-VaultSecret -BotHome '{home}' -Bot '{name}' -Key 'oauth_token' -Value 'mine'); 'seeded'"],
                          capture_output=True, text=True, timeout=120, env=env)
    assert seed.returncode == 0 and "seeded" in seed.stdout, seed.stderr
    r = subprocess.run(["node", str(ASSEMBLY / "cli" / "botcorp.mjs"), "accounts", "add", "acc1"], input=ACCT + "\n",
                       capture_output=True, text=True, timeout=120, cwd=str(ASSEMBLY), env=env)
    assert r.returncode == 0, r.stdout + r.stderr


def _unreadable_lines(rt, name):
    f = rt / "logs" / name / "daemon.log"
    return [ln for ln in f.read_text(encoding="utf-8-sig").splitlines() if "unreadable" in ln] if f.exists() else []


@needs_win
def test_a_job_oauth_token_follows_the_account(oauth_bot):
    name, home, rt, env = oauth_bot
    _account_bot(name, home, rt, env)
    _run_now(name, env, "mine")
    _wait_runs(rt, name, 1)
    assert _last_log(rt, name, "mine") == f"[{ACCT}][{ACCT}][%ANTHROPIC_API_KEY%]"
    assert _unreadable_lines(rt, name) == []


@needs_win
def test_an_unreadable_account_gives_the_job_the_bot_token(oauth_bot):
    name, home, rt, env = oauth_bot
    _account_bot(name, home, rt, env)
    (rt / "accounts" / "acc1" / "account.json").unlink()
    _run_now(name, env, "mine")
    _wait_runs(rt, name, 1)
    assert _last_log(rt, name, "mine") == "[mine][mine][%ANTHROPIC_API_KEY%]"
    lines = _unreadable_lines(rt, name)
    assert len(lines) == 1 and "account acc1 unreadable -> bot's oauth_token" in lines[0], lines


@needs_win
def test_a_job_follows_the_account_a_failover_moved_the_session_to(oauth_bot):
    """v0.8.0: bot.yaml account: null + backup_accounts: [acc1]; the daemon failed over (state account_active acc1)."""
    name, home, rt, env = oauth_bot
    _account_bot(name, home, rt, env)
    text = (home / "bot.yaml").read_text(encoding="utf-8").replace("account: acc1\n", "backup_accounts: [acc1]\n")
    (home / "bot.yaml").write_text(text, encoding="utf-8")
    (rt / "state" / f"{name}.json").write_text(json.dumps({"bot": name, "account_active": {"id": "acc1", "reason": "failover"}}), encoding="utf-8")
    _run_now(name, env, "mine")
    _wait_runs(rt, name, 1)
    assert _last_log(rt, name, "mine") == f"[{ACCT}][{ACCT}][%ANTHROPIC_API_KEY%]"
    # taken out of the chain: back to the bot's own token
    (home / "bot.yaml").write_text(text.replace("backup_accounts: [acc1]\n", ""), encoding="utf-8")
    _run_now(name, env, "mine")
    _wait_runs(rt, name, 2)
    assert _last_log(rt, name, "mine") == "[mine][mine][%ANTHROPIC_API_KEY%]"
