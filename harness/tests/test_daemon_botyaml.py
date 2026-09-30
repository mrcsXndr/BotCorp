"""daemon/botyaml.mjs + daemon/sync.mjs contract, driven through node.

The parser is the ONE source of bot.yaml defaults for the daemon, the CLI and
the cockpit, so the locked decisions are asserted here rather than remembered:
no driver seam (`cli:`), `harness.service`, the optional `backup:` module that
switches the `backup` entry of BOT_MODULES, and `sync` dropping the
`approved/<id>` marker exactly once per newly allow-listed Telegram id.
"""
from __future__ import annotations

import json
import os
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


@pytest.mark.parametrize("backups,error", [
    ("[a1, a2, a3, a4, a5, a6]", "at most 5"),
    ("[a1, a1]", "listed twice: a1"),
    ("[main]", "main is the primary"),
    ("[Bad!]", "not an account id"),
    ("spare", "a list of account ids"),
])
def test_backup_accounts_are_validated(tmp_path, backups, error):
    cfg = _effective(tmp_path, f"name: alpha\naccount: main\nbackup_accounts: {backups}\n")
    assert any(e.startswith("backup_accounts") and error in e for e in cfg["_errors"]), cfg["_errors"]


def test_backup_accounts_default_empty_and_a_valid_chain_passes(tmp_path):
    assert _effective(tmp_path, "name: alpha\n")["backup_accounts"] == []
    cfg = _effective(tmp_path, "name: alpha\nbackup_accounts: [spare]\nharness:\n  failover_notify: true\n")
    assert cfg["_errors"] == [] and cfg["backup_accounts"] == ["spare"] and cfg["harness"]["failover_notify"] is True


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


def test_sync_writes_bypass_disclaimer_and_workspace_trust_into_the_config_home(tmp_path):
    """A `--bg` launch with --dangerously-skip-permissions refuses until the
    disclaimer is accepted (USER settings of the config home, not the project
    settings) and the workspace is trusted (.claude.json there). sync writes
    both, MERGING into whatever the operator already keeps in those files."""
    root = _root_with_bot(tmp_path, "epsilon", "name: epsilon\n")
    cfg_home = root / "bots" / "epsilon" / ".claude-epsilon"
    cfg_home.mkdir(parents=True)
    (cfg_home / "settings.json").write_text('{"theme": "dark"}\n', encoding="utf-8")
    (cfg_home / ".claude.json").write_text('{"userID": "u1", "projects": {"C:/elsewhere": {"hasTrustDialogAccepted": false}}}\n', encoding="utf-8")
    r = _node(str(SYNC), "epsilon", "--botcorp", str(root))
    assert r.returncode == 0, r.stderr
    us = json.loads((cfg_home / "settings.json").read_text(encoding="utf-8"))
    assert us["skipDangerousModePermissionPrompt"] is True
    assert us["theme"] == "dark"                       # merged, not regenerated
    cj = json.loads((cfg_home / ".claude.json").read_text(encoding="utf-8"))
    key = str(root / "bots" / "epsilon").replace("\\", "/")
    assert cj["projects"][key]["hasTrustDialogAccepted"] is True
    assert cj["projects"]["C:/elsewhere"]["hasTrustDialogAccepted"] is False   # other records kept
    assert cj["userID"] == "u1"
    # the project settings never carry it (Claude Code ignores it there)
    proj = json.loads((root / "bots" / "epsilon" / ".claude" / "settings.json").read_text(encoding="utf-8"))
    assert "skipDangerousModePermissionPrompt" not in proj


def test_sync_approves_the_harness_rule_imports_and_keeps_every_other_key(tmp_path):
    """v0.8.5: CLAUDE.md imports @../../harness/rules/*.md from outside the bot
    folder; Claude Code loads those only with hasClaudeMdExternalIncludesApproved
    on the project record, and a background session never shows the prompt."""
    root = _root_with_bot(tmp_path, "eta", "name: eta\n")
    cfg_home = root / "bots" / "eta" / ".claude-eta"
    cfg_home.mkdir(parents=True)
    key = str(root / "bots" / "eta").replace("\\", "/")
    before = {"userID": "u1", "oauthAccount": {"emailAddress": "a@b.c"},
              "projects": {key: {"allowedTools": ["Bash(ls)"], "lastCost": 1.5}, "C:/elsewhere": {"hasTrustDialogAccepted": False}}}
    (cfg_home / ".claude.json").write_text(json.dumps(before), encoding="utf-8")
    r = _node(str(SYNC), "eta", "--botcorp", str(root))
    assert r.returncode == 0, r.stderr
    cj = json.loads((cfg_home / ".claude.json").read_text(encoding="utf-8"))
    rec = cj["projects"][key]
    assert rec["hasClaudeMdExternalIncludesApproved"] is True and rec["hasClaudeMdExternalIncludesWarningShown"] is True
    assert rec["hasTrustDialogAccepted"] is True
    assert rec["allowedTools"] == ["Bash(ls)"] and rec["lastCost"] == 1.5          # the record is merged
    assert cj["userID"] == "u1" and cj["oauthAccount"] == before["oauthAccount"]
    assert cj["projects"]["C:/elsewhere"] == {"hasTrustDialogAccepted": False}     # other projects untouched
    assert not (cfg_home / ".claude.json.tmp").exists()                              # written via tmp + rename
    # idempotent: a second sync leaves the file byte-identical
    text = (cfg_home / ".claude.json").read_text(encoding="utf-8")
    assert _node(str(SYNC), "eta", "--botcorp", str(root)).returncode == 0
    assert (cfg_home / ".claude.json").read_text(encoding="utf-8") == text
    # a file that does not parse is left alone, never replaced by just our keys
    (cfg_home / ".claude.json").write_text('{"userID": "u1", "projects": {', encoding="utf-8")
    r = _node(str(SYNC), "eta", "--botcorp", str(root))
    assert r.returncode == 0, r.stderr
    assert "skipped (not valid JSON" in r.stdout
    assert (cfg_home / ".claude.json").read_text(encoding="utf-8") == '{"userID": "u1", "projects": {'


def test_sync_puts_the_context_window_in_the_config_home_env(tmp_path):
    """v0.8.5: a machine-wide CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000 +
    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50 reached the background worker although
    the launch set the bot's own. A settings `env` entry is written into Claude
    Code's process env over the inherited value, so sync puts the window there;
    PCT 100 is ignored by Claude Code (it can only lower the threshold)."""
    root = _root_with_bot(tmp_path, "theta", "name: theta\nmodel: claude-opus-5-5\nharness:\n  context_window: 25%\n")
    cfg_home = root / "bots" / "theta" / ".claude-theta"
    cfg_home.mkdir(parents=True)
    (cfg_home / "settings.json").write_text(json.dumps({"theme": "dark", "env": {"OPERATOR_VAR": "1", "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "500000"}}), encoding="utf-8")
    r = _node(str(SYNC), "theta", "--botcorp", str(root))
    assert r.returncode == 0, r.stderr
    us = json.loads((cfg_home / "settings.json").read_text(encoding="utf-8"))
    assert us["env"] == {"OPERATOR_VAR": "1", "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "250000", "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "100"}
    assert us["autoCompactWindow"] == 250000 and us["theme"] == "dark"
    # 'auto': both entries go, the operator's own stays; an env left empty is dropped
    (root / "bots" / "theta" / "bot.yaml").write_text("name: theta\nharness:\n  context_window: auto\n", encoding="utf-8")
    assert _node(str(SYNC), "theta", "--botcorp", str(root)).returncode == 0
    assert json.loads((cfg_home / "settings.json").read_text(encoding="utf-8"))["env"] == {"OPERATOR_VAR": "1"}
    (cfg_home / "settings.json").write_text(json.dumps({"env": {"CLAUDE_CODE_AUTO_COMPACT_WINDOW": "250000"}}), encoding="utf-8")
    assert _node(str(SYNC), "theta", "--botcorp", str(root)).returncode == 0
    assert "env" not in json.loads((cfg_home / "settings.json").read_text(encoding="utf-8"))


def test_sync_excludes_the_operators_user_claude_md(tmp_path):
    """v0.8.5: Claude Code walks up from the bot folder and loads
    <home>/.claude/CLAUDE.md (the operator's own user memory) as project memory;
    the generated settings exclude it (claudeMdExcludes, absolute path)."""
    root = _root_with_bot(tmp_path, "iota", "name: iota\n")
    home = tmp_path / "fakehome"
    home.mkdir()
    r = subprocess.run(["node", str(SYNC), "iota", "--botcorp", str(root)], capture_output=True, text=True, timeout=60,
                       env={**os.environ, "USERPROFILE": str(home), "HOME": str(home)})
    assert r.returncode == 0, r.stderr
    proj = json.loads((root / "bots" / "iota" / ".claude" / "settings.json").read_text(encoding="utf-8"))
    assert proj["claudeMdExcludes"] == [str(home / ".claude" / "CLAUDE.md").replace("\\", "/")]


def test_sync_does_not_add_the_disclaimer_key_for_a_default_permissions_bot(tmp_path):
    root = _root_with_bot(tmp_path, "zeta", "name: zeta\npermissions: default\n")
    r = _node(str(SYNC), "zeta", "--botcorp", str(root))
    assert r.returncode == 0, r.stderr
    us = json.loads((root / "bots" / "zeta" / ".claude-zeta" / "settings.json").read_text(encoding="utf-8"))
    assert "skipDangerousModePermissionPrompt" not in us
    cj = json.loads((root / "bots" / "zeta" / ".claude-zeta" / ".claude.json").read_text(encoding="utf-8"))
    assert cj["projects"][str(root / "bots" / "zeta").replace("\\", "/")]["hasTrustDialogAccepted"] is True


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


def test_generated_settings_disable_autoupdater(tmp_path):
    # R3: a bot runs the pinned Claude Code (daemon/cc.ps1), so its session never
    # downloads an update itself; DISABLE_UPDATES would also block `claude update`
    # for every other Claude Code user of the box, so it is never set.
    root = _root_with_bot(tmp_path, "eta", "name: eta\n")
    r = _node(str(SYNC), "eta", "--botcorp", str(root))
    assert r.returncode == 0, r.stderr
    settings = json.loads((root / "bots" / "eta" / ".claude" / "settings.json").read_text(encoding="utf-8"))
    assert settings["env"]["DISABLE_AUTOUPDATER"] == "1"
    assert "DISABLE_UPDATES" not in settings["env"]
