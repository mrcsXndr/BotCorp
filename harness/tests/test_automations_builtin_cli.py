"""`botcorp automations` sees the module built-ins the daemon schedules.

With module timeline_summary on, the daemon runs a built-in `timeline-summary`
(daemon/automations.ps1 Get-BuiltinAutomations). The CLI lists it, queues a
run-now for it, and refuses pause/resume by name (the module is the switch).
Without the module the name is unknown, as before.
"""
from __future__ import annotations

import json

import pytest

from test_operator_only import box, cli, needs_node  # noqa: F401

YAML = "name: t\nharness:\n  service: manual\n  modules:\n    timeline_summary: {on}\nautomations: []\n"


def _box(box, on):
    rt, bots, env = box
    (bots / "t" / "bot.yaml").write_text(YAML.format(on=on), encoding="utf-8")
    return rt, env


@needs_node
def test_the_builtin_is_listed_run_and_not_paused(box):
    rt, env = _box(box, "true")
    rows = json.loads(cli(env, "automations", "t", "list", "--json").stdout)["automations"]
    assert [(r["name"], r.get("module")) for r in rows] == [("timeline-summary", "timeline_summary")]
    r = cli(env, "automations", "t", "run", "timeline-summary")
    assert r.returncode == 0 and "queued run-now" in r.stdout, r.stdout + r.stderr
    q = (rt / "state" / "t" / "events" / "run-now.queue").read_text(encoding="utf-8")
    assert json.loads(q.splitlines()[-1])["automation"] == "timeline-summary"
    r = cli(env, "automations", "t", "pause", "timeline-summary")
    assert r.returncode != 0 and "harness.modules.timeline_summary" in r.stdout + r.stderr


@needs_node
def test_without_the_module_the_name_is_unknown(box):
    rt, env = _box(box, "false")
    assert json.loads(cli(env, "automations", "t", "list", "--json").stdout)["automations"] == []
    r = cli(env, "automations", "t", "run", "timeline-summary")
    assert r.returncode != 0 and "no 'timeline-summary'" in r.stdout + r.stderr
