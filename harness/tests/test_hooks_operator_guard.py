"""R5a step 2: the operator-guard hook, and PowerShell under the vault guard.

Fake-stdin runs (the test_hooks_fake_stdin.py pattern):
- operator-guard.sh blocks `botcorp approve|reject|accounts use`
  in a Bash or PowerShell command (exit 2, BLOCKED on stderr), and never looks
  at anything but the command field (a Grep for "approve" passes).
- hooks.json registers it for Bash|PowerShell, and vault-guard's matcher now
  includes PowerShell (a bot's PowerShell call used to bypass it).
"""
from __future__ import annotations

import json

import pytest

from test_hooks_fake_stdin import HOOKS, base_env, bot_home, run_hook  # noqa: F401


def _run(env, hook, tool_name, tool_input):
    return run_hook(hook, env, json.dumps({"tool_name": tool_name, "tool_input": tool_input}))


@pytest.mark.parametrize("tool", ["Bash", "PowerShell"])
@pytest.mark.parametrize("command", [
    "node cli/botcorp.mjs approve alpha 3",
    'node "C:\\x\\BotCorp\\cli\\botcorp.mjs" approve alpha --all',
    "botcorp reject beta ab12cd --reason x",
    "BC=1 node cli/botcorp.mjs accounts use alpha acc1",
])
def test_blocks_operator_verbs(tmp_path, bot_home, tool, command):
    proc = _run(base_env(tmp_path, bot_home), "operator-guard.sh", tool, {"command": command})
    assert proc.returncode == 2, proc.stdout + proc.stderr
    assert "BLOCKED" in proc.stderr and "operator-only" in proc.stderr


@pytest.mark.parametrize("tool,tool_input", [
    ("Grep", {"pattern": "approve"}),
    ("Bash", {"command": "node cli/botcorp.mjs approvals --json"}),
    ("Bash", {"command": "node cli/botcorp.mjs config set alpha automations.x.enabled true"}),
    ("PowerShell", {"command": "git log --grep approve"}),
    ("Read", {"file_path": "C:/x/botcorp/approve.md"}),
])
def test_allows_everything_else(tmp_path, bot_home, tool, tool_input):
    proc = _run(base_env(tmp_path, bot_home), "operator-guard.sh", tool, tool_input)
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout == "" and proc.stderr == ""


def test_vault_guard_blocks_a_powershell_vault_read(tmp_path, bot_home):
    cmd = "Get-Content C:\\x\\bots\\demo\\.vault\\secrets.json"
    proc = _run(base_env(tmp_path, bot_home), "vault-guard.sh", "PowerShell", {"command": cmd})
    assert proc.returncode == 2
    assert "BLOCKED" in proc.stderr


def test_hooks_json_registers_both_for_powershell():
    hooks = json.loads((HOOKS / "hooks.json").read_text(encoding="utf-8"))["hooks"]["PreToolUse"]

    def matchers(script):
        return [set(g["matcher"].split("|")) for g in hooks if any(script in h["command"] for h in g["hooks"])]

    assert any({"Bash", "PowerShell"} <= m for m in matchers("operator-guard.sh"))
    assert any({"Read", "Grep", "Bash", "PowerShell"} <= m for m in matchers("vault-guard.sh"))
