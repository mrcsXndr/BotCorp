"""v0.9.9: config-guard keeps a bot session away from the "All bots" knowledge.

Locked behaviour:
- an Edit/Write/MultiEdit of anything under <BOTCORP_HOME>/global/ (the source
  docs, descriptions.json) is blocked;
- so is one of the synced copies, <config home>/rules/botcorp-global-*.md,
  also when the path climbs back in with `..`;
- the config home's other rules and the bot's own .claude/rules/ stay the
  bot's to edit.
"""
from __future__ import annotations

import json
import shutil
import subprocess

import pytest

from test_hooks_fake_stdin import HOOKS, base_env, bot_home  # noqa: F401

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node not on PATH")


def _pre(env, tool, ti):
    return subprocess.run(["node", str(HOOKS / "guard.mjs"), "pre"], capture_output=True, text=True, encoding="utf-8", env=env, timeout=60,
                          input=json.dumps({"hook_event_name": "PreToolUse", "tool_name": tool, "tool_input": ti}))


def test_global_knowledge_is_blocked(tmp_path, bot_home):
    env = base_env(tmp_path, bot_home)
    rt, cfg = tmp_path / "rt", tmp_path / "cfg"
    for tool, ti in [
        ("Write", {"file_path": str(rt / "global" / "knowledge" / "style.md"), "content": "x"}),
        ("Edit", {"file_path": str(rt / "global" / "descriptions.json"), "old_string": "a", "new_string": "b"}),
        ("Write", {"file_path": str(cfg / "rules" / "botcorp-global-style.md"), "content": "x"}),
        ("MultiEdit", {"file_path": str(cfg / "rules" / "x" / ".." / "botcorp-global-style.md"), "edits": []}),
    ]:
        r = _pre(env, tool, ti)
        assert r.returncode == 2 and "All bots" in r.stderr, (tool, ti, r.stderr)


def test_the_bots_own_rules_still_edit(tmp_path, bot_home):
    env = base_env(tmp_path, bot_home)
    for f in (tmp_path / "cfg" / "rules" / "mine.md", bot_home / ".claude" / "rules" / "botcorp-global-style.md", bot_home / "CLAUDE.md"):
        r = _pre(env, "Write", {"file_path": str(f), "content": "x"})
        assert r.returncode == 0, (f, r.stderr)
