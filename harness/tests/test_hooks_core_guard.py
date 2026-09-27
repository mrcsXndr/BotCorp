"""Fake-stdin tests for harness/hooks/core-guard.sh (v0.7.3).

Locked behaviour: the guard warns when a TRACKED file of the BotCorp checkout
is modified off a suggest/* branch, whatever form the payload path takes. On
Windows Claude Code sends `C:\\...` while Git Bash's `pwd` is `/c/...`; before
v0.7.3 the containment check compared those two forms and never fired there.
The warning says what actually happens: the updater refuses a dirty tree, so
an in-place edit blocks every future update.
"""
from __future__ import annotations

import json
import subprocess
import sys

import pytest

from test_hooks_fake_stdin import HOOKS, base_env, bot_home  # noqa: F401


@pytest.fixture
def checkout(tmp_path):
    bc = tmp_path / "BotCorp"
    (bc / "harness" / "rules").mkdir(parents=True)
    (bc / "bots" / "b").mkdir(parents=True)
    (bc / "harness" / "rules" / "coding.md").write_text("x\n", encoding="utf-8")
    (bc / "bots" / "b" / "tracked.md").write_text("x\n", encoding="utf-8")
    for args in (["init", "-q", "-b", "main"], ["config", "user.email", "t@example.invalid"],
                 ["config", "user.name", "T"], ["add", "-A"], ["commit", "-q", "-m", "init"]):
        subprocess.run(["git", *args], cwd=bc, check=True)
    (bc / "harness" / "untracked.md").write_text("x\n", encoding="utf-8")
    return bc


def _run(tmp_path, bot_home, bc, file_path):
    env = base_env(tmp_path, bot_home, {"CLAUDE_PLUGIN_ROOT": str(bc / "harness")})
    # the warning carries an emoji: decode as UTF-8, not the console code page
    return subprocess.run(
        ["bash", str(HOOKS / "core-guard.sh")], input=json.dumps({"tool_input": {"file_path": file_path}}),
        capture_output=True, text=True, encoding="utf-8", env=env, timeout=30,
    )


def _forms(p):
    s = str(p)
    forms = [s, s.replace("\\", "/")]
    if sys.platform == "win32":
        drive, rest = s[0], s[2:].replace("\\", "/")
        forms += [drive.lower() + s[1:], f"/{drive.lower()}{rest}"]
    return forms


def test_warns_on_a_tracked_file_in_every_path_form(tmp_path, bot_home, checkout):
    for form in _forms(checkout / "harness" / "rules" / "coding.md"):
        proc = _run(tmp_path, bot_home, checkout, form)
        assert proc.returncode == 0, proc.stderr
        assert "HARNESS-CONTRACT WARNING" in proc.stdout, form
        assert "harness/rules/coding.md" in proc.stdout
        assert "blocks every future" in proc.stdout and "overwrites" not in proc.stdout


@pytest.mark.parametrize("rel", ["harness/untracked.md", "bots/b/tracked.md"])
def test_silent_for_untracked_and_bot_files(tmp_path, bot_home, checkout, rel):
    proc = _run(tmp_path, bot_home, checkout, str(checkout / rel))
    assert proc.returncode == 0 and proc.stdout == ""


def test_silent_outside_the_checkout_and_on_a_suggest_branch(tmp_path, bot_home, checkout):
    proc = _run(tmp_path, bot_home, checkout, str(bot_home / "memory" / "TDL.md"))
    assert proc.returncode == 0 and proc.stdout == ""
    subprocess.run(["git", "checkout", "-q", "-b", "suggest/x"], cwd=checkout, check=True)
    proc = _run(tmp_path, bot_home, checkout, str(checkout / "harness" / "rules" / "coding.md"))
    assert proc.returncode == 0 and proc.stdout == ""
