"""Code review 2026-09-30, L21: the approve/decline notice a requesting bot gets
names who decided. An admin bot's decision says "an admin bot (<name>)", never
"the operator"; the operator's own still says "the operator".

Every run uses a temp BOTCORP_HOME / BOTCORP_BOTS_DIR, never the real runtime.
"""
from __future__ import annotations

import json

import pytest

from test_operator_only import cli, make_bot, needs_node, operator_env, queue

ID_BOSS = "b0" * 32


@pytest.fixture
def dbox(tmp_path):
    rt, bots = tmp_path / "rt", tmp_path / "bots"
    (rt / "state" / "boss").mkdir(parents=True)
    make_bot(bots, "boss", "name: boss\nrole: admin\nharness:\n  service: manual\n")
    make_bot(bots, "peon")
    (rt / "state" / "boss" / "launch-id").write_text(ID_BOSS, encoding="utf-8")
    op = operator_env(rt, bots)
    boss = {**op, "BOT_NAME": "boss", "CLAUDECODE": "1", "BOT_HOME": str(bots / "boss"), "BOTCORP_LAUNCH_ID": ID_BOSS}
    return rt, op, boss


def _entry(eid):
    return {"id": eid, "ts": "2026-09-30T00:00:00Z", "op": "set", "path": "harness.modules.remote_control", "value": True,
            "requested_by": "bot:peon", "reason": "enables Remote Control"}


def _texts(rt):
    f = rt / "state" / "peon" / "inbox.jsonl"
    return [json.loads(l)["text"] for l in f.read_text(encoding="utf-8").splitlines() if l.strip()] if f.exists() else []


@needs_node
def test_an_admin_bots_decision_names_the_admin_bot(dbox):
    rt, op, boss = dbox
    queue(rt, "peon", [_entry("aa1111"), _entry("bb2222")])
    r = cli(boss, "approve", "peon", "aa1111")
    assert r.returncode == 0, r.stdout + r.stderr
    r = cli(boss, "reject", "peon", "bb2222", "--reason", "not now")
    assert r.returncode == 0, r.stdout + r.stderr
    texts = _texts(rt)
    assert len(texts) == 2, texts
    assert "an admin bot (boss) approved your request aa1111" in texts[0], texts[0]
    assert "an admin bot (boss) declined your request bb2222" in texts[1], texts[1]
    assert not any("the operator" in t for t in texts), texts


@needs_node
def test_the_operators_decision_still_names_the_operator(dbox):
    rt, op, boss = dbox
    queue(rt, "peon", [_entry("cc3333")])
    r = cli(op, "approve", "peon", "cc3333")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "the operator approved your request cc3333" in _texts(rt)[0]
