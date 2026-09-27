"""R5a step 8: `botcorp automations <bot> enable|disable <name>`.

The operator's flip applies to bot.yaml (resume/pause too: they are the same
verb); with BOT_NAME set, enabling a disabled job queues and bot.yaml is
unchanged, while disabling (narrowing) still applies.
"""
from __future__ import annotations

import json

import pytest

from test_operator_only import box, cli, needs_node  # noqa: F401

YAML = (
    "name: t\nharness:\n  service: manual\n"
    "automations:\n"
    "  - name: job\n    command: echo hi\n    trigger: { interval_min: 60 }\n    enabled: false\n"
)


@pytest.fixture
def jbox(box):
    rt, bots, env = box
    (bots / "t" / "bot.yaml").write_text(YAML, encoding="utf-8")
    return rt, bots, env


def _enabled(env):
    return json.loads(cli(env, "automations", "t", "list", "--json").stdout)["automations"][0]["enabled"]


@needs_node
@pytest.mark.parametrize("on,off", [("enable", "disable"), ("resume", "pause")])
def test_operator_flip_applies(jbox, on, off):
    rt, bots, env = jbox
    r = cli(env, "automations", "t", on, "job")
    assert r.returncode == 0 and "applied" in r.stdout, r.stdout + r.stderr
    assert _enabled(env) is True
    r = cli(env, "automations", "t", off, "job")
    assert r.returncode == 0 and "applied" in r.stdout, r.stdout + r.stderr
    assert _enabled(env) is False


@needs_node
def test_bot_enable_queues_and_disable_applies(jbox):
    rt, bots, env = jbox
    before = (bots / "t" / "bot.yaml").read_text(encoding="utf-8")
    r = cli({**env, "BOT_NAME": "t"}, "automations", "t", "enable", "job")
    assert r.returncode == 0 and "queued" in r.stdout, r.stdout + r.stderr
    assert (bots / "t" / "bot.yaml").read_text(encoding="utf-8") == before
    q = json.loads((rt / "state" / "t.approvals.json").read_text(encoding="utf-8"))
    assert q[0]["path"] == "automations.job.enabled" and q[0]["value"] is True
    # approve it as the operator, then the bot may switch it off again directly
    assert cli(env, "approve", "t", q[0]["id"]).returncode == 0
    assert _enabled(env) is True
    r = cli({**env, "BOT_NAME": "t"}, "automations", "t", "disable", "job")
    assert r.returncode == 0 and "applied" in r.stdout
    assert _enabled(env) is False
