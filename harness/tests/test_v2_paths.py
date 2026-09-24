"""Tests for the path seam (harness/tools/_paths.py).

instance_root() precedence is the one thing every ported tools/v2/*.py module
depends on to find the bot's own memory/.claude/.env instead of the shared
harness — a regression here silently breaks every module at once.
"""
from __future__ import annotations

from pathlib import Path

import _paths


def test_instance_root_prefers_bot_home(tmp_path, monkeypatch):
    bot_home = tmp_path / "bot"
    project_dir = tmp_path / "project"
    monkeypatch.setenv("BOT_HOME", str(bot_home))
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(project_dir))
    assert _paths.instance_root() == bot_home.resolve()


def test_instance_root_falls_back_to_claude_project_dir(tmp_path, monkeypatch):
    project_dir = tmp_path / "project"
    monkeypatch.delenv("BOT_HOME", raising=False)
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(project_dir))
    assert _paths.instance_root() == project_dir.resolve()


def test_instance_root_falls_back_to_cwd(tmp_path, monkeypatch):
    monkeypatch.delenv("BOT_HOME", raising=False)
    monkeypatch.delenv("CLAUDE_PROJECT_DIR", raising=False)
    monkeypatch.chdir(tmp_path)
    assert _paths.instance_root() == tmp_path.resolve()


def test_harness_root_is_the_harness_checkout(tmp_path, monkeypatch):
    # harness_root() is derived from _paths.py's own location, not any env var.
    assert _paths.harness_root().name == "harness"
    assert (_paths.harness_root() / "tools" / "_paths.py").is_file()


def test_botcorp_root_is_harness_parent():
    assert _paths.botcorp_root() == _paths.harness_root().parent


def test_config_home_prefers_claude_config_dir(tmp_path, monkeypatch):
    cfg = tmp_path / "cfg"
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(cfg))
    assert _paths.config_home() == cfg.resolve()


def test_runtime_root_prefers_botcorp_home(tmp_path, monkeypatch):
    rt = tmp_path / "rt"
    monkeypatch.setenv("BOTCORP_HOME", str(rt))
    assert _paths.runtime_root() == rt.resolve()


def test_bot_name_prefers_env_then_falls_back_to_instance_root_name(tmp_path, monkeypatch):
    monkeypatch.setenv("BOT_NAME", "my-explicit-bot")
    assert _paths.bot_name() == "my-explicit-bot"
    monkeypatch.delenv("BOT_NAME", raising=False)
    bot_home = tmp_path / "some-bot-dir"
    bot_home.mkdir()
    monkeypatch.setenv("BOT_HOME", str(bot_home))
    assert _paths.bot_name() == "some-bot-dir"


def test_module_enabled_default_all_on(monkeypatch):
    monkeypatch.delenv("BOT_MODULES", raising=False)
    assert _paths.module_enabled("anything") is True


def test_module_enabled_respects_allowlist(monkeypatch):
    monkeypatch.setenv("BOT_MODULES", "journal, recall")
    assert _paths.module_enabled("journal") is True
    assert _paths.module_enabled("recall") is True
    assert _paths.module_enabled("alert_triage") is False
