"""R5a step 3: queue entries carry an `op`, and the new widening cases.

Locked behaviour:
- from a bot (BOT_NAME set) each widening change queues (exit 0, the entry is
  in state/<bot>.approvals.json with its op) and bot.yaml is untouched:
  `config add <bot> secrets <key>`, `config add <bot> automations <json>`, and
  `config set automations.<n>.enabled true` on a disabled automation.
- the narrowing counterparts apply directly: `config remove`, enabled true -> false.
- an entry queued before v0.6.0 (no `op`) still approves as a set, and an
  operator approve of an `append` entry applies it.
"""
from __future__ import annotations

import json

import pytest

from test_operator_only import box, cli, needs_node, queue  # noqa: F401

YAML = (
    "name: t\nharness:\n  service: manual\n"
    "automations:\n"
    "  - name: nightly\n    command: echo hi\n    trigger: { cron: '0 3 * * *' }\n    enabled: false\n"
    "  - name: hourly\n    command: echo hi\n    trigger: { interval_min: 60 }\n"
)
JOB = '{"name": "extra", "command": "echo x", "trigger": {"interval_min": 5}}'


@pytest.fixture
def tbox(box):
    rt, bots, env = box
    (bots / "t" / "bot.yaml").write_text(YAML, encoding="utf-8")
    return rt, bots, env


def _yaml(bots):
    return (bots / "t" / "bot.yaml").read_text(encoding="utf-8")


def _queue(rt):
    f = rt / "state" / "t.approvals.json"
    return json.loads(f.read_text(encoding="utf-8")) if f.exists() else []


@needs_node
@pytest.mark.parametrize("args,op,path", [
    (("config", "add", "t", "secrets", "gh_token"), "append", "secrets"),
    (("config", "add", "t", "automations", JOB), "append", "automations"),
    (("config", "set", "t", "automations.nightly.enabled", "true"), "set", "automations.nightly.enabled"),
])
def test_widening_queues_from_a_bot(tbox, args, op, path):
    rt, bots, env = tbox
    before = _yaml(bots)
    r = cli({**env, "BOT_NAME": "t"}, *args)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "queued for operator approval" in r.stdout
    q = _queue(rt)
    assert len(q) == 1 and q[0]["op"] == op and q[0]["path"] == path and q[0]["requested_by"] == "bot:t"
    assert _yaml(bots) == before


@needs_node
@pytest.mark.parametrize("args,check", [
    (("config", "remove", "t", "automations", "hourly"), lambda y: "hourly" not in y),
    (("config", "set", "t", "automations.hourly.enabled", "false"), lambda y: y.count("enabled: false") == 2),
    (("config", "set", "t", "automations.nightly.enabled", "false"), lambda y: "nightly" in y),
])
def test_narrowing_applies_directly(tbox, args, check):
    rt, bots, env = tbox
    r = cli({**env, "BOT_NAME": "t"}, *args)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "applied" in r.stdout
    assert _queue(rt) == []
    assert check(_yaml(bots))


@needs_node
def test_old_entry_without_op_approves_as_a_set(tbox):
    rt, bots, env = tbox
    queue(rt, "t", [{"id": "old001", "ts": "2026-09-01T00:00:00Z", "path": "automations.nightly.enabled",
                     "value": True, "requested_by": "bot:t", "reason": "enables automation nightly"}])
    r = cli(env, "approve", "t", "old001")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "enabled: false" not in _yaml(bots)
    assert _queue(rt) == []


@needs_node
def test_operator_approves_an_append_entry(tbox):
    rt, bots, env = tbox
    r = cli({**env, "BOT_NAME": "t"}, "config", "add", "t", "secrets", "gh_token", "--json")
    assert r.returncode == 0, r.stderr
    qid = _queue(rt)[0]["id"]
    r = cli(env, "approve", "t", qid)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "append secrets" in r.stdout
    r = cli(env, "config", "get", "t", "secrets", "--json")
    assert json.loads(r.stdout)["value"] == ["oauth_token", "telegram_token", "gh_token"]
