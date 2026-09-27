"""v0.7.3: the approval queue dedupes, approves idempotently, and never strands.

Locked behaviour:
- a bot queuing the same widening change again (same op, path and value) gets
  the pending entry's id back instead of a second entry; a different value
  still queues.
- approving an `append` skips the names the list already has (and says so)
  instead of failing on "already has", so two overlapping entries both approve.
- `approve --all` takes each entry out of the queue as soon as it is applied:
  a later entry that fails leaves only itself (and the untried ones) pending.
"""
from __future__ import annotations

import json

from test_operator_only import box, cli, needs_node, queue  # noqa: F401


def _queue(rt):
    f = rt / "state" / "t.approvals.json"
    return json.loads(f.read_text(encoding="utf-8")) if f.exists() else []


def _secrets(env):
    return json.loads(cli(env, "config", "get", "t", "secrets", "--json").stdout)["value"]


def _entry(eid, op, path, value):
    return {"id": eid, "ts": "2026-09-27T00:00:00Z", "op": op, "path": path, "value": value,
            "requested_by": "bot:t", "reason": "widening"}


@needs_node
def test_the_same_change_queues_once(box):
    rt, bots, env = box
    bot = {**env, "BOT_NAME": "t"}
    r1 = cli(bot, "config", "add", "t", "secrets", "gh_token", "--json")
    r2 = cli(bot, "config", "add", "t", "secrets", "gh_token", "--json")
    assert r1.returncode == 0 and r2.returncode == 0, r1.stderr + r2.stderr
    q = _queue(rt)
    assert len(q) == 1, q
    assert "already queued" in r2.stdout and q[0]["id"] in r2.stdout
    assert cli(bot, "config", "add", "t", "secrets", "other_token").returncode == 0
    assert len(_queue(rt)) == 2


@needs_node
def test_overlapping_appends_both_approve(box):
    rt, bots, env = box
    queue(rt, "t", [_entry("aaa111", "append", "secrets", "gh_token"),
                    _entry("bbb222", "append", "secrets", ["gh_token", "np_token"])])
    r = cli(env, "approve", "t", "--all")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "already registered, skipped: gh_token" in r.stdout
    assert _secrets(env) == ["oauth_token", "telegram_token", "gh_token", "np_token"]
    assert _queue(rt) == []
    hist = [json.loads(l)["id"] for l in (rt / "state" / "t.approvals.history.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    assert hist == ["aaa111", "bbb222"]


@needs_node
def test_an_entry_whose_names_all_exist_approves_as_a_no_op(box):
    rt, bots, env = box
    queue(rt, "t", [_entry("ccc333", "append", "secrets", "oauth_token")])
    yml = (bots / "t" / "bot.yaml").read_bytes()
    r = cli(env, "approve", "t", "ccc333")
    assert r.returncode == 0, r.stdout + r.stderr
    assert _queue(rt) == [] and (bots / "t" / "bot.yaml").read_bytes() == yml


@needs_node
def test_a_failing_entry_does_not_strand_the_applied_ones(box):
    rt, bots, env = box
    good = _entry("ddd444", "set", "harness.modules.remote_control", True)
    bad = _entry("eee555", "set", "permissions", "not-a-mode")
    later = _entry("fff666", "append", "secrets", "gh_token")
    queue(rt, "t", [good, bad, later])
    r = cli(env, "approve", "t", "--all")
    assert r.returncode != 0, r.stdout + r.stderr
    assert "remote_control: true" in (bots / "t" / "bot.yaml").read_text(encoding="utf-8")
    assert [e["id"] for e in _queue(rt)] == ["eee555", "fff666"]
