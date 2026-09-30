"""v0.8.6 R5: guard bypasses from the 2026-09-30 daemon/harness review, closed.

Locked behaviour:
- config-guard: an Edit/Write/MultiEdit of `.claude/settings.local.json` or
  the config home's `settings.json` that changes `env` or `disableAllHooks`
  is blocked (either can switch the guards off for the session); any other
  change to those files (a bot's own hook) passes;
- BOT_DISABLED_HOOKS never switches off vault-guard or operator-guard (bot.yaml
  already refuses to), whatever the session env says;
- vault-guard: a relative `.vault` path, and the vault's own PowerShell
  functions (Get-VaultSecret after dot-sourcing _common.ps1 / vault.ps1);
- operator-guard: a quoted verb, `$BC <verb>`, a line continuation, and an
  `env -u BOT_NAME` prefix;
- config-guard and operator-guard fail CLOSED on a payload they cannot parse;
- Monitor and MCP tools meet vault-guard and operator-guard on their
  `command`; an MCP tool's other text (a Telegram reply) is not scanned.
"""
from __future__ import annotations

import json
import shutil
import subprocess

import pytest

from test_hooks_fake_stdin import HOOKS, base_env, bot_home  # noqa: F401

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node not on PATH")

GUARD = HOOKS / "guard.mjs"


def _guard(env, mode, payload):
    return subprocess.run(["node", str(GUARD), mode], input=payload if isinstance(payload, str) else json.dumps(payload),
                          capture_output=True, text=True, encoding="utf-8", env=env, timeout=60)


def _pre(env, tool, ti):
    return _guard(env, "pre", {"hook_event_name": "PreToolUse", "tool_name": tool, "tool_input": ti})


# --- finding 1: the settings files that can switch every guard off ---------------------------
def _local(bot_home):
    p = bot_home / ".claude" / "settings.local.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"hooks": {}}, indent=2) + "\n", encoding="utf-8")
    return p


def test_settings_local_env_or_disable_all_hooks_is_blocked(tmp_path, bot_home):
    env = base_env(tmp_path, bot_home)
    p = _local(bot_home)
    f = str(p)
    for tool, ti in [
        ("Write", {"file_path": f, "content": json.dumps({"env": {"BOT_DISABLED_HOOKS": "vault-guard,operator-guard,config-guard"}})}),
        ("Write", {"file_path": f, "content": json.dumps({"hooks": {}, "disableAllHooks": True})}),
        ("Edit", {"file_path": f, "old_string": '"hooks": {}', "new_string": '"hooks": {},\n  "env": {"NODE_OPTIONS": "--require x.js"}'}),
        ("MultiEdit", {"file_path": f, "edits": [{"old_string": '"hooks": {}', "new_string": '"disableAllHooks": true'}]}),
        ("Write", {"file_path": str(tmp_path / "cfg" / "settings.json"), "content": json.dumps({"env": {"BOT_DISABLED_HOOKS": "config-guard"}})}),
    ]:
        r = _pre(env, tool, ti)
        assert r.returncode == 2 and "BLOCKED" in r.stderr, (tool, ti, r.stderr)


def test_settings_local_hooks_still_edit_freely(tmp_path, bot_home):
    env = base_env(tmp_path, bot_home)
    p = _local(bot_home)
    hooks = {"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "echo hi"}]}]}}
    assert _pre(env, "Write", {"file_path": str(p), "content": json.dumps(hooks)}).returncode == 0
    r = _pre(env, "Edit", {"file_path": str(p), "old_string": '"hooks": {}', "new_string": json.dumps(hooks)[1:-1]})
    assert r.returncode == 0, r.stderr


def test_the_session_env_cannot_disable_the_vault_or_operator_guard(tmp_path, bot_home):
    env = base_env(tmp_path, bot_home, {"BOT_DISABLED_HOOKS": "vault-guard,operator-guard"})
    assert _pre(env, "Read", {"file_path": str(bot_home / ".vault" / "secrets.json")}).returncode == 2
    assert _pre(env, "Bash", {"command": "botcorp approve alpha 3"}).returncode == 2
    # a guard bot.yaml may switch off still can be
    env = base_env(tmp_path, bot_home, {"BOT_DISABLED_HOOKS": "config-guard"})
    assert _pre(env, "Edit", {"file_path": str(bot_home / "bot.yaml")}).returncode == 0


# --- finding 2: vault-guard's plain misses -----------------------------------------------------
@pytest.mark.parametrize("command", [
    "cat .vault/secrets.json",
    "cd .vault && cat secrets.json",
    "type .vault\\secrets.json",
    ". daemon/_common.ps1; Get-VaultSecret -BotHome . -Bot demo -Key oauth_token -Reason cli",
    ". ./daemon/vault.ps1; Read-VaultStore .",
])
def test_vault_guard_blocks_the_reviewed_misses(tmp_path, bot_home, command):
    r = _pre(base_env(tmp_path, bot_home), "PowerShell", {"command": command})
    assert r.returncode == 2 and "BLOCKED" in r.stderr, (command, r.stderr)


# --- finding 4: operator-guard spellings ------------------------------------------------------
@pytest.mark.parametrize("command", [
    'node cli/botcorp.mjs "approve" alpha 3',
    "node cli/botcorp.mjs 'reject' alpha ab12",
    "$BC approve alpha 3",
    "& $BC secrets set alpha x",
    "node cli/botcorp.mjs \\\n  approve alpha 3",
    "node cli\\botcorp.mjs `\n  approve alpha 3",
    'env -u BOT_NAME -u CLAUDECODE node cli/botcorp.mjs "approve" alpha 3',
])
def test_operator_guard_blocks_the_reviewed_spellings(tmp_path, bot_home, command):
    r = _pre(base_env(tmp_path, bot_home), "Bash", {"command": command})
    assert r.returncode == 2 and "operator-only" in r.stderr, (command, r.stderr)


@pytest.mark.parametrize("command", ["echo $BC", "node cli/botcorp.mjs approvals --json", "$BC status alpha"])
def test_operator_guard_still_passes_read_only_verbs(tmp_path, bot_home, command):
    assert _pre(base_env(tmp_path, bot_home), "Bash", {"command": command}).returncode == 0


# --- finding 5: fail closed --------------------------------------------------------------------
@pytest.mark.parametrize("guard", ["config-guard", "operator-guard"])
@pytest.mark.parametrize("payload", ["{not json", "[1, 2]", '{"tool_name": "Bash", "tool_input": "x"}'])
def test_config_and_operator_guard_fail_closed(tmp_path, bot_home, guard, payload):
    r = _guard(base_env(tmp_path, bot_home), guard, payload)
    assert r.returncode == 2 and "could not parse" in r.stderr, r.stderr


# --- finding 6: tools outside the old matchers -------------------------------------------------
def test_monitor_and_mcp_shell_tools_meet_the_guards(tmp_path, bot_home):
    env = base_env(tmp_path, bot_home)
    assert _pre(env, "Monitor", {"command": "tail -f .vault/secrets.json", "description": "x", "timeout_ms": 1000}).returncode == 2
    assert _pre(env, "Monitor", {"command": "node cli/botcorp.mjs approve alpha 3", "description": "x", "timeout_ms": 1000}).returncode == 2
    assert _pre(env, "mcp__windows__Powershell-Tool", {"command": "Get-Content .vault/secrets.json"}).returncode == 2
    # an MCP tool's message text is not a command
    assert _pre(env, "mcp__plugin_telegram_telegram__reply", {"chat_id": "1", "text": "the .vault is off-limits; botcorp approve is yours"}).returncode == 0
    assert _pre(env, "Monitor", {"command": "tail -f memory/metrics/alerts.log", "description": "x", "timeout_ms": 1000}).returncode == 0
