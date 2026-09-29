"""R5a step 2: the operator-guard hook, and PowerShell under the vault guard.

Fake-stdin runs (the test_hooks_fake_stdin.py pattern):
- operator-guard.sh blocks `botcorp approve|reject|accounts use`
  in a Bash or PowerShell command (exit 2, BLOCKED on stderr), and never looks
  at anything but the command field (a Grep for "approve" passes).
- hooks.json registers it for Bash|PowerShell, and vault-guard's matcher now
  includes PowerShell (a bot's PowerShell call used to bypass it).
- (v0.8.3) `botcorp cockpit pair|unpair` is blocked for every bot, an admin bot
  included, by the hook and by the CLI (exit 3, no code minted); vault-guard
  blocks the pairing key and the pairing file.
"""
from __future__ import annotations

import json

import pytest

from test_admin_role import ID_BOSS, ID_PEON, abox  # noqa: F401 (abox is a fixture)
from test_hooks_fake_stdin import HARNESS, HOOKS, base_env, bot_home, run_hook  # noqa: F401
from test_operator_only import cli, needs_node


def _run(env, hook, tool_name, tool_input):
    return run_hook(hook, env, json.dumps({"tool_name": tool_name, "tool_input": tool_input}))


@pytest.mark.parametrize("tool", ["Bash", "PowerShell"])
@pytest.mark.parametrize("command", [
    "node cli/botcorp.mjs approve alpha 3",
    'node "C:\\x\\BotCorp\\cli\\botcorp.mjs" approve alpha --all',
    "botcorp reject beta ab12cd --reason x",
    "BC=1 node cli/botcorp.mjs accounts use alpha acc1",
    "node cli/botcorp.mjs update --rollback v0.7.7",
    "botcorp update --cancel v0.8.0",
])
def test_blocks_operator_verbs(tmp_path, bot_home, tool, command):
    proc = _run(base_env(tmp_path, bot_home), "operator-guard.sh", tool, {"command": command})
    assert proc.returncode == 2, proc.stdout + proc.stderr
    assert "BLOCKED" in proc.stderr and "operator-only" in proc.stderr


@pytest.mark.parametrize("tool,tool_input", [
    ("Grep", {"pattern": "approve"}),
    ("Bash", {"command": "node cli/botcorp.mjs approvals --json"}),
    ("Bash", {"command": "node cli/botcorp.mjs update --json"}),
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


@needs_node
@pytest.mark.parametrize("tool", ["Bash", "PowerShell"])
@pytest.mark.parametrize("command", [
    "botcorp cockpit pair",
    "node cli/botcorp.mjs cockpit pair --json",
    'node "C:\\x\\BotCorp\\cli\\botcorp.mjs" cockpit unpair --all',
    "botcorp cockpit unpair 0123456789abcdef",
])
def test_blocks_cockpit_pair_even_for_an_admin_bot(abox, tool, command):
    rt, bots, op, as_bot = abox
    boss = {**as_bot("boss", ID_BOSS), "CLAUDE_PLUGIN_ROOT": str(HARNESS)}
    proc = _run(boss, "operator-guard.sh", tool, {"command": command})
    assert proc.returncode == 2, proc.stdout + proc.stderr
    assert "BLOCKED" in proc.stderr and "pair" in proc.stderr
    # positive control: the same session passes a verb an admin may run
    assert _run(boss, "operator-guard.sh", tool, {"command": "botcorp approve peon 9e0001"}).returncode == 0


@needs_node
def test_cli_refuses_cockpit_pair_in_any_bot_session(abox):
    rt, bots, op, as_bot = abox
    pairing = rt / "state" / "cockpit-pairing.json"
    for env in (as_bot("boss", ID_BOSS), as_bot("peon", ID_PEON)):
        for args in (("cockpit", "pair"), ("cockpit", "unpair", "--all")):
            r = cli(env, *args)
            assert r.returncode == 3 and "operator-only" in r.stderr, (args, r.stdout + r.stderr)
    assert not pairing.exists()
    # the operator's terminal mints one; the file keeps only its hash
    r = cli(op, "cockpit", "pair", "--json")
    assert r.returncode == 0, r.stdout + r.stderr
    code = json.loads(r.stdout)["code"]
    stored = pairing.read_text(encoding="utf-8")
    assert code not in stored and code.replace("-", "") not in stored and '"sha256"' in stored


@pytest.mark.parametrize("tool,tool_input", [
    ("Read", {"file_path": "D:\\rt\\.botcorp\\state\\cockpit-operator.key"}),
    ("Bash", {"command": "cat ~/.botcorp/state/cockpit-pairing.json"}),
    ("PowerShell", {"command": "Set-Content $env:USERPROFILE\\.botcorp\\state\\cockpit-pairing.json '{}'"}),
])
def test_vault_guard_blocks_the_pairing_files(tmp_path, bot_home, tool, tool_input):
    proc = _run(base_env(tmp_path, bot_home), "vault-guard.sh", tool, tool_input)
    assert proc.returncode == 2 and "pairing" in proc.stderr, proc.stderr


def test_vault_guard_passes_the_pairing_module_source(tmp_path, bot_home):
    proc = _run(base_env(tmp_path, bot_home), "vault-guard.sh", "Read", {"file_path": "C:/x/BotCorp/cockpit/operator-pair.mjs"})
    assert proc.returncode == 0, proc.stderr


def test_hooks_json_registers_both_for_powershell():
    hooks = json.loads((HOOKS / "hooks.json").read_text(encoding="utf-8"))["hooks"]["PreToolUse"]

    def matchers(script):
        return [set(g["matcher"].split("|")) for g in hooks if any(script in h["command"] for h in g["hooks"])]

    assert any({"Bash", "PowerShell"} <= m for m in matchers("operator-guard.sh"))
    assert any({"Read", "Grep", "Bash", "PowerShell"} <= m for m in matchers("vault-guard.sh"))
