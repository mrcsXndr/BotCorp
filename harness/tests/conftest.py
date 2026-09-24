"""Shared pytest fixtures for harness/tests.

- Puts harness/tools/v2 and harness/tools on sys.path so `import journal`,
  `import recall`, `import gh_projects`, etc. work the same way the modules'
  own same-dir sibling imports do (they each do
  `sys.path.insert(0, str(Path(__file__).resolve().parent))` internally).
- An autouse fixture sets BOT_TG_MUTE=1 (no test may ever send a real
  Telegram message) and points BOT_HOME / BOTCORP_HOME / CLAUDE_CONFIG_DIR at
  fresh per-test tmp dirs, so instance_root() / runtime_root() / config_home()
  never resolve into the real user's home or a real bot's memory/ tree even
  for code that reads them at CALL time. Modules that compute a path constant
  at IMPORT time (most of tools/v2/*.py) still need their own fixture to
  monkeypatch that specific constant — this is defense in depth, not a
  substitute for that.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

HARNESS_ROOT = Path(__file__).resolve().parents[1]
TOOLS_DIR = HARNESS_ROOT / "tools"
V2_DIR = TOOLS_DIR / "v2"

for p in (str(V2_DIR), str(TOOLS_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)


@pytest.fixture(autouse=True)
def isolated_bot_env(tmp_path, monkeypatch):
    """Never touch the real user home, a real bot's memory/, or send TG."""
    monkeypatch.setenv("BOT_TG_MUTE", "1")
    monkeypatch.setenv("BOT_HOME", str(tmp_path / "bot_home"))
    monkeypatch.setenv("BOTCORP_HOME", str(tmp_path / "botcorp_home"))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude_config"))
    monkeypatch.setenv("BOT_NAME", "testbot")
    yield
