"""R5c step 18: the tick rolls a live bot onto its bot.yaml `account:` only between turns.

Get-AccountRollAction (daemon/_common.ps1) is the pure gate: `none` when the bot
is not alive or its last launch already attempted the wanted account ('' = the
bot's own token), else the Get-CcRollAction gate order: phase idle, provably
between turns (awaiting its next prompt or a fresh breakpoint), no live inbox
drainer, no account roll in the last 30 minutes, then `roll`. A -DryRun tick
reads Attempted from the session launcher's launch-env.json record.
"""
from __future__ import annotations

import json

import pytest

from test_cc_gate import _ps, _sha, _tick_dry, needs_pwsh, tick_box  # noqa: F401 (tick_box is a fixture)

IDLE = {"alive": True, "phase": "idle", "awaiting_prompt": True}


@needs_pwsh
@pytest.mark.parametrize("obs,wanted,attempted,bp,drainer,last_roll,expected", [
    (IDLE, "acc1", "acc1", False, False, "", "none"),                                        # already on it
    ({"alive": False, "phase": "down"}, "acc1", "", True, False, "", "none"),               # not alive
    ({"alive": True, "phase": "working"}, "acc1", "", True, False, "", "defer:phase"),
    ({"alive": True, "phase": "idle"}, "acc1", "", False, False, "", "defer:midturn"),      # quiet only: not provably between turns
    (IDLE, "acc1", "", False, True, "", "defer:drainer"),
    (IDLE, "acc1", "", False, False, "2026-09-26T11:50:00Z", "defer:backoff"),               # rolled 10 minutes ago
    (IDLE, "acc1", "", False, False, "", "roll"),
    ({"alive": True, "phase": "idle"}, "acc1", "", True, False, "", "roll"),                # a fresh breakpoint
    (IDLE, "", "acc1", False, False, "", "roll"),                                            # back to the bot's own token
    (IDLE, "acc2", "acc1", False, False, "2026-09-26T11:20:00Z", "roll"),                   # the backoff has passed
])
def test_account_roll_gate(obs, wanted, attempted, bp, drainer, last_roll, expected):
    body = (f"$o = ConvertFrom-Json -InputObject '{json.dumps(obs)}'\n"
            f"Get-AccountRollAction -Observed $o -Wanted '{wanted}' -Attempted '{attempted}' -Breakpoint ${str(bp).lower()} "
            f"-DrainerLive ${str(drainer).lower()} -LastRollAt '{last_roll}' -Now ([datetime]'2026-09-26T12:00:00Z')")
    assert _ps(body) == expected


@needs_pwsh
@pytest.mark.parametrize("obs,drainer,last_roll,expected", [
    ({"alive": True, "phase": "blocked", "awaiting_prompt": False}, False, "", "roll"),                         # a limited session has no turn to wait for
    ({"alive": True, "phase": "blocked", "awaiting_prompt": False}, True, "", "defer:drainer"),                 # the drainer gate stays
    ({"alive": True, "phase": "blocked", "awaiting_prompt": False}, False, "2026-09-26T11:50:00Z", "defer:backoff"),   # so does the backoff
    ({"alive": True, "phase": "working"}, False, "", "roll"),                                                    # phase is not consulted while limited
])
def test_account_roll_gate_limit_blocked(obs, drainer, last_roll, expected):
    body = (f"$o = ConvertFrom-Json -InputObject '{json.dumps(obs)}'\n"
            f"Get-AccountRollAction -Observed $o -Wanted 'acc1' -Attempted '' -Breakpoint $false -DrainerLive ${str(drainer).lower()} "
            f"-LastRollAt '{last_roll}' -Now ([datetime]'2026-09-26T12:00:00Z') -LimitBlocked")
    assert _ps(body) == expected


@needs_pwsh
def test_account_roll_gate_not_limited_blocked_defers():
    """Without -LimitBlocked a blocked phase still defers: a login or a dialog is not the daemon's to answer."""
    body = ("$o = ConvertFrom-Json -InputObject '{\"alive\": true, \"phase\": \"blocked\"}'\n"
            "Get-AccountRollAction -Observed $o -Wanted 'acc1' -Attempted '' -Breakpoint $false -DrainerLive $false -LastRollAt '' -Now ([datetime]'2026-09-26T12:00:00Z')")
    assert _ps(body) == "defer:phase"


def _on_pin_with_account(t: dict, launched_account: str | None) -> None:
    """tick_box's bot runs the pin (no cc roll), wants `account: acc1`, and its launcher's record attempted launched_account."""
    rt, home = t["rt"], t["home"]
    cc = json.loads((rt / "state" / "cc.json").read_text(encoding="utf-8"))
    cc["pinned"].update(exe=str(t["old"]), sha256=_sha(t["old"]), version="2.1.282")
    (rt / "state" / "cc.json").write_text(json.dumps(cc), encoding="utf-8")
    (home / "bot.yaml").write_text((home / "bot.yaml").read_text(encoding="utf-8") + "account: acc1\n", encoding="utf-8")
    st = json.loads((rt / "state" / "alpha.json").read_text(encoding="utf-8"))
    (rt / "state" / "alpha.json").write_text(json.dumps({**st, "env_launcher_pid": 4242}), encoding="utf-8")
    rec = {"at": "2026-09-26T11:00:00Z", "oauth_source": "vault"}
    if launched_account is not None:
        rec["account"] = launched_account
    (home / ".claude-alpha" / "botcorp").mkdir()
    (home / ".claude-alpha" / "botcorp" / "launch-env.json").write_text(json.dumps({"launches": {"4242": rec}}), encoding="utf-8")


@needs_pwsh
@pytest.mark.parametrize("launched", ["", None])   # the bot's own token; a pre-0.7 record without the key
def test_tick_dryrun_rolls_to_the_wanted_account(tick_box, launched):
    _on_pin_with_account(tick_box, launched)
    log = _tick_dry(tick_box)
    assert "DRYRUN would restart alpha" in log and "(account -> acc1)" in log, log[-3000:]
    assert "cc 2.1.282" not in log, log[-3000:]
    assert "account_roll_at" not in (tick_box["rt"] / "state" / "alpha.json").read_text(encoding="utf-8-sig")   # a dry run records nothing


@needs_pwsh
def test_tick_never_rerolls_an_attempted_account(tick_box):
    _on_pin_with_account(tick_box, "acc1")
    log = _tick_dry(tick_box)
    assert "state: alive=True" in log and "DRYRUN would restart" not in log, log[-3000:]
