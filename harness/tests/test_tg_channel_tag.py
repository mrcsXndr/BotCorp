"""Tests for tools/tg/tg_log.py's channel-tag parsing + ingest idempotency.

The Telegram channel plugin has shipped two different source= spellings for
the same channel ("telegram" and "plugin:telegram:telegram") — matching only
one silently stopped inbound logging for a week on the box this was ported
from. TAG_RE must accept both, plus the image_path media attribute, and
`ingest` must never double-log a message it has already seen.

No conftest.py assumed — sys.path is set up locally so this file runs
standalone.
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

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
