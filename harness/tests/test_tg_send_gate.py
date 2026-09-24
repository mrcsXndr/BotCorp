"""Tests for tools/tg/tg_send.py's two safety gates:

  - BOT_TG_MUTE=1 must reach exit 0 without ever touching the network.
  - The unanswered-backlog gate must refuse once BOT_TG_UNANSWERED_MAX sends
    have gone out since the last --answered, and --answered must clear it.

No conftest.py assumed — sys.path is set up locally so this file runs
standalone. No real Telegram send happens in either test: the mute test
proves that by making a network call raise, and the backlog test uses a
BOTCORP_HOME-scoped runtime dir plus a fake urlopen (never a real socket).
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

HARNESS = Path(__file__).resolve().parents[1]
TG_DIR = HARNESS / "tools" / "tg"

sys.path.insert(0, str(HARNESS / "tools"))
sys.path.insert(0, str(TG_DIR))
import tg_send  # noqa: E402


@pytest.fixture
def bot_env(tmp_path, monkeypatch):
    bot_home = tmp_path / "bot"
    bot_home.mkdir()
    (bot_home / ".env").write_text(
        "TELEGRAM_BOT_TOKEN=test-token\nTELEGRAM_CHAT_ID=123456\n", encoding="utf-8",
    )
    monkeypatch.setenv("BOT_HOME", str(bot_home))
    monkeypatch.setenv("BOTCORP_HOME", str(tmp_path / "rt"))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "cfg"))
    monkeypatch.setenv("BOT_NAME", "testbot")
    monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)
    monkeypatch.delenv("TELEGRAM_CHAT_ID", raising=False)
    return bot_home


class _FakeResp:
    """Minimal stand-in for the urllib.request.urlopen() context manager."""

    def __init__(self, payload: bytes):
        self._payload = payload

    def read(self):
        return self._payload

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _fake_ok_urlopen(req, timeout=None):
    import json
    return _FakeResp(json.dumps({"ok": True, "result": {"message_id": 1}}).encode())


def test_mute_blocks_network_call(bot_env, monkeypatch):
    monkeypatch.setenv("BOT_TG_MUTE", "1")

    def _boom(*a, **k):
        raise AssertionError("urlopen must not be called under BOT_TG_MUTE=1")
    monkeypatch.setattr(tg_send.urllib.request, "urlopen", _boom)

    monkeypatch.setattr(sys, "argv", ["tg_send.py", "--quiet", "--no-status", "hello"])
    rc = tg_send.main()
    assert rc == 0


def test_unanswered_gate_refuses_at_limit_then_answered_clears(bot_env, monkeypatch):
    monkeypatch.delenv("BOT_TG_MUTE", raising=False)
    monkeypatch.setenv("BOT_TG_UNANSWERED_MAX", "2")
    monkeypatch.setattr(tg_send.urllib.request, "urlopen", _fake_ok_urlopen)

    # Two sends are allowed (count goes 0 -> 1 -> 2).
    for i in range(2):
        monkeypatch.setattr(sys, "argv", ["tg_send.py", "--quiet", "--no-status", f"msg {i}"])
        assert tg_send.main() == 0

    # The third is refused purely by the backlog gate — exit code 3, no send.
    monkeypatch.setattr(sys, "argv", ["tg_send.py", "--quiet", "--no-status", "one too many"])
    assert tg_send.main() == 3

    # --answered clears the backlog...
    monkeypatch.setattr(sys, "argv", ["tg_send.py", "--answered"])
    assert tg_send.main() == 0

    # ...so a normal send goes through again.
    monkeypatch.setattr(sys, "argv", ["tg_send.py", "--quiet", "--no-status", "after answered"])
    assert tg_send.main() == 0
