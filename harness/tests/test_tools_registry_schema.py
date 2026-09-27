"""R5a step 5: bot.yaml `tools:` and `harness.tools_registry`.

Locked behaviour:
- `tools:` absent = null = registry off; `harness.tools_registry` absent = warn.
- validate: tool name unique, path required (relative), kind cli | monitor |
  integration | lib, a glob path only for lib | cli, secrets a subset of the
  top-level `secrets:`.
- a bot with no `tools:` gets no `tools-*` doctor rows.
- `config add <bot> tools <json>` from a bot applies a plain cli entry and
  queues an integration or secret-bearing one; tools_registry enforce -> warn
  from a bot queues.
"""
from __future__ import annotations

import json
import subprocess

import pytest

from test_operator_only import ASSEMBLY, box, cli, needs_node  # noqa: F401

BOTYAML = ASSEMBLY / "daemon" / "botyaml.mjs"

HEAD = "name: t\nsecrets: [oauth_token, gh_token]\nharness:\n  service: manual\n"   # a body may continue harness:


def _validate(tmp_path, body: str) -> list[str]:
    f = tmp_path / "t" / "bot.yaml"
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(HEAD + body, encoding="utf-8")
    r = subprocess.run(["node", str(BOTYAML), str(f), "--validate"], capture_output=True, text=True, timeout=60, cwd=str(ASSEMBLY))
    return [l.removeprefix("bot.yaml: ") for l in r.stderr.splitlines() if l.startswith("bot.yaml: ")]


@needs_node
@pytest.mark.parametrize("body,expected", [
    ("tools:\n  - {name: probe, path: tools/probe.py, kind: monitor, secrets: [gh_token]}\n"
     "  - {name: lib-v2, path: 'tools/v2/*.py', kind: lib}\n", []),
    ("tools:\n  - {name: a, path: tools/a.py, kind: cli}\n  - {name: a, path: tools/b.py, kind: cli}\n",
     ["tools[1].name: duplicate 'a'"]),
    ("tools:\n  - {name: a, path: 'tools/*.py', kind: monitor}\n",
     ['tools[0].path: a glob only for kind lib | cli (got "tools/*.py" as monitor)']),
    ("tools:\n  - {name: a, path: tools/a.py, kind: cli, secrets: [hub_token]}\n",
     ["tools[0].secrets: hub_token not declared in the bot's secrets: list"]),
    ("tools:\n  - {name: a, path: tools/a.py, kind: daemon}\n",
     ['tools[0].kind: cli | monitor | integration | lib (got "daemon")']),
    ("tools:\n  - {name: a, kind: cli}\n", ["tools[0].path: required"]),
    ("  tools_registry: strict\n", ['harness.tools_registry: warn | enforce (got "strict")']),
])
def test_validation(tmp_path, body, expected):
    assert _validate(tmp_path, body) == expected


@needs_node
def test_absent_defaults(tmp_path):
    f = tmp_path / "t" / "bot.yaml"
    f.parent.mkdir(parents=True)
    f.write_text(HEAD, encoding="utf-8")
    r = subprocess.run(["node", str(BOTYAML), str(f)], capture_output=True, text=True, timeout=60, cwd=str(ASSEMBLY))
    cfg = json.loads(r.stdout)
    assert cfg["tools"] is None and cfg["harness"]["tools_registry"] == "warn"


@needs_node
def test_config_add_tools_applies_cli_and_queues_integration(box):
    rt, bots, env = box
    (bots / "t" / "bot.yaml").write_text(HEAD, encoding="utf-8")
    benv = {**env, "BOT_NAME": "t"}
    r = cli(benv, "config", "add", "t", "tools", '{"name": "rep", "path": "tools/rep.py", "kind": "cli"}')
    assert r.returncode == 0 and "applied" in r.stdout, r.stdout + r.stderr
    assert "rep" in (bots / "t" / "bot.yaml").read_text(encoding="utf-8")
    for entry in ('{"name": "gh", "path": "tools/gh.py", "kind": "integration"}',
                  '{"name": "hub", "path": "tools/hub.py", "kind": "cli", "secrets": ["gh_token"]}'):
        before = (bots / "t" / "bot.yaml").read_text(encoding="utf-8")
        r = cli(benv, "config", "add", "t", "tools", entry)
        assert r.returncode == 0 and "queued" in r.stdout, r.stdout + r.stderr
        assert (bots / "t" / "bot.yaml").read_text(encoding="utf-8") == before
    q = json.loads((rt / "state" / "t.approvals.json").read_text(encoding="utf-8"))
    assert [e["op"] for e in q] == ["append", "append"]


@needs_node
def test_relaxing_enforce_queues_from_a_bot(box):
    rt, bots, env = box
    (bots / "t" / "bot.yaml").write_text("name: t\nharness:\n  service: manual\n  tools_registry: enforce\n", encoding="utf-8")
    r = cli({**env, "BOT_NAME": "t"}, "config", "set", "t", "harness.tools_registry", "warn")
    assert r.returncode == 0 and "queued" in r.stdout, r.stdout + r.stderr
    assert "enforce" in (bots / "t" / "bot.yaml").read_text(encoding="utf-8")
    r = cli({**env, "BOT_NAME": "t"}, "config", "set", "t", "harness.tools_registry", "enforce")
    assert r.returncode == 0 and "applied" in r.stdout


@needs_node
def test_doctor_shows_no_tools_rows_without_a_registry(box):
    rt, bots, env = box
    r = cli(env, "doctor", "--no-tg-probe", "--no-accounts", "--json", timeout=300)
    rows = json.loads(r.stdout)
    assert any(c["name"] == "t: bot.yaml" for c in rows)
    assert not [c for c in rows if ": tools-" in str(c.get("name", ""))]
