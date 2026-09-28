"""v0.7.5: a decision on a bot's request reaches that bot through its inbox.

Locked behaviour:
- `botcorp approve|reject` queue ONE message per decided entry in the
  requesting bot's inbox (core/inbox.mjs: state/<bot>/inbox.jsonl), saying what
  was approved or declined and what was applied, so the bot knows without
  polling; a reject carries its --reason;
- the source is `cli`, or `cockpit` when the cockpit runs the verb
  (`--source cockpit`, the one path both share, so neither sends twice);
- a request the operator queued (requested_by is not `bot:<name>`) notifies
  nobody.

Every run uses a temp BOTCORP_HOME / BOTCORP_BOTS_DIR, never the real runtime.
"""
from __future__ import annotations

import json

from test_operator_only import box, cli, needs_node, queue  # noqa: F401


def _inbox(rt, bot="t"):
    f = rt / "state" / bot / "inbox.jsonl"
    return [json.loads(l) for l in f.read_text(encoding="utf-8").splitlines() if l.strip()] if f.exists() else []


def _entry(eid, requested_by="bot:t", path="harness.modules.remote_control", value=True):
    return {"id": eid, "ts": "2026-09-27T00:00:00Z", "op": "set", "path": path, "value": value,
            "requested_by": requested_by, "reason": "enables Remote Control"}


@needs_node
def test_approve_tells_the_requesting_bot_once(box):
    rt, bots, env = box
    queue(rt, "t", [_entry("aa1111")])
    r = cli(env, "approve", "t", "aa1111")
    assert r.returncode == 0, r.stdout + r.stderr
    items = _inbox(rt)
    assert len(items) == 1, items
    it = items[0]
    assert it["source"] == "cli"
    assert "approved" in it["text"] and "aa1111" in it["text"]
    assert "harness.modules.remote_control = true" in it["text"] and "Applied" in it["text"]
    assert "told through its inbox" in r.stdout


@needs_node
def test_reject_tells_the_requesting_bot_with_the_reason(box):
    rt, bots, env = box
    queue(rt, "t", [_entry("bb2222")])
    r = cli(env, "reject", "t", "bb2222", "--reason", "not this week")
    assert r.returncode == 0, r.stdout + r.stderr
    items = _inbox(rt)
    assert len(items) == 1, items
    assert "declined" in items[0]["text"] and "bb2222" in items[0]["text"]
    assert "not this week" in items[0]["text"] and "Nothing was applied" in items[0]["text"]


@needs_node
def test_the_cockpit_source_is_recorded(box):
    rt, bots, env = box
    queue(rt, "t", [_entry("cc3333")])
    r = cli(env, "approve", "t", "cc3333", "--by", "someone@example.com", "--source", "cockpit")
    assert r.returncode == 0, r.stdout + r.stderr
    items = _inbox(rt)
    assert [i["source"] for i in items] == ["cockpit"]
    assert cli(env, "reject", "t", "zz", "--source", "tg").returncode == 2


@needs_node
def test_approve_all_sends_one_message_per_entry(box):
    rt, bots, env = box
    queue(rt, "t", [_entry("dd4444"), _entry("ee5555", path="secrets", value=["gh_token"])])
    r = cli(env, "approve", "t", "--all")
    assert r.returncode == 0, r.stdout + r.stderr
    texts = [i["text"] for i in _inbox(rt)]
    assert len(texts) == 2 and "dd4444" in texts[0] and "ee5555" in texts[1], texts


@needs_node
def test_no_message_when_the_requester_is_not_a_bot(box):
    rt, bots, env = box
    queue(rt, "t", [_entry("ff6666", requested_by="operator:someone")])
    assert cli(env, "approve", "t", "ff6666").returncode == 0
    queue(rt, "t", [_entry("gg7777", requested_by="operator:someone")])
    assert cli(env, "reject", "t", "gg7777").returncode == 0
    assert _inbox(rt) == []
