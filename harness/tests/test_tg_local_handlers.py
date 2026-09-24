"""Tests for tools/v2/tg_commands.py's bot-level HANDLERS merge (_local_handlers()).

<BOT_HOME>/tools/tg_commands_local.py can export a HANDLERS dict that the core
dispatcher merges in, with the bot winning on a name collision. tg_commands
computes REPO_ROOT = instance_root() (BOT_HOME) at IMPORT time, so every test
here sets BOT_HOME via monkeypatch BEFORE importlib.reload(tg_commands).
"""
from __future__ import annotations

import importlib


def test_bot_local_handler_is_dispatched(tmp_path, monkeypatch):
    bot_home = tmp_path / "bot"
    tools_dir = bot_home / "tools"
    tools_dir.mkdir(parents=True)
    marker = tmp_path / "ping.txt"
    local_src = (
        "from pathlib import Path\n"
        f"MARKER = {str(marker)!r}\n"
        "def cmd_ping(args, reply_to):\n"
        "    Path(MARKER).write_text('pong ' + ' '.join(args), encoding='utf-8')\n"
        "    return 0\n"
        "HANDLERS = {'/ping': cmd_ping}\n"
    )
    (tools_dir / "tg_commands_local.py").write_text(local_src, encoding="utf-8")
    monkeypatch.setenv("BOT_HOME", str(bot_home))

    import tg_commands
    importlib.reload(tg_commands)

    rc = tg_commands.main(["tg_commands.py", "/ping hello"])
    assert rc == 0
    assert marker.read_text(encoding="utf-8") == "pong hello"


def test_bot_handler_wins_over_core_on_collision(tmp_path, monkeypatch):
    bot_home = tmp_path / "bot"
    tools_dir = bot_home / "tools"
    tools_dir.mkdir(parents=True)
    marker = tmp_path / "status_marker.txt"
    local_src = (
        "from pathlib import Path\n"
        f"MARKER = {str(marker)!r}\n"
        "def cmd_status(args, reply_to):\n"
        "    Path(MARKER).write_text('bot-status', encoding='utf-8')\n"
        "    return 0\n"
        "HANDLERS = {'/status': cmd_status}\n"
    )
    (tools_dir / "tg_commands_local.py").write_text(local_src, encoding="utf-8")
    monkeypatch.setenv("BOT_HOME", str(bot_home))

    import tg_commands
    importlib.reload(tg_commands)

    rc = tg_commands.main(["tg_commands.py", "/status"])
    assert rc == 0
    # The core /status handler would shell out to status_footer.py + tg_send.py;
    # if that had run instead, this marker (written only by the bot handler)
    # would not exist.
    assert marker.read_text(encoding="utf-8") == "bot-status"


def test_unknown_command_still_returns_1(tmp_path, monkeypatch):
    bot_home = tmp_path / "bot"
    tools_dir = bot_home / "tools"
    tools_dir.mkdir(parents=True)
    (tools_dir / "tg_commands_local.py").write_text(
        "def cmd_ping(args, reply_to):\n    return 0\nHANDLERS = {'/ping': cmd_ping}\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("BOT_HOME", str(bot_home))

    import tg_commands
    importlib.reload(tg_commands)

    rc = tg_commands.main(["tg_commands.py", "/nope"])
    assert rc == 1


def test_broken_local_file_does_not_break_core(tmp_path, monkeypatch):
    bot_home = tmp_path / "bot"
    tools_dir = bot_home / "tools"
    tools_dir.mkdir(parents=True)
    (tools_dir / "tg_commands_local.py").write_text(
        "raise RuntimeError('boom')\n", encoding="utf-8"
    )
    monkeypatch.setenv("BOT_HOME", str(bot_home))

    import tg_commands
    importlib.reload(tg_commands)

    assert tg_commands._local_handlers() == {}
