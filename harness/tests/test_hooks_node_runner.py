"""v0.8.6 R5: every guard in one node process, every other hook started by node.

Locked behaviour:
- hooks.json runs every hook in Claude Code's exec form (`command: node`, no
  shell): the tool guards as `guard.mjs pre` / `guard.mjs post`, the rest
  through `run.mjs <hook> <module|-> <script>`; no timeout below 15 s;
- `guard.mjs pre` routes each tool to the guards the separate hooks were
  registered for (the old matchers) and blocks exactly when the single guard
  does; an unparsable payload meets vault-guard and is blocked;
- BOT_DISABLED_HOOKS skips a guard, BOT_HOOK_TRACE=1 traces each guard that runs;
- run.mjs exits 0 WITHOUT starting bash for a hook switched off in
  BOT_DISABLED_HOOKS or gated on a module missing from BOT_MODULES, passes the
  script's exit code, stdin and stdout through otherwise, and writes the trace
  line once (not again from _guard.sh).
"""
from __future__ import annotations

import json
import shutil
import subprocess

import pytest

from test_hooks_fake_stdin import HOOKS, base_env, bot_home  # noqa: F401

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node not on PATH")

GUARD = HOOKS / "guard.mjs"
RUN = HOOKS / "run.mjs"


def _node(script, args, env, stdin=""):
    return subprocess.run(["node", str(script), *args], input=stdin, capture_output=True, text=True, encoding="utf-8", env=env, timeout=60)


def _pre(env, tool, ti):
    return _node(GUARD, ["pre"], env, json.dumps({"hook_event_name": "PreToolUse", "tool_name": tool, "tool_input": ti}))


def test_hooks_json_is_exec_form_with_15s_floor():
    hooks = json.loads((HOOKS / "hooks.json").read_text(encoding="utf-8"))["hooks"]
    seen = []
    for event, groups in hooks.items():
        for g in groups:
            for h in g["hooks"]:
                assert h["command"] == "node", (event, h)
                assert h["args"][0].startswith("${CLAUDE_PLUGIN_ROOT}/hooks/") and h["args"][0].endswith((".mjs",)), (event, h)
                assert h["timeout"] >= 15, (event, h)
                if h["args"][0].endswith("run.mjs"):
                    assert (HOOKS / h["args"][3]).is_file(), h
                seen.append((event, h["args"][0].rsplit("/", 1)[1], h["args"][1]))
    assert ("PreToolUse", "guard.mjs", "pre") in seen and ("PostToolUse", "guard.mjs", "post") in seen
    assert len([s for s in seen if s[0] == "PreToolUse"]) == 1, "one guard process per tool call"


def test_the_pre_matcher_is_exactly_the_union_of_the_old_guard_matchers():
    hooks = json.loads((HOOKS / "hooks.json").read_text(encoding="utf-8"))["hooks"]["PreToolUse"]
    old = {"AskUserQuestion", "ExitPlanMode"} | {"Edit", "Write", "MultiEdit", "NotebookEdit"} \
        | {"Read", "Glob", "Grep", "Bash", "PowerShell", "Edit", "Write", "MultiEdit", "NotebookEdit"} | {"Bash", "PowerShell"}
    assert set(hooks[0]["matcher"].split("|")) == old


# (tool, tool_input, the single guard that must decide, expected exit)
CASES = [
    ("AskUserQuestion", {"questions": []}, "block-dialogs", 2),
    ("ExitPlanMode", {"plan": "x"}, "block-dialogs", 2),
    ("Edit", {"file_path": "{home}/bot.yaml"}, "config-guard", 2),
    ("Write", {"file_path": "{home}/.claude/settings.json"}, "config-guard", 2),
    ("NotebookEdit", {"notebook_path": "{home}/.vault/x.ipynb"}, "config-guard", 2),
    ("Edit", {"file_path": "{home}/notes.md"}, "config-guard", 0),
    ("Read", {"file_path": "C:/x/bots/other/.vault/secrets.json"}, "vault-guard", 2),
    ("Glob", {"pattern": "**/.vault/*"}, "vault-guard", 2),
    ("MultiEdit", {"file_path": "{home}/a.md", "edits": [{"file_path": "C:/x/bots/o/.vault/k"}]}, "vault-guard", 2),
    ("Bash", {"command": "node cli/botcorp.mjs secrets get demo oauth_token"}, "vault-guard", 2),
    ("Bash", {"command": "node cli/botcorp.mjs approve alpha 3"}, "operator-guard", 2),
    ("PowerShell", {"command": "botcorp restart otherbot"}, "operator-guard", 2),
    ("Bash", {"command": "git status"}, "operator-guard", 0),
    ("Read", {"file_path": "{home}/memory/TDL.md"}, "vault-guard", 0),
]


@pytest.mark.parametrize("tool,ti,single,want", CASES)
def test_pre_decides_like_the_single_guard(tmp_path, bot_home, tool, ti, single, want):
    env = base_env(tmp_path, bot_home)
    ti = json.loads(json.dumps(ti).replace("{home}", str(bot_home).replace("\\", "/")))
    one = _node(GUARD, [single], env, json.dumps({"tool_name": tool, "tool_input": ti}))
    both = _pre(env, tool, ti)
    assert one.returncode == want, one.stderr
    assert both.returncode == want, both.stderr
    if want == 2:
        assert both.stderr == one.stderr and "BLOCKED" in both.stderr


def test_pre_only_runs_the_guards_the_old_matchers_named(tmp_path, bot_home):
    env = base_env(tmp_path, bot_home)
    # Grep/Read never met operator-guard or config-guard; a tool outside every matcher meets nothing
    assert _pre(env, "Grep", {"pattern": "botcorp approve alpha 3"}).returncode == 0
    assert _pre(env, "Read", {"file_path": str(bot_home / "bot.yaml")}).returncode == 0
    assert _pre(env, "WebFetch", {"url": "https://x.invalid/.vault/secrets.json"}).returncode == 0
    # positive control: the same Read of a vault is blocked
    assert _pre(env, "Read", {"file_path": str(bot_home / ".vault" / "k")}).returncode == 2


@pytest.mark.parametrize("payload", ['{"tool_name": "Read", "tool_input": {"file_path": ".vault/s', "[1, 2]", '{"tool_name": "Bash", "tool_input": "x"}'])
def test_pre_fails_closed_on_a_payload_it_cannot_parse(tmp_path, bot_home, payload):
    p = _node(GUARD, ["pre"], base_env(tmp_path, bot_home), payload)
    assert p.returncode == 2 and "could not parse" in p.stderr, p.stderr


def test_pre_honours_disabled_hooks_and_traces(tmp_path, bot_home):
    ti = {"command": "cat C:/x/bots/o/.vault/k && botcorp approve alpha 3"}
    env = base_env(tmp_path, bot_home, {"BOT_DISABLED_HOOKS": "vault-guard", "BOT_HOOK_TRACE": "1"})
    p = _pre(env, "Bash", ti)
    assert p.returncode == 2 and "operator-only" in p.stderr, p.stderr   # vault-guard off: operator-guard decides
    trace = (bot_home / "memory" / "metrics" / "hook-trace.log").read_text(encoding="utf-8").split()
    assert trace[1::2] == ["vault-guard", "operator-guard"]
    env = base_env(tmp_path, bot_home, {"BOT_DISABLED_HOOKS": "vault-guard,operator-guard"})
    assert _pre(env, "Bash", ti).returncode == 0


def test_post_warns_but_never_blocks(tmp_path, bot_home):
    p = _node(GUARD, ["post"], base_env(tmp_path, bot_home), "{not json")
    assert p.returncode == 0 and p.stdout == ""


# --- run.mjs ------------------------------------------------------------------------------
@pytest.fixture
def probe_script(tmp_path):
    marker = tmp_path / "ran.txt"
    s = tmp_path / "probe.sh"
    s.write_text(f'#!/usr/bin/env bash\n. "{HOOKS.as_posix()}/_guard.sh" probe-hook probe_mod\n'
                 f'cat > "{marker.as_posix()}"\necho "out:$1"\nexit 3\n', encoding="utf-8")
    return s, marker


def _run(env, script, *args, stdin="{}"):
    return _node(RUN, ["probe-hook", "probe_mod", str(script), *args], env, stdin)


def test_run_skips_a_disabled_hook_without_starting_bash(tmp_path, bot_home, probe_script):
    script, marker = probe_script
    for extra in ({"BOT_DISABLED_HOOKS": "x,probe-hook"}, {"BOT_MODULES": "auto_commit,sound"}, {"BOT_MODULES": ""}):
        p = _run(base_env(tmp_path, bot_home, extra), script, "a")
        assert p.returncode == 0 and p.stdout == "", (extra, p.stdout, p.stderr)
        assert not marker.exists(), extra
    # the module named, or `*`, or BOT_MODULES unset = on
    for extra in ({"BOT_MODULES": "probe_mod"}, {"BOT_MODULES": "*"}):
        p = _run(base_env(tmp_path, bot_home, extra), script, "a", stdin='{"k": 1}')
        assert p.returncode == 3 and p.stdout.strip() == "out:a", (extra, p.stdout, p.stderr)
        assert marker.read_text(encoding="utf-8") == '{"k": 1}'
        marker.unlink()
    env = base_env(tmp_path, bot_home)
    env.pop("BOT_MODULES")
    assert _run(env, script, "b").returncode == 3 and marker.exists()


def test_run_traces_once(tmp_path, bot_home, probe_script):
    script, marker = probe_script
    env = base_env(tmp_path, bot_home, {"BOT_MODULES": "probe_mod", "BOT_HOOK_TRACE": "1"})
    assert _run(env, script).returncode == 3
    trace = (bot_home / "memory" / "metrics" / "hook-trace.log").read_text(encoding="utf-8").splitlines()
    assert len(trace) == 1 and trace[0].endswith(" probe-hook"), trace
    # a disabled hook is still traced: the trace records that Claude Code ran it
    env["BOT_DISABLED_HOOKS"] = "probe-hook"
    assert _run(env, script).returncode == 0
    assert len((bot_home / "memory" / "metrics" / "hook-trace.log").read_text(encoding="utf-8").splitlines()) == 2
