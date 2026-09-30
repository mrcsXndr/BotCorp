"""v0.7.5: the cockpit's card decisions, run through node's own test runner.

cockpit/tests/cards.test.mjs locks (cockpit/public/cards.js, evaluated verbatim):
- a background bot never gets Stop: Restart always, Start only while stopped;
  a pty bot gets Stop and Restart while it runs, Start when it does not;
- a pending approval reads as a title, what it widens (secrets, senders,
  account, exposure, tools, jobs) and who asked;
- the context bar is used / compaction ceiling, clamped, levelled;
- the account shows its registered name, the token's last 4 only in the title.
"""
from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

from _node import needs_node_ts

ASSEMBLY = Path(__file__).resolve().parents[2]
SUITE = ASSEMBLY / "cockpit" / "tests" / "cards.test.mjs"


@pytest.mark.skipif(shutil.which("node") is None, reason="node not on PATH")
@needs_node_ts
def test_cockpit_cards_suite():
    r = subprocess.run(["node", "--test", "--test-reporter=tap", str(SUITE)],
                       capture_output=True, text=True, encoding="utf-8", timeout=120, cwd=str(ASSEMBLY))
    out = r.stdout + r.stderr
    assert r.returncode == 0, out
    passed = re.search(r"^# pass (\d+)$", out, re.M)
    failed = re.search(r"^# fail (\d+)$", out, re.M)
    # zero collected is a suite error, not a pass
    assert passed and int(passed.group(1)) >= 5, out
    assert failed and int(failed.group(1)) == 0, out
