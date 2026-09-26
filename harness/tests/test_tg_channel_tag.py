"""Tests for tools/tg/tg_log.py's channel-tag parsing + ingest idempotency.

The Telegram channel plugin has shipped two different source= spellings for
the same channel ("telegram" and "plugin:telegram:telegram") — matching only
one silently stopped inbound logging for a week on the box this was ported
from. TAG_RE must accept both, plus the image_path media attribute, and
`ingest` must never double-log a message it has already seen.

hooks/user-prompt-submit.sh reads the slash command from the <channel> body
(a Telegram prompt starts with "<channel", so a first-char check never fired),
and from Telegram intercepts only the read-only allowlist: a command that
mutates or restarts passes through to the model.

No conftest.py assumed — sys.path is set up locally so this file runs
standalone.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

HARNESS = Path(__file__).resolve().parents[1]
TG_DIR = HARNESS / "tools" / "tg"
TG_LOG = TG_DIR / "tg_log.py"

sys.path.insert(0, str(HARNESS / "tools"))
sys.path.insert(0, str(TG_DIR))
import tg_log  # noqa: E402

PROMPT_OLD_TAG = (
    '<channel source="telegram" chat_id="111" message_id="1" user="op">hello</channel>'
)
PROMPT_NEW_TAG = (
    '<channel source="plugin:telegram:telegram" chat_id="222" message_id="2" '
    'user="op">hi there</channel>'
)
PROMPT_WITH_IMAGE = (
    '<channel source="plugin:telegram:telegram" chat_id="333" message_id="3" '
    'user="op" image_path="/tmp/photo.jpg">a photo</channel>'
)


def test_parse_prompt_old_tag_spelling():
    entries = tg_log.parse_prompt(PROMPT_OLD_TAG)
    assert len(entries) == 1
    e = entries[0]
    assert e["chat_id"] == "111"
    assert e["message_id"] == "1"
    assert e["kind"] == "text"
    assert e["text"] == "hello"


def test_parse_prompt_new_tag_spelling():
    entries = tg_log.parse_prompt(PROMPT_NEW_TAG)
    assert len(entries) == 1
    e = entries[0]
    assert e["chat_id"] == "222"
    assert e["message_id"] == "2"
    assert e["kind"] == "text"
    assert e["text"] == "hi there"


def test_parse_prompt_image_attribute():
    entries = tg_log.parse_prompt(PROMPT_WITH_IMAGE)
    assert len(entries) == 1
    e = entries[0]
    assert e["chat_id"] == "333"
    assert e["message_id"] == "3"
    assert e["kind"] == "photo"
    assert e["image_path"] == "/tmp/photo.jpg"


def test_ingest_is_idempotent(tmp_path, monkeypatch):
    bot_home = tmp_path / "bot"
    bot_home.mkdir()
    monkeypatch.setenv("BOT_HOME", str(bot_home))
    monkeypatch.setenv("PYTHONIOENCODING", "utf-8")

    proc1 = subprocess.run(
        [sys.executable, str(TG_LOG), "ingest"],
        input=PROMPT_OLD_TAG, capture_output=True, text=True,
        env=dict(os.environ), timeout=30,
    )
    assert proc1.returncode == 0, proc1.stderr
    assert "logged 1" in proc1.stdout

    proc2 = subprocess.run(
        [sys.executable, str(TG_LOG), "ingest"],
        input=PROMPT_OLD_TAG, capture_output=True, text=True,
        env=dict(os.environ), timeout=30,
    )
    assert proc2.returncode == 0, proc2.stderr
    assert "logged 0" in proc2.stdout

    log_file = bot_home / "memory" / "tg" / "111.jsonl"
    assert log_file.is_file()
    lines = [ln for ln in log_file.read_text(encoding="utf-8").splitlines() if ln.strip()]
    assert len(lines) == 1


def _run_prompt_hook(tmp_path, prompt: str):
    """user-prompt-submit.sh on `prompt`; returns (proc, journal text)."""
    bot_home = tmp_path / "bot"
    (bot_home / ".claude").mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "CLAUDE_PLUGIN_ROOT": str(HARNESS), "BOT_HOME": str(bot_home),
           "BOT_NAME": "bot", "BOTCORP_HOME": str(tmp_path / "rt"), "BOT_TG_MUTE": "1",
           "BOT_MODULES": "", "PYTHONIOENCODING": "utf-8", "TELEGRAM_CHAT_ID": "111"}
    proc = subprocess.run(["bash", str(HARNESS / "hooks" / "user-prompt-submit.sh")],
                          input=json.dumps({"session_id": "s1", "prompt": prompt}),
                          capture_output=True, text=True, env=env, timeout=60)
    journal = bot_home / "memory" / "sessions" / "s1" / "journal.md"
    return proc, journal.read_text(encoding="utf-8") if journal.is_file() else ""


def _tg(body: str, source: str = "plugin:telegram:telegram") -> str:
    return f'<channel source="{source}" chat_id="111" message_id="9" user="op">{body}</channel>'


@pytest.mark.parametrize("source", ["telegram", "plugin:telegram:telegram"])
def test_hook_intercepts_a_channel_wrapped_readonly_command(tmp_path, source):
    proc, journal = _run_prompt_hook(tmp_path, _tg("/status", source))
    assert proc.returncode == 2, proc.stderr
    assert "[tg_commands] handled /status" in proc.stderr
    assert "tg-command handled: /status" in journal
    # the command itself succeeds (rc 0, not 2 = handled-with-error)
    r = subprocess.run([sys.executable, str(HARNESS / "tools" / "v2" / "tg_commands.py"), "-", "9"],
                       input="/status", capture_output=True, text=True, timeout=60,
                       env={**os.environ, "BOT_TG_MUTE": "1", "PYTHONIOENCODING": "utf-8"})
    assert r.returncode == 0, r.stderr


@pytest.mark.parametrize("body", ["/update check", "/compact", "/board move x Done",
                                  "please run /status", "hello"])
def test_hook_passes_mutating_commands_and_text_from_telegram_through(tmp_path, body):
    proc, journal = _run_prompt_hook(tmp_path, _tg(body))
    assert proc.returncode == 0, proc.stderr
    assert "[tg_commands]" not in proc.stderr
    assert "tg-command handled" not in journal


def test_hook_never_intercepts_a_batched_prompt(tmp_path):
    proc, _ = _run_prompt_hook(tmp_path, _tg("first message") + "\n" + _tg("/status"))
    assert proc.returncode == 0, proc.stderr


def test_hook_still_intercepts_a_local_slash_command(tmp_path):
    proc, journal = _run_prompt_hook(tmp_path, "/status")
    assert proc.returncode == 2, proc.stderr
    assert "tg-command handled: /status" in journal
