"""R5a step 4: `botcorp approvals [--json]` lists every bot's pending entries.

Each row: id, bot, requested_by, at, op, path, value (a summary), diff (the
human before -> after the cockpit shows) and why. Read-only, so it runs from a
bot session too.
"""
from __future__ import annotations

import json

from test_operator_only import box, cli, make_bot, needs_node, queue  # noqa: F401


@needs_node
def test_two_bots_one_entry_each(box):
    rt, bots, env = box
    make_bot(bots, "u")
    queue(rt, "t", [{"id": "aaa111", "ts": "2026-09-27T01:00:00Z", "path": "harness.modules.remote_control",
                     "value": True, "requested_by": "bot:t", "reason": "enables Remote Control"}])
    queue(rt, "u", [{"id": "bbb222", "ts": "2026-09-27T02:00:00Z", "op": "append", "path": "secrets",
                     "value": "gh_token", "requested_by": "bot:u", "reason": "declares a new vault secret"}])
    r = cli({**env, "BOT_NAME": "t"}, "approvals", "--json")
    assert r.returncode == 0, r.stderr
    rows = json.loads(r.stdout)
    assert len(rows) == 2
    by_bot = {row["bot"]: row for row in rows}
    assert by_bot["t"]["diff"] == "harness.modules.remote_control: false -> true"
    assert by_bot["t"]["why"] == "enables Remote Control" and by_bot["t"]["op"] == "set"
    assert by_bot["u"]["diff"] == "secrets: + gh_token"
    assert by_bot["u"]["why"] == "declares a new vault secret" and by_bot["u"]["op"] == "append"
    for row in rows:
        assert {"id", "bot", "requested_by", "at", "op", "path", "value", "diff", "why"} <= set(row)


@needs_node
def test_empty_queue(box):
    rt, bots, env = box
    r = cli(env, "approvals", "--json")
    assert r.returncode == 0 and json.loads(r.stdout) == []
    r = cli(env, "approvals")
    assert "none pending" in r.stdout
