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
