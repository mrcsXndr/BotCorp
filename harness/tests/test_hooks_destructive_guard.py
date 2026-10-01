"""(v0.9.11) destructive-guard: a bot never wipes a root, a home, a bot folder, a .git or main.

`node guard.mjs pre` on a Bash or PowerShell call blocks (exit 2, BLOCKED on
stderr, the operator's terminal named) the commands in BLOCKED and passes the
everyday ones in ALLOWED, on both shells.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from test_hooks_fake_stdin import HARNESS, HOOKS, base_env, bot_home, run_hook  # noqa: F401
from test_operator_only import needs_node

ROOT = HARNESS.parent
HOME = Path.home()

BLOCKED = [
    "rm -rf /",
    "rm -rf /*",
    "sudo rm -rf --no-preserve-root /",
    "rm -rf ~",
    'rm -rf "$HOME"',
    "rm -rf ~/*",
    "rm -r /c",
    f"rm -rf {HOME}",
    f"rm -rf {HOME.parent}",
    "Remove-Item -Recurse -Force C:\\",
    "Remove-Item -Path 'D:\\' -Recurse -Force",
    "ri -r -fo $env:USERPROFILE",
    "rd /s /q C:\\",
    "del /s /q C:\\*",
    "cmd /c rd /s /q D:\\",
    'cmd /c "rd /s /q D:\\"',
    'bash -c "rm -rf /"',
    "pwsh -NoProfile -Command Remove-Item -Recurse -Force C:\\",
    f"rm -rf {ROOT}",
    f"rm -rf {ROOT / 'bots'}",
    f"Remove-Item -Recurse -Force {ROOT / 'bots' / 'demo'}",
    "rm -rf .git",
    "rm -rf C:/x/repo/.git/",
    "cd C:/x && git status && rm -rf $BOT_HOME",
    "git push --force origin main",
    "git push -f origin master",
    "git -C C:/x/repo push origin +main",
    "git push --force-with-lease origin HEAD:refs/heads/main",
    "git reset --hard && git clean -fdx",
    "git reset --hard origin/main; git clean -xdf",
    "format C:",
    "diskpart /s wipe.txt",
    "mkfs.ext4 /dev/sda1",
    "Format-Volume -DriveLetter D",
]

ALLOWED = [
    "rm -rf node_modules",
    "rm -rf $CLAUDE_JOB_DIR/tmp/x",
    "rm file.txt",
    "rm -f /tmp/x.log",
    "rm -rf ./dist build/.cache",
    f"rm -rf {HOME / '.cache' / 'x'}",
    f"rm -rf {ROOT / 'bots' / 'demo' / 'memory' / 'tmp'}",
    "Remove-Item -Recurse -Force .\\dist",
    "Remove-Item -Force C:\\tmp\\x.txt",
    "del C:\\tmp\\x.txt",
    "rm -rf .git/hooks/pre-commit",
    "git push",
    "git push origin feat/x",
    "git push --force origin feat/x",
    "git push -u origin main",
    "git reset --hard origin/main",
    "git clean -fdx",
    'git commit -m "rm -rf / is now blocked; git push --force origin main too"',
    "git log --format=%H -1",
    "Get-Process | Format-Table",
    'echo "rm -rf /"',
]


def _pre(env, tool, command):
    return subprocess.run(["node", str(HOOKS / "guard.mjs"), "pre"], input=json.dumps({"tool_name": tool, "tool_input": {"command": command}}),
                          capture_output=True, text=True, env=env, timeout=30)


@needs_node
@pytest.mark.parametrize("tool", ["Bash", "PowerShell"])
@pytest.mark.parametrize("command", BLOCKED)
def test_blocks_destructive_commands(tmp_path, bot_home, tool, command):
    p = _pre(base_env(tmp_path, bot_home), tool, command)
    assert p.returncode == 2, (command, p.stdout + p.stderr)
    assert "BLOCKED" in p.stderr and "destructive-guard" in p.stderr and "their own terminal" in p.stderr


@needs_node
@pytest.mark.parametrize("tool", ["Bash", "PowerShell"])
@pytest.mark.parametrize("command", ALLOWED)
def test_allows_everyday_commands(tmp_path, bot_home, tool, command):
    p = _pre(base_env(tmp_path, bot_home), tool, command)
    assert p.returncode == 0, (command, p.stderr)
    assert p.stderr == ""


@needs_node
def test_the_bot_folder_itself_and_the_wrapper(tmp_path, bot_home):
    env = base_env(tmp_path, bot_home)
    p = run_hook("destructive-guard.sh", env, json.dumps({"tool_name": "Bash", "tool_input": {"command": f'rm -rf "{bot_home}"'}}))
    assert p.returncode == 2 and "the bot folder" in p.stderr, p.stderr
    p = run_hook("destructive-guard.sh", env, json.dumps({"tool_name": "Bash", "tool_input": {"command": f'rm -rf "{bot_home / "memory" / "x"}"'}}))
    assert p.returncode == 0, p.stderr
    # fails closed on a payload it cannot parse; reads the command field only
    assert run_hook("destructive-guard.sh", env, "{not json").returncode == 2
    assert run_hook("destructive-guard.sh", env, json.dumps({"tool_name": "Grep", "tool_input": {"pattern": "rm -rf /"}})).returncode == 0
