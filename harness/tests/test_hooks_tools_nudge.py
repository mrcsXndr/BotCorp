"""R5a step 13: the tools-nudge hook.

Fake-stdin runs (the test_hooks_fake_stdin.py pattern) against a fixture bot:
- a Write of an executable under tools/ that no `tools:` entry covers prints
  exactly one line (the register command) and exits 0;
- a registered path, a glob-covered path, a private module and a non-code file
  print nothing;
- with `tools:` absent from bot.yaml the registry is off and nothing prints;
- hooks.json registers it as PostToolUse on Write|Edit.
"""
from __future__ import annotations

import json
import shutil
import subprocess

import pytest

from test_hooks_fake_stdin import HOOKS, base_env, bot_home, run_hook  # noqa: F401

needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="node not on PATH")

REGISTERED = (
    "tools:\n"
    "  - name: probe\n"
    "    path: tools/probe.py\n"
    "    kind: monitor\n"
    "  - name: lib\n"
    "    path: tools/lib/*.py\n"
    "    kind: lib\n"
)


def _bot(home, tools=True):
    (home / "bot.yaml").write_text("name: nudgebot\n" + (REGISTERED if tools else ""), encoding="utf-8")
    return home


def _write(tmp_path, home, rel, tool="Write"):
    target = home / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("print('hi')\n", encoding="utf-8")
    payload = json.dumps({"tool_name": tool, "tool_input": {"file_path": str(target), "content": "print('hi')\n"}})
    return run_hook("tools-nudge.sh", base_env(tmp_path, home), payload)


@needs_node
@pytest.mark.parametrize("tool", ["Write", "Edit"])
def test_unregistered_tool_gets_one_warn_line(tmp_path, bot_home, tool):
    proc = _write(tmp_path, _bot(bot_home), "tools/new_thing.py", tool)
    assert proc.returncode == 0, proc.stderr
    lines = proc.stdout.splitlines()
    assert len(lines) == 1, proc.stdout
    assert lines[0].startswith("unregistered tool tools/new_thing.py:")
    assert "botcorp tools nudgebot register --name new-thing --path tools/new_thing.py" in lines[0]


@needs_node
@pytest.mark.parametrize("rel", ["tools/probe.py", "tools/lib/helpers.py", "tools/_private.py", "tools/notes.md", "memory/x.py"])
def test_covered_or_not_a_tool_is_silent(tmp_path, bot_home, rel):
    proc = _write(tmp_path, _bot(bot_home), rel)
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout == ""


@needs_node
def test_registry_off_when_tools_absent(tmp_path, bot_home):
    proc = _write(tmp_path, _bot(bot_home, tools=False), "tools/new_thing.py")
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout == ""


def test_hooks_json_registers_it_post_tool_use():
    hooks = json.loads((HOOKS / "hooks.json").read_text(encoding="utf-8"))["hooks"]["PostToolUse"]
    matchers = [set(g["matcher"].split("|")) for g in hooks if any("tools-nudge.sh" in h["command"] for h in g["hooks"])]
    assert matchers == [{"Write", "Edit"}]


def test_bash_parses():
    assert subprocess.run(["bash", "-n", str(HOOKS / "tools-nudge.sh")]).returncode == 0
