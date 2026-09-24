"""daemon/botyaml.mjs + daemon/sync.mjs contract, driven through node.

The parser is the ONE source of bot.yaml defaults for the daemon, the CLI and
the cockpit, so the locked decisions are asserted here rather than remembered:
no driver seam (`cli:`), `harness.service`, the optional `backup:` module that
switches the `backup` entry of BOT_MODULES, and `sync` dropping the
`approved/<id>` marker exactly once per newly allow-listed Telegram id.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

ASSEMBLY = Path(__file__).resolve().parents[2]
BOTYAML = ASSEMBLY / "daemon" / "botyaml.mjs"
SYNC = ASSEMBLY / "daemon" / "sync.mjs"

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node not on PATH")


def _node(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["node", *args], capture_output=True, text=True, timeout=60)


def _effective(tmp_path: Path, text: str) -> dict:
    f = tmp_path / "bot.yaml"
    f.write_text(text, encoding="utf-8")
    r = _node(str(BOTYAML), str(f))
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def test_defaults_have_no_driver_seam_and_carry_the_new_modules(tmp_path):
    cfg = _effective(tmp_path, "name: alpha\n")
    assert "cli" not in cfg
    assert cfg["harness"]["service"] == "daemon"
    assert cfg["backup"] == {"git_remote": None, "paths": ["memory"]}
    assert cfg["integrations"]["cloudflare"] == {"account_id": None, "workers": []}
    assert cfg["integrations"]["google"] == {"account": None}
    assert "backup" not in cfg["_modules"]
    assert cfg["_errors"] == []


def test_backup_remote_switches_the_module_and_is_validated(tmp_path):
    cfg = _effective(tmp_path, "name: alpha\nbackup:\n  git_remote: https://example.com/x.git\n")
    assert "backup" in cfg["_modules"]
    assert cfg["_errors"] == []
    bad = _effective(tmp_path, "name: alpha\nbackup:\n  git_remote: ftp://nope\n  paths: []\n")
    assert any(e.startswith("backup.git_remote") for e in bad["_errors"])
    assert any(e.startswith("backup.paths") for e in bad["_errors"])


def test_service_must_be_daemon_or_manual(tmp_path):
    cfg = _effective(tmp_path, "name: alpha\nharness:\n  service: cron\n")
    assert any(e.startswith("harness.service") for e in cfg["_errors"])


def test_cli_key_is_rejected_outright(tmp_path):
    # Locked B3: Claude only, no driver seam. Even `cli: claude` is a mistake.
    for value in ("codex", "claude"):
        cfg = _effective(tmp_path, f"name: alpha\ncli: {value}\n")
        assert any(e.startswith("cli: not a bot.yaml key") for e in cfg["_errors"]), cfg["_errors"]


def _root_with_bot(tmp_path: Path, name: str, yaml_text: str) -> Path:
    root = tmp_path / "root"
    shutil.copytree(ASSEMBLY / "templates", root / "templates")
    home = root / "bots" / name
    home.mkdir(parents=True)
    (home / "bot.yaml").write_text(yaml_text, encoding="utf-8")
    return root


def test_sync_drops_the_approved_marker_once_per_new_allow_from_id(tmp_path):
    root = _root_with_bot(tmp_path, "beta", "name: beta\nharness:\n  modules:\n    telegram: true\nintegrations:\n  telegram:\n    allow_from: [123456]\n")
    r = _node(str(SYNC), "beta", "--botcorp", str(root))
    assert r.returncode == 0, r.stderr
    tg = root / "bots" / "beta" / ".claude-beta" / "channels" / "telegram"
    access = json.loads((tg / "access.json").read_text(encoding="utf-8"))
    assert access["allowFrom"] == ["123456"] and access["dmPolicy"] == "pairing"
    marker = tg / "approved" / "123456"
    assert marker.exists() and marker.stat().st_size == 0
    # the plugin consumes the marker; a re-sync must not re-create it (no second "Paired!")
    marker.unlink()
    r2 = _node(str(SYNC), "beta", "--botcorp", str(root))
    assert r2.returncode == 0, r2.stderr
    assert not marker.exists()
    assert "approved/123456" not in r2.stdout


def test_hooks_disable_rejects_unknown_names(tmp_path):
    cfg = _effective(tmp_path, "name: alpha\nharness:\n  hooks_disable: [play_sound]\n")
    errs = cfg["_errors"]
    assert len(errs) == 1
    assert errs[0].startswith("harness.hooks_disable: unknown hook(s) play_sound")
    assert "play-sound" in errs[0]


def test_hooks_disable_accepts_real_hook_names(tmp_path):
    cfg = _effective(tmp_path, "name: alpha\nharness:\n  hooks_disable: [play-sound, session-debrief]\n")
    assert cfg["_errors"] == []


def test_tray_defaults_on(tmp_path):
    cfg = _effective(tmp_path, "name: alpha\n")
    assert cfg["harness"]["tray"] is True


def test_sync_settings_pin_bg_isolation_none(tmp_path):
    root = _root_with_bot(tmp_path, "gamma", "name: gamma\n")
    r = _node(str(SYNC), "gamma", "--botcorp", str(root))
    assert r.returncode == 0, r.stderr
    settings = json.loads((root / "bots" / "gamma" / ".claude" / "settings.json").read_text(encoding="utf-8"))
    assert settings["worktree"] == {"bgIsolation": "none"}, r.stderr


def test_sync_settings_turn_off_cc_ui_noise(tmp_path):
    root = _root_with_bot(tmp_path, "delta", "name: delta\n")
    r = _node(str(SYNC), "delta", "--botcorp", str(root))
    assert r.returncode == 0, r.stderr
    settings = json.loads((root / "bots" / "delta" / ".claude" / "settings.json").read_text(encoding="utf-8"))
    assert settings["feedbackSurveyRate"] == 0
    assert settings["feedbackDrafts"] == "off"
    assert settings["spinnerTipsEnabled"] is False
    assert settings["promptSuggestionEnabled"] is False
    assert settings["showTurnDuration"] is False
    assert settings["env"]["CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY"] == "1"
    # would also kill auto-update, so it must never be set
    assert "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC" not in settings["env"]
