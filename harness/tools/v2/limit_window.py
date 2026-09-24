#!/usr/bin/env python3
"""Has THIS usage-limit block already been announced — by either tool?

Two tools can see the same block, by design:

  * `usage_probe.py` reads the account's rate-limit headers off a ~10-token
    Haiku call, so it knows the moment the API starts rejecting and it gets an
    exact unix reset instant.
  * `usage_monitor.py` reads the limit banner CC writes into the transcript,
    which is the only signal available when the probe cannot run, and it owns
    the auto-resume.

Both are worth keeping. What was not worth keeping is that they each deduped
against THEIR OWN key in the same state file — `probe|<epoch>` versus
`<reset text>|<hit minute>` — so neither could see the other's record and one
block produced two different Telegram messages three minutes apart
(found 19:04 from the monitor, 19:07 from the probe, and the state stamped a
third time at 19:10 — the operator's complaint: "two notifications for the
same thing; once is enough and then wait").

The shared identity is the RESET INSTANT, because that is the one fact both
tools independently derive about the same block. It is compared with a
tolerance rather than for equality: the probe gets `1787332223` off a header
while the monitor parses "7:10pm (Europe/Stockholm)" to a whole minute, so the
two legitimately disagree by seconds — and an exact-match key would let both
through, which is the bug all over again.

Deliberately NOT keyed on the reset TEXT. That string repeats daily and
swallowed a whole block on 2026-08-17 ([[dedupe-key-that-repeats]]); a dedupe
key that recurs is a permanent mute button.

First writer wins, whichever tool that is. The order genuinely varies — the
probe sees a 429 on its own tick, the monitor waits for CC to write the
transcript — and it does not matter which message arrives as long as exactly
one does.
"""
from __future__ import annotations

from datetime import datetime, timedelta

#: How far apart two derived reset instants may be and still be the same block.
#: Generous on purpose: the cost of being too tight is the duplicate this module
#: exists to stop, and the cost of being too loose is only that two genuinely
#: distinct blocks within a quarter of an hour announce once. Real 5-hour and
#: weekly windows are hours apart, so that second case is close to unreachable.
TOLERANCE_MIN = 15


def _parse(value) -> datetime | None:
    if isinstance(value, datetime):
        return value
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def already_announced(state: dict, blocked_until) -> bool:
    """True when the state already records an announced block resetting at
    ~the same instant, and that block has not yet been resumed past.

    `state` is the parsed `memory/metrics/usage_limit_state.json`. Never raises:
    a malformed or absent field means "not announced", so the failure mode is a
    duplicate message rather than a silent block with no alert and no resume.
    """
    if not isinstance(state, dict):
        return False
    if not state.get("last_alerted_window"):
        return False  # nothing has announced anything yet
    # A window already resumed past is finished; a NEW block that happens to
    # reset near the old one must still be announced. `resumed_for` is the
    # right field: it is the one `resume_check` gates on, and BOTH writers pop
    # it when they record a fresh block. `resumed_at` is informational and
    # lingers after a resume, so keying on it would read every later block as
    # un-announced — the duplicate, straight back.
    if state.get("resumed_for"):
        return False
    prev, cur = _parse(state.get("blocked_until")), _parse(blocked_until)
    if prev is None or cur is None:
        return False
    if (prev.tzinfo is None) != (cur.tzinfo is None):
        # Comparing naive to aware raises; treat as unknown rather than crash.
        return False
    return abs(cur - prev) <= timedelta(minutes=TOLERANCE_MIN)


def announce_text(reset_label: str, detail: str = "") -> str:
    """The ONE limit message. Both tools send this exact text.

    The other half of the operator's complaint — "why TWO diff ones" — was
    not just that two messages arrived, but that they said different things
    about the same event ("⚠️ usage limit reached … resets 7:10pm" versus
    "🚫 limit reached. Blocked until 19:10"). Reading them, you cannot tell
    whether that is one block or two. Even with the dedupe above, whichever
    tool wins the race should produce an identical message, so the wording can
    never again be the thing that makes one event look like two.
    """
    body = (
        f"🚫 *Claude usage limit reached.*\n"
        f"Work is paused until *{reset_label}* — I can't continue before then, "
        f"and neither can a phone session.\n"
        f"Auto-resume is armed: within ~3 min of the reset the supervisor "
        f"relaunches me and I pick the work back up on my own."
    )
    return f"{body}\n\n{detail}" if detail else body
