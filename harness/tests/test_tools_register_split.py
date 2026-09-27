"""R5c step 19a: `tools register --file` from a bot applies the plain entries
and queues only the widening ones, as one approval entry. From the operator's
own terminal everything applies at once.
"""
from __future__ import annotations

import json

import pytest

from test_operator_only import box, cli, needs_node  # noqa: F401

PLAIN = [
    {"name": "report", "path": "tools/cli/report.py", "kind": "cli"},
    {"name": "export", "path": "tools/cli/export.py", "kind": "cli"},
    {"name": "helpers", "path": "tools/lib/*.py", "kind": "lib"},
]
WIDE = {"name": "mailer", "path": "tools/mail/send.py", "kind": "integration", "secrets": ["mail_token"]}


def _proposal(rt, entries):
    f = rt / "p.json"
    f.write_text(json.dumps({"tools": entries}), encoding="utf-8")   # JSON is valid YAML
    return f


def _state(rt, bots, env):
    d = json.loads(cli(env, "tools", "t", "scan", "--json").stdout)
    q = rt / "state" / "t.approvals.json"
    return {e["name"] for e in d["registered"]}, (json.loads(q.read_text(encoding="utf-8")) if q.exists() else [])


@pytest.fixture
def plain_bot(box):
    rt, bots, env = box
    (bots / "t" / "bot.yaml").write_text("name: t\nharness:\n  service: manual\nsecrets: [mail_token]\n", encoding="utf-8")
    return rt, bots, env


@needs_node
def test_a_bot_applies_the_plain_entries_and_queues_one_integration(plain_bot):
    rt, bots, env = plain_bot
    r = cli({**env, "BOT_NAME": "t"}, "tools", "t", "register", "--file", str(_proposal(rt, PLAIN + [WIDE])))
    assert r.returncode == 0, r.stdout + r.stderr
    assert "3 applied, 1 queued" in r.stdout, r.stdout
    names, q = _state(rt, bots, env)
    assert names == {"report", "export", "helpers"}
    assert len(q) == 1 and q[0]["op"] == "append" and q[0]["path"] == "tools"
    assert len(q[0]["value"]) == 1 and q[0]["value"][0]["kind"] == "integration"


@needs_node
def test_a_bot_with_no_widening_entry_queues_nothing(plain_bot):
    rt, bots, env = plain_bot
    extra = {"name": "watch", "path": "tools/mon/watch.py", "kind": "monitor"}
    r = cli({**env, "BOT_NAME": "t"}, "tools", "t", "register", "--file", str(_proposal(rt, PLAIN + [extra])))
    assert r.returncode == 0, r.stdout + r.stderr
    assert "4 applied, 0 queued" in r.stdout, r.stdout
    names, q = _state(rt, bots, env)
    assert len(names) == 4 and q == []


@needs_node
def test_the_operator_applies_everything_directly(plain_bot):
    rt, bots, env = plain_bot
    r = cli(env, "tools", "t", "register", "--file", str(_proposal(rt, PLAIN + [WIDE])))
    assert r.returncode == 0, r.stdout + r.stderr
    names, q = _state(rt, bots, env)
    assert names == {"report", "export", "helpers", "mailer"} and q == []
