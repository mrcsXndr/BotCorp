"""v0.8.0: usage-limit recovery and `botcorp accounts failover`.

Locked behaviour (core/failover.mjs, daemon/tick.ps1, cli/botcorp.mjs):
- a bg session whose job record is blocked on a usage limit (observe:
  blocked.kind 'limit') is the daemon's to answer: once the reset instant has
  passed and the record still says blocked, the tick restarts it (--resume, the
  conversation kept) with reason `usage-limit reset (...)`; before the reset it
  waits and logs quietly; a -DryRun tick writes no resume prompt;
- Test-SessionBusy -LimitBlocked reads a limited session as idle whatever the
  transcript says (its model calls are rejected: there is no live work);
- `accounts failover <bot>` prints the chain and the decision and never writes;
  `--json` carries `decision.action`.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest

from test_cc_gate import _ps, _tick_dry, needs_pwsh, tick_box  # noqa: F401 (tick_box is a fixture)
from test_operator_only import ASSEMBLY, cli, make_bot, needs_node, operator_env

LIMIT = "rate limited — wait and retry · You've hit your session limit · resets 4:30pm (Europe/Stockholm)"


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _limit_block(cfg_dir, since: datetime) -> None:
    """Claude Code's own job record for bg_id abcd1234: blocked on a usage limit since `since`."""
    job = cfg_dir / "jobs" / "abcd1234"
    job.mkdir(parents=True, exist_ok=True)
    (job / "state.json").write_text(json.dumps({"state": "blocked", "tempo": "blocked", "needs": LIMIT, "sessionId": "S1",
                                                "updatedAt": _iso(since), "inFlight": {"tasks": 0, "queued": 0}}), encoding="utf-8")


# --- tick ------------------------------------------------------------------------------------
@needs_pwsh
def test_tick_dryrun_recovers_once_the_reset_has_passed(tick_box):
    # blocked 26 h ago: "resets 4:30pm" resolved from the block time is yesterday's, long past
    _limit_block(tick_box["home"] / ".claude-alpha", datetime.now(timezone.utc) - timedelta(hours=26))
    log = _tick_dry(tick_box)
    assert "blocked='rate limited" in log and "(usage limit)" in log, log[-3000:]
    assert "DRYRUN would restart alpha" in log and "(usage-limit reset (own:alpha reset at" in log, log[-3000:]
    assert not (tick_box["home"] / ".claude" / ".botcorp_resume_prompt").exists()   # a dry run writes nothing
    assert "account_roll_at" not in (tick_box["rt"] / "state" / "alpha.json").read_text(encoding="utf-8-sig")


@needs_pwsh
def test_tick_dryrun_waits_before_the_reset(tick_box):
    _limit_block(tick_box["home"] / ".claude-alpha", datetime.now(timezone.utc))
    log = _tick_dry(tick_box)
    assert "usage-limited: own:alpha limited until" in log and "waiting until" in log, log[-3000:]
    assert "DRYRUN would restart" not in log, log[-3000:]


@needs_pwsh
def test_session_busy_bypass_for_a_limited_session(tick_box):
    """A fresh transcript reads BUSY; the same session measured usage-limited reads idle."""
    home = tick_box["home"]
    (home / ".claude" / ".botcorp_breakpoint").unlink()
    slug = str(home).replace("\\", "-").replace(":", "-").replace("/", "-")
    proj = home / ".claude-alpha" / "projects" / "".join(c if c.isalnum() else "-" for c in str(home))
    proj.mkdir(parents=True)
    (proj / "S1.jsonl").write_text('{"type":"user"}\n', encoding="utf-8")
    del slug
    env = tick_box["env"]
    assert _ps("Test-SessionBusy -Bot alpha", env) == "True"
    assert _ps("Test-SessionBusy -Bot alpha -LimitBlocked", env) == "False"


# --- cli -------------------------------------------------------------------------------------
@pytest.fixture
def fbox(tmp_path):
    rt, bots = tmp_path / "rt", tmp_path / "bots"
    (rt / "state").mkdir(parents=True)
    make_bot(bots, "fx")
    env = operator_env(rt, bots)

    def blocked(since: datetime) -> None:
        observed = {"bot": "fx", "alive": True, "activity": "blocked", "phase": "blocked", "kind": "bg", "bg_id": "abcd1234",
                    "blocked": {"level": "FAIL", "kind": "limit", "needs": LIMIT, "since": _iso(since)}, "at": _iso(datetime.now(timezone.utc)), "quiet_s": 900}
        (rt / "state" / "fx.json").write_text(json.dumps({"bot": "fx", "bg_id": "abcd1234", "observed": observed}), encoding="utf-8")
    return rt, bots, env, blocked


@needs_node
def test_cli_failover_prints_the_chain_and_the_decision_and_never_writes(fbox):
    rt, bots, env, blocked = fbox
    blocked(datetime.now(timezone.utc))
    r = cli(env, "accounts", "failover", "fx")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "chain: own:fx (own token) ACTIVE limited until" in r.stdout and "decision: would wait until" in r.stdout, r.stdout
    assert "never writes" in r.stdout
    j = json.loads(cli(env, "accounts", "failover", "fx", "--json").stdout)
    assert j["active"] == "own:fx" and j["limited"] is True and j["window"] == "5h" and j["source"] == "text"
    assert j["decision"]["action"] == "wait" and j["decision"]["waitUntil"] == j["resetAt"]
    assert not (rt / "state" / "accounts.json").exists()
    # the reset passed -> recover on the same account
    blocked(datetime.now(timezone.utc) - timedelta(hours=26))
    j = json.loads(cli(env, "accounts", "failover", "fx", "--json").stdout)
    assert j["decision"]["action"] == "recover" and j["decision"]["to"] == "own:fx"
    assert "would restart fx on own:fx" in cli(env, "accounts", "failover", "fx").stdout
    # not blocked: nothing to do
    (rt / "state" / "fx.json").write_text(json.dumps({"bot": "fx", "observed": {"alive": True, "phase": "idle", "blocked": None}}), encoding="utf-8")
    j = json.loads(cli(env, "accounts", "failover", "fx", "--json").stdout)
    assert j["limited"] is False and j["decision"]["action"] == "none"


@needs_node
def test_cli_failover_takes_the_ticks_fresh_observation_from_the_env(fbox):
    rt, bots, env, blocked = fbox
    observed = {"bot": "fx", "alive": True, "phase": "blocked", "blocked": {"level": "FAIL", "kind": "limit", "needs": LIMIT, "since": _iso(datetime.now(timezone.utc) - timedelta(hours=26))}}
    j = json.loads(cli({**env, "BOTCORP_FAILOVER_OBSERVED": json.dumps(observed)}, "accounts", "failover", "fx", "--json").stdout)
    assert j["limited"] is True and j["decision"]["action"] == "recover"
