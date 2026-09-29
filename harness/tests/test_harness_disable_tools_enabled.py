"""v0.8.3: `harness.disable`, `tools.<name>.enabled`, and the guard-hook widening rule.

Locked behaviour:
- validate: `harness.disable` takes `skill:<name>` | `agent:<name>` naming a harness
  skill folder or agent file; anything else is rejected.
- buildSettings: `skill:<x>` joins disabledSkills, `agent:<x>` becomes an
  `Agent(botcorp:<x>)` deny rule, a registry entry with `enabled: false` becomes a
  `Bash(*<path>*)` deny rule.
- `config set tools.<name>.enabled true` from a bot queues when the entry is an
  integration (or holds secrets) and applies for a plain cli entry.
- `harness.hooks_disable` gaining a `-guard` hook from a bot queues; vault-guard is
  refused outright (validate: it can never be disabled), nothing queued or written.
- POST /api/bots/:name/config takes a list only for harness.disable and
  harness.hooks_disable.
"""
from __future__ import annotations

import json
import subprocess

import pytest

from test_cockpit_api import Cockpit, needs_win_node
from test_operator_only import ASSEMBLY, box, cli, make_bot, needs_node, operator_env  # noqa: F401

BOTYAML = ASSEMBLY / "daemon" / "botyaml.mjs"
SYNC = ASSEMBLY / "daemon" / "sync.mjs"

HEAD = "name: t\nsecrets: [oauth_token, gh_token]\nharness:\n  service: manual\n"


def _validate(tmp_path, body: str) -> list[str]:
    f = tmp_path / "t" / "bot.yaml"
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(HEAD + body, encoding="utf-8")
    r = subprocess.run(["node", str(BOTYAML), str(f), "--validate"], capture_output=True, text=True, timeout=60, cwd=str(ASSEMBLY))
    return [l.removeprefix("bot.yaml: ") for l in r.stderr.splitlines() if l.startswith("bot.yaml: ")]


@needs_node
@pytest.mark.parametrize("body,expected", [
    ("  disable: [skill:weekly, agent:fable]\n", []),
    ("  disable: [foo]\n", ['harness.disable: "foo" is not skill:<name> or agent:<name>']),
    ("  disable: [skill:x]\n", ["harness.disable: no harness skill 'x'"]),
    ("  disable: [agent:nope]\n", ["harness.disable: no harness agent 'nope'"]),
    ("  disable: skill:weekly\n", ["harness.disable: must be a list of skill:<name> | agent:<name>"]),
    ("tools:\n  - {name: a, path: tools/a.py, kind: cli, enabled: 'no'}\n", ['tools[0].enabled: true | false (got "no")']),
])
def test_validate(tmp_path, body, expected):
    errs = _validate(tmp_path, body)
    # the unknown-name errors list the valid names after the prefix asserted here
    assert len(errs) == len(expected) and all(e.startswith(x) for e, x in zip(errs, expected)), errs


@needs_node
def test_build_settings_emits_the_deny_rules(tmp_path):
    f = tmp_path / "t" / "bot.yaml"
    f.parent.mkdir(parents=True)
    f.write_text(HEAD + "  disable: [skill:weekly, agent:fable]\n"
                 "tools:\n  - {name: x, path: tools/x.py, kind: cli, enabled: false}\n"
                 "  - {name: y, path: tools/y.py, kind: cli}\n", encoding="utf-8")
    # argv[1] is the bot.yaml, not a module path: botyaml.mjs / sync.mjs run their CLI when argv[1] names them
    js = ("const [{ loadBotYaml }, { buildSettings }] = await Promise.all([import(process.argv[4]), import(process.argv[5])]);"
          "const cfg = loadBotYaml(process.argv[1]);"
          "const s = buildSettings(cfg, { botcorpRoot: process.argv[2], botHome: process.argv[3], nodeExe: process.execPath });"
          "console.log(JSON.stringify({ deny: s.permissions.deny, skills: s.disabledSkills }));")
    r = subprocess.run(["node", "--input-type=module", "-e", js, str(f), str(ASSEMBLY), str(f.parent), BOTYAML.as_uri(), SYNC.as_uri()],
                       capture_output=True, text=True, timeout=60, cwd=str(ASSEMBLY))
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout)
    assert "Agent(botcorp:fable)" in out["deny"] and "Bash(*tools/x.py*)" in out["deny"], out
    assert not [d for d in out["deny"] if "tools/y.py" in d], out
    assert out["deny"][:2] == ["AskUserQuestion", "ExitPlanMode"], out
    assert out["skills"] == ["botcorp:weekly"], out


TOOLS_YAML = HEAD + ("tools:\n"
                     "  - {name: gh, path: tools/gh.py, kind: integration, enabled: false}\n"
                     "  - {name: rep, path: tools/rep.py, kind: cli, enabled: false}\n")


def _yaml(bots):
    return (bots / "t" / "bot.yaml").read_text(encoding="utf-8")


def _queue(rt):
    f = rt / "state" / "t.approvals.json"
    return json.loads(f.read_text(encoding="utf-8")) if f.exists() else []


@needs_node
def test_enabling_an_integration_tool_queues_a_plain_one_applies(box):
    rt, bots, env = box
    (bots / "t" / "bot.yaml").write_text(TOOLS_YAML, encoding="utf-8")
    benv = {**env, "BOT_NAME": "t"}
    before = _yaml(bots)
    r = cli(benv, "config", "set", "t", "tools.gh.enabled", "true")
    assert r.returncode == 0 and "queued for operator approval" in r.stdout, r.stdout + r.stderr
    q = _queue(rt)
    assert len(q) == 1 and q[0]["path"] == "tools.gh.enabled" and q[0]["value"] is True and "enables tool gh" in q[0]["reason"], q
    assert _yaml(bots) == before
    # positive control: a plain cli entry is not widening
    r = cli(benv, "config", "set", "t", "tools.rep.enabled", "true")
    assert r.returncode == 0 and "applied" in r.stdout, r.stdout + r.stderr
    assert len(_queue(rt)) == 1
    # any other field under a tools entry is not a config path
    r = cli(benv, "config", "set", "t", "tools.gh.kind", "cli")
    assert r.returncode != 0 and "tools.<name>.enabled" in r.stderr, r.stdout + r.stderr


@needs_node
def test_switching_off_a_guard_hook_queues_vault_guard_is_refused(box):
    rt, bots, env = box
    (bots / "t" / "bot.yaml").write_text(HEAD, encoding="utf-8")
    benv = {**env, "BOT_NAME": "t"}
    before = _yaml(bots)
    r = cli(benv, "config", "set", "t", "harness.hooks_disable", "[config-guard]")
    assert r.returncode == 0 and "queued for operator approval" in r.stdout, r.stdout + r.stderr
    q = _queue(rt)
    assert len(q) == 1 and q[0]["value"] == ["config-guard"] and "config-guard" in q[0]["reason"], q
    assert _yaml(bots) == before
    for value in ("[vault-guard]", "[operator-guard]", "[config-guard,vault-guard]"):
        r = cli(benv, "config", "set", "t", "harness.hooks_disable", value)
        assert r.returncode != 0 and "cannot be disabled" in r.stderr, (value, r.stdout + r.stderr)
    assert len(_queue(rt)) == 1 and _yaml(bots) == before
    # a non-guard hook applies directly (positive control)
    r = cli(benv, "config", "set", "t", "harness.hooks_disable", "[play-sound]")
    assert r.returncode == 0 and "applied" in r.stdout, r.stdout + r.stderr


@needs_win_node
def test_config_route_takes_a_list_only_for_the_two_list_paths(tmp_path):
    rt, bots = tmp_path / "rt", tmp_path / "bots"
    (rt / "state").mkdir(parents=True)
    make_bot(bots, "t", "name: t\npermissions: default\nharness:\n  service: manual\n")
    c = Cockpit(operator_env(rt, bots))
    try:
        url = "/api/bots/t/config"
        code, r = c.call("POST", url, {"path": "harness.disable", "value": ["skill:weekly", "agent:fable"]}, token=True)
        assert code == 200 and r["applied"], r
        code, r = c.call("POST", url, {"path": "harness.hooks_disable", "value": ["play-sound"]}, token=True)
        assert code == 200 and r["applied"], r
        import yaml
        h = yaml.safe_load((bots / "t" / "bot.yaml").read_text(encoding="utf-8"))["harness"]
        assert h["disable"] == ["skill:weekly", "agent:fable"] and h["hooks_disable"] == ["play-sound"], h
        for body in ({"path": "integrations.telegram.allow_from", "value": ["123"]},
                     {"path": "harness.disable", "value": ["Skill:Bad Name"]},
                     {"path": "harness.disable", "value": [1]}):
            assert c.call("POST", url, body, token=True)[0] == 400, body
    finally:
        c.close()
