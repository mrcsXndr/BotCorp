"""The cockpit's running / blocked / Telegram state, run through node's own test runner.

cockpit/tests/bot-liveness.test.mjs locks:
- a live claude --bg session with no pty-host reads as running (the cockpit
  used to read `running: !!pty`, so a bg bot showed "stopped" and Start stayed
  enabled on a live session: a second session means two Telegram pollers);
- a state file that says running with a dead claude reads as stopped, with the
  doctor's reason;
- blocked = the bg job record waits on a person (doctor `session not blocked`);
- the Telegram poller is up only when OWNED (bot.pid alive under the session).
"""
from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

ASSEMBLY = Path(__file__).resolve().parents[2]
SUITE = ASSEMBLY / "cockpit" / "tests" / "bot-liveness.test.mjs"


@pytest.mark.skipif(shutil.which("node") is None, reason="node not on PATH")
def test_cockpit_bot_liveness_suite():
    r = subprocess.run(["node", "--test", "--test-reporter=tap", str(SUITE)],
                       capture_output=True, text=True, encoding="utf-8", timeout=120, cwd=str(ASSEMBLY))
    out = r.stdout + r.stderr
    assert r.returncode == 0, out
    passed = re.search(r"^# pass (\d+)$", out, re.M)
    failed = re.search(r"^# fail (\d+)$", out, re.M)
    # zero collected is a suite error, not a pass
    assert passed and int(passed.group(1)) >= 5, out
    assert failed and int(failed.group(1)) == 0, out
