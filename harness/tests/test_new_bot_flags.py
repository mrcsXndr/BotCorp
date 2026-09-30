"""v0.8.5 step 14b: `new --account / --service` and `archive`.

Locked behaviour (cli/botcorp.mjs cmdNew / cmdArchive):
- `new --account <id>` (a registered account with a token that passes its
  check) writes `account: <id>` and asks for no oauth token; the bot's own vault
  gets none; an unknown account is exit 2 and leaves no folder; from a bot
  session it is exit 3 (choosing an account is the operator's);
- `new --service manual` writes harness.service: manual; anything but
  daemon|manual is a usage error; `--yes` without a TTY never prompts;
- `archive <bot>` moves a chat's folder to <rt>/archive/<name>-<stamp>/,
  refuses a daemon bot (exit 2) and any bot session, an admin bot's included
  (exit 3).

Every run uses a temp BOTCORP_HOME / BOTCORP_BOTS_DIR; the token check's result
comes from its seeded 24 h cache; the token is a fake value.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys

import pytest

from test_accounts_use import _token_check
from test_admin_role import ID_BOSS, abox  # noqa: F401 (abox is a fixture)
from test_operator_only import ASSEMBLY, make_bot, operator_env

FAKE = "sk-ant-oat01-" + "FAKE" * 7 + "-Nw01"

pytestmark = pytest.mark.skipif(
    sys.platform != "win32" or shutil.which("pwsh") is None or shutil.which("node") is None,
    reason="Windows only (DPAPI account vault) with pwsh and node on PATH",
)


def _cli(env, *args, stdin=""):
    """stdin is a closed pipe, never a TTY: nothing may prompt."""
    return subprocess.run(["node", str(ASSEMBLY / "cli" / "botcorp.mjs"), *args], input=stdin, capture_output=True,
                          text=True, encoding="utf-8", timeout=180, cwd=str(ASSEMBLY), env=env)


@pytest.fixture
def nbox(tmp_path):
    rt, bots = tmp_path / "rt", tmp_path / "bots"
    (rt / "state").mkdir(parents=True)
    bots.mkdir()
    stand_in = tmp_path / "claude.exe"   # never a real Claude Code
    stand_in.write_bytes(b"not a program")
    env = {**operator_env(rt, bots), "BOTCORP_CLAUDE_EXE": str(stand_in)}
    r = _cli(env, "accounts", "add", "acc1", stdin=FAKE + "\n")
    assert r.returncode == 0, r.stdout + r.stderr
    _token_check(rt, env, ok=True)
    return rt, bots, env


def _new(env, *extra):
    return _cli(env, "new", "--yes", "--no-launch", *extra)


def test_new_on_an_account_as_a_chat(nbox):
    rt, bots, env = nbox
    r = _new(env, "--name", "chat-0930-0101", "--service", "manual", "--account", "acc1")
    assert r.returncode == 0, r.stdout + r.stderr
    text = (bots / "chat-0930-0101" / "bot.yaml").read_text(encoding="utf-8")
    assert "account: acc1" in text and "service: manual" in text
    assert "OAuth token for" not in r.stdout and "runs on account acc1" in r.stdout
    vault = bots / "chat-0930-0101" / ".vault" / "secrets.json"
    assert not vault.exists() or "oauth_token" not in vault.read_text(encoding="utf-8")
    assert FAKE not in r.stdout + r.stderr
    status = json.loads(_cli(env, "accounts", "failover", "chat-0930-0101", "--json").stdout)
    assert [c["id"] for c in status["chain"]] == ["acc1"]


def test_new_defaults_to_a_daemon_bot_and_never_prompts_without_a_tty(nbox):
    rt, bots, env = nbox
    r = _new(env, "--name", "pinned")
    assert r.returncode == 0, r.stdout + r.stderr
    text = (bots / "pinned" / "bot.yaml").read_text(encoding="utf-8")
    assert "service:" not in text and "account:" not in text   # the defaults: daemon, the bot's own token
    assert "oauth: none given" in r.stdout


def test_a_bad_account_or_service_leaves_no_folder(nbox):
    rt, bots, env = nbox
    r = _new(env, "--name", "x1", "--account", "nope")
    assert r.returncode == 2 and "no account 'nope'" in r.stderr, r.stdout + r.stderr
    r = _new(env, "--name", "x2", "--service", "cron")
    assert r.returncode == 2, r.stdout + r.stderr
    _token_check(rt, env, ok=False)
    r = _new(env, "--name", "x3", "--account", "acc1")
    assert r.returncode == 2 and "token check" in r.stderr, r.stdout + r.stderr
    assert sorted(p.name for p in bots.iterdir()) == []


def test_new_on_an_account_from_a_bot_is_refused(nbox):
    rt, bots, env = nbox
    r = _new({**env, "BOT_NAME": "x", "CLAUDECODE": "1"}, "--name", "x4", "--account", "acc1")
    assert r.returncode == 3 and "operator-only" in r.stderr, r.stdout + r.stderr
    assert not (bots / "x4").exists()


def test_archive_moves_a_chat_and_refuses_a_daemon_bot(nbox):
    rt, bots, env = nbox
    assert _new(env, "--name", "c1", "--service", "manual", "--account", "acc1").returncode == 0
    make_bot(bots, "keep", "name: keep\n")
    r = _cli(env, "archive", "keep")
    assert r.returncode == 2 and "service: daemon" in r.stderr, r.stdout + r.stderr
    assert (bots / "keep" / "bot.yaml").exists()
    r = _cli(env, "archive", "c1")
    assert r.returncode == 0, r.stdout + r.stderr
    assert not (bots / "c1").exists()
    moved = list((rt / "archive").iterdir())
    assert len(moved) == 1 and moved[0].name.startswith("c1-") and (moved[0] / "bot.yaml").exists()
    assert "account: acc1" in (moved[0] / "bot.yaml").read_text(encoding="utf-8")


def test_no_bot_archives_an_admin_included(abox):
    rt, bots, op, as_bot = abox
    make_bot(bots, "c2")   # service: manual
    for bot, lid in (("boss", ID_BOSS),):
        r = _cli(as_bot(bot, lid), "archive", "c2")
        assert r.returncode == 3 and "operator-only" in r.stderr, r.stdout + r.stderr
    r = _cli({**op, "BOT_NAME": "peon", "CLAUDECODE": "1"}, "archive", "c2")
    assert r.returncode == 3
    assert (bots / "c2" / "bot.yaml").exists()
    assert _cli(op, "archive", "c2").returncode == 0   # positive control: the operator
