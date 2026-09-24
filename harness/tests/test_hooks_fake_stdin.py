"""Fake-stdin integration tests for harness/hooks/*.sh.

Runs each hook with `bash` from a throwaway git-initialised BOT_HOME, feeding
it the JSON payload Claude Code would send on stdin, and asserts on exit code
+ stdout/stderr. No network, no real Telegram send (BOT_TG_MUTE=1).
"""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

HARNESS = Path(__file__).resolve().parents[1]
HOOKS = HARNESS / "hooks"


@pytest.fixture
def bot_home(tmp_path):
    home = tmp_path / "bot"
    home.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=home, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.invalid"], cwd=home, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=home, check=True)
    (home / "memory").mkdir()
    (home / ".claude").mkdir()
    (home / "memory" / "TDL.md").write_text(
        "# TDL\n\n"
        "## Open\n\n"
        "### item one\n"
        "- NEXT STEP: do the thing\n\n"
        "### item two\n"
        "- some plain note\n\n"
        "## Done\n\n"
        "(nothing)\n",
        encoding="utf-8",
    )
    return home


def base_env(tmp_path, bot_home, extra=None):
    env = dict(os.environ)
    env.update({
        "CLAUDE_PLUGIN_ROOT": str(HARNESS),
        "BOT_HOME": str(bot_home),
        # conftest's autouse fixture exports BOT_NAME=testbot for the python
        # tools; the hooks derive their state dir from it, so pin it to the
        # folder name these assertions use.
        "BOT_NAME": bot_home.name,
        "BOTCORP_HOME": str(tmp_path / "rt"),
        "CLAUDE_CONFIG_DIR": str(tmp_path / "cfg"),
        "BOT_TG_MUTE": "1",
        "BOT_MODULES": "",
        "PYTHONIOENCODING": "utf-8",
    })
    if extra:
        env.update(extra)
    return env


def run_hook(name, env, stdin_text="", args=None):
    cmd = ["bash", str(HOOKS / name)] + list(args or [])
    return subprocess.run(
        cmd, input=stdin_text, capture_output=True, text=True, env=env, timeout=30,
    )


# --- (a) session-start.sh: basic run ---------------------------------------

def test_session_start_basic(tmp_path, bot_home):
    env = base_env(tmp_path, bot_home)
    proc = run_hook("session-start.sh", env, json.dumps({"session_id": "t1"}))
    assert proc.returncode == 0, proc.stderr

    lines = [ln for ln in proc.stdout.splitlines() if ln.strip()]
    assert lines, "expected an additionalContext JSON line on stdout"
    payload = json.loads(lines[-1])
    ctx = payload["hookSpecificOutput"]["additionalContext"]
    assert "Session ID: t1" in ctx
    assert "### item one" in ctx
    assert "### item two" in ctx

    journal = bot_home / "memory" / "sessions" / "t1" / "journal.md"
    assert journal.is_file()

    state_file = tmp_path / "rt" / "state" / f"{bot_home.name}.json"
    assert state_file.is_file()
    state = json.loads(state_file.read_text(encoding="utf-8"))
    assert "harness_version" in state
    assert state["session_id"] == "t1"


# --- (b) session-start.sh: BOT_DISABLED_HOOKS gate --------------------------

def test_session_start_disabled_hook_is_silent(tmp_path, bot_home):
    env = base_env(tmp_path, bot_home, {"BOT_DISABLED_HOOKS": "session-start"})
    proc = run_hook("session-start.sh", env, json.dumps({"session_id": "t2"}))
    assert proc.returncode == 0
    assert proc.stdout == ""


# --- (c) block-dialogs.sh always blocks -------------------------------------

def test_block_dialogs_blocks(tmp_path, bot_home):
    env = base_env(tmp_path, bot_home)
    proc = run_hook("block-dialogs.sh", env, "")
    assert proc.returncode == 2
    assert "BLOCKED" in proc.stderr


# --- (d) config-guard.sh: harness-managed vs. ordinary file -----------------

def test_config_guard_blocks_bot_yaml(tmp_path, bot_home):
    env = base_env(tmp_path, bot_home)
    payload = json.dumps({"tool_input": {"file_path": str(bot_home / "bot.yaml")}})
    proc = run_hook("config-guard.sh", env, payload)
    assert proc.returncode == 2
    assert "BLOCKED" in proc.stderr


def test_config_guard_allows_ordinary_file(tmp_path, bot_home):
    env = base_env(tmp_path, bot_home)
    payload = json.dumps({"tool_input": {"file_path": str(bot_home / "notes.md")}})
    proc = run_hook("config-guard.sh", env, payload)
    assert proc.returncode == 0
    assert proc.stdout == ""


# --- (e) subagent.sh start: summary capped, no raw prompt -------------------

def test_subagent_start_records_summary_not_prompt(tmp_path, bot_home):
    env = base_env(tmp_path, bot_home)
    payload = json.dumps({
        "session_id": "t1",
        "agent_id": "a1",
        "agent_type": "coder",
        "description": "port the thing",
    })
    proc = run_hook("subagent.sh", env, payload, args=["start"])
    assert proc.returncode == 0, proc.stderr

    subagents_file = tmp_path / "rt" / "state" / bot_home.name / "subagents.jsonl"
    assert subagents_file.is_file()
    entries = [json.loads(ln) for ln in subagents_file.read_text(encoding="utf-8").splitlines() if ln.strip()]
    assert entries
    entry = entries[-1]
    assert entry["event"] == "start"
    assert entry["agent_id"] == "a1"
    assert entry["agent_type"] == "coder"
    assert entry["summary"] == "port the thing"
    assert "prompt" not in entry


# --- (f) session-end.sh: dead lock released, live foreign lock kept --------

def test_session_end_releases_dead_lock(tmp_path, bot_home):
    env = base_env(tmp_path, bot_home)
    cfg = Path(env["CLAUDE_CONFIG_DIR"])
    lock_dir = cfg / "botcorp"
    lock_dir.mkdir(parents=True, exist_ok=True)
    lock_file = lock_dir / "tg_owner.lock"
    lock_file.write_text("999999\n", encoding="utf-8")  # near-certainly dead

    payload = json.dumps({"session_id": "t1", "reason": "clear"})
    proc = run_hook("session-end.sh", env, payload)
    assert proc.returncode == 0, proc.stderr
    assert not lock_file.exists()
    assert "lock_released=true" in proc.stderr


def test_session_end_keeps_live_foreign_lock(tmp_path, bot_home):
    env = base_env(tmp_path, bot_home)
    cfg = Path(env["CLAUDE_CONFIG_DIR"])
    lock_dir = cfg / "botcorp"
    lock_dir.mkdir(parents=True, exist_ok=True)
    lock_file = lock_dir / "tg_owner.lock"
    # This test process's own PID: alive for the duration of the test, and
    # not BOT_LAUNCHER_PID, so it must read as a live FOREIGN owner.
    lock_file.write_text(f"{os.getpid()}\n", encoding="utf-8")

    payload = json.dumps({"session_id": "t1", "reason": "clear"})
    proc = run_hook("session-end.sh", env, payload)
    assert proc.returncode == 0, proc.stderr
    assert lock_file.exists()
    assert "lock_released=false" in proc.stderr


# --- (g) user-prompt-submit.sh: inbound TG logging --------------------------

def test_user_prompt_submit_logs_tg_channel(tmp_path, bot_home):
    tg_log = HARNESS / "tools" / "tg" / "tg_log.py"
    if not tg_log.is_file():
        pytest.xfail(reason="tg_log.py not yet present")

    env = base_env(tmp_path, bot_home)
    prompt = (
        '<channel source="plugin:telegram:telegram" chat_id="123456" '
        'message_id="7" user="op">hi</channel>'
    )
    payload = json.dumps({"session_id": "t1", "prompt": prompt})
    proc = run_hook("user-prompt-submit.sh", env, payload)
    assert proc.returncode == 0, proc.stderr

    tg_file = bot_home / "memory" / "tg" / "123456.jsonl"
    assert tg_file.is_file()
