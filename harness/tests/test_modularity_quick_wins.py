"""QA pack A item 6: the module layer does what it declares.

Locked behaviour:
- `harness.agents` is an allowlist: every harness agent left out of it gets an
  `Agent(botcorp:<name>)` deny rule, like `harness.disable: [agent:<name>]`;
- the stop-failure and notification hooks are gated on module usage_resume;
- the hook names bot.yaml `harness.hooks_disable` accepts are the run.mjs names
  in hooks.json plus guard.mjs's guards (session-summarize and cost-meter
  included);
- `remote_control` is no longer a module (nothing ever read it);
- docs/engine-contract.md names every module and has the precedence table;
- the template and the example bot point only at rules that exist;
- every `tools/...` path a harness skill names is shipped, or the skill says
  the harness ships no such tool and what to do then.
"""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

import pytest

from test_operator_only import ASSEMBLY, needs_node

HARNESS = ASSEMBLY / "harness"
BOTYAML = ASSEMBLY / "daemon" / "botyaml.mjs"
SYNC = ASSEMBLY / "daemon" / "sync.mjs"


def _node_module(js: str, *args: str) -> str:
    # argv[1] must not name botyaml.mjs, or importing it runs its CLI: callers pass a first arg that doesn't
    r = subprocess.run(["node", "--input-type=module", "-e", js, *args], capture_output=True, text=True, timeout=60, cwd=str(ASSEMBLY))
    assert r.returncode == 0, r.stderr
    return r.stdout


@needs_node
def test_the_agents_allowlist_denies_the_agents_left_out(tmp_path):
    f = tmp_path / "t" / "bot.yaml"
    f.parent.mkdir(parents=True)
    f.write_text("name: t\nharness:\n  service: manual\n  agents: [coder, critic]\n  disable: [agent:critic]\n", encoding="utf-8")
    js = ("const [{ loadBotYaml }, { buildSettings }] = await Promise.all([import(process.argv[4]), import(process.argv[5])]);"
          "const s = buildSettings(loadBotYaml(process.argv[1]), { botcorpRoot: process.argv[2], botHome: process.argv[3], nodeExe: process.execPath });"
          "console.log(JSON.stringify(s.permissions.deny));")
    deny = json.loads(_node_module(js, str(f), str(ASSEMBLY), str(f.parent), BOTYAML.as_uri(), SYNC.as_uri()))
    agents = sorted(p.stem for p in (HARNESS / "agents").glob("*.md"))
    want = [f"Agent(botcorp:{a})" for a in agents if a != "coder"]
    assert [d for d in deny if d.startswith("Agent(")] == want, deny
    # 'all' (the default) denies nothing
    f.write_text("name: t\nharness:\n  service: manual\n", encoding="utf-8")
    deny = json.loads(_node_module(js, str(f), str(ASSEMBLY), str(f.parent), BOTYAML.as_uri(), SYNC.as_uri()))
    assert not [d for d in deny if d.startswith("Agent(")]


def test_the_quota_hooks_are_gated_on_usage_resume(tmp_path):
    hooks = json.loads((HARNESS / "hooks" / "hooks.json").read_text(encoding="utf-8"))["hooks"]
    mods = {h["args"][1]: h["args"][2] for groups in hooks.values() for g in groups for h in g["hooks"] if h["args"][0].endswith("run.mjs")}
    assert mods["stop-failure"] == "usage_resume" and mods["notification"] == "usage_resume"


@needs_node
def test_run_mjs_skips_stop_failure_without_usage_resume(tmp_path):
    import os
    env = {**os.environ, "BOT_MODULES": "telegram", "BOT_HOME": str(tmp_path), "BOTCORP_HOME": str(tmp_path / "rt"), "BOT_NAME": "t"}
    r = subprocess.run(["node", str(HARNESS / "hooks" / "run.mjs"), "stop-failure", "usage_resume", "stop-failure.sh"],
                       input='{"error": "rate_limit"}', capture_output=True, text=True, env=env, timeout=60)
    assert r.returncode == 0 and r.stdout == "" and r.stderr == ""
    assert not (tmp_path / "rt").exists()                      # nothing ran, nothing written


@needs_node
def test_hook_names_come_from_hooks_json_and_the_guards(tmp_path):
    names = json.loads(_node_module("const { hookNames } = await import(process.argv[2]); console.log(JSON.stringify(hookNames()));", "-", BOTYAML.as_uri()))
    for n in ("session-summarize", "cost-meter", "precompact-extract", "precompact-timeline", "session-start", "play-sound", "vault-guard", "tools-nudge"):
        assert n in names, n
    assert "py" not in names and "_guard" not in names
    # GUARD_HOOKS is guard.mjs's own list (its unknown-mode error names every guard)
    r = subprocess.run(["node", str(HARNESS / "hooks" / "guard.mjs"), "no-such-mode"], input="", capture_output=True, text=True, timeout=60)
    listed = re.search(r"\(pre \| post \| (.*)\)", r.stderr).group(1).split(" | ")
    guards = json.loads(_node_module("const { GUARD_HOOKS } = await import(process.argv[2]); console.log(JSON.stringify(GUARD_HOOKS));", "-", BOTYAML.as_uri()))
    assert sorted(listed) == sorted(guards)
    # and bot.yaml takes one of the new names
    f = tmp_path / "t" / "bot.yaml"
    f.parent.mkdir(parents=True)
    f.write_text("name: t\nharness:\n  hooks_disable: [session-summarize, cost-meter]\n", encoding="utf-8")
    r = subprocess.run(["node", str(BOTYAML), str(f), "--validate"], capture_output=True, text=True, timeout=60, cwd=str(ASSEMBLY))
    assert r.returncode == 0, r.stderr


def test_remote_control_is_not_a_module():
    src = (ASSEMBLY / "daemon" / "botyaml.mjs").read_text(encoding="utf-8")
    engine = [ASSEMBLY / "daemon", ASSEMBLY / "cli", ASSEMBLY / "core", HARNESS / "hooks", HARNESS / "tools", ASSEMBLY / "cockpit"]
    hits = [str(p.relative_to(ASSEMBLY)) for d in engine for p in d.rglob("*")
            if p.is_file() and p.suffix in (".mjs", ".js", ".ps1", ".py", ".sh", ".json") and "node_modules" not in p.parts
            and "dist" not in p.parts and "tests" not in p.parts and "remote_control" in p.read_text(encoding="utf-8", errors="replace")]
    assert "remote_control" not in src and hits == [], hits
    assert "remote_control" not in (ASSEMBLY / "templates" / "bot" / "bot.yaml").read_text(encoding="utf-8")   # a new bot's file


@needs_node
def test_the_engine_contract_names_every_module_and_the_precedence():
    mods = json.loads(_node_module("const { DEFAULTS } = await import(process.argv[2]); console.log(JSON.stringify(Object.keys(DEFAULTS.harness.modules)));", "-", BOTYAML.as_uri()))
    doc = (ASSEMBLY / "docs" / "engine-contract.md").read_text(encoding="utf-8")
    modules = doc.split("## Modules", 1)[1].split("\n## ", 1)[0]
    for m in mods + ["backup"]:
        assert f"| `{m}` |" in modules, m
    prec = doc.split("## Override precedence", 1)[1].split("\n## ", 1)[0]
    for kind in ("Rules", "Skills", "Agents", "Tools", "Hooks"):
        assert f"| {kind} |" in prec, kind
    assert "`secrets set|delete`" in doc and "admin bot" in doc       # the operator-guard claim, as guard.mjs has it


@pytest.mark.parametrize("claude_md", ["templates/bot/CLAUDE.md", "bots/_example/CLAUDE.md"])
def test_the_template_names_only_rules_that_exist(claude_md):
    text = (ASSEMBLY / claude_md).read_text(encoding="utf-8")
    assert ".claude/rules/" not in text                            # a new bot has no .claude/rules
    for rule in re.findall(r"harness/rules/([a-z-]+\.md)", text):
        assert (HARNESS / "rules" / rule).is_file(), rule


def test_every_skill_tool_path_is_shipped_or_guarded():
    bad = []
    for skill in sorted((HARNESS / "skills").glob("*/SKILL.md")):
        text = skill.read_text(encoding="utf-8")
        guards = re.findall(r"the harness ships\s+no\s+`([^`]+)`", text)
        for path in set(re.findall(r"(?<![\w/.-])tools/[\w./*-]*[\w*/]", text)):
            shipped = (HARNESS / path).exists()
            if not shipped and not any(path.startswith(g.rstrip("*")) for g in guards):
                bad.append(f"{skill.parent.name}: {path}")
    assert not bad, bad
