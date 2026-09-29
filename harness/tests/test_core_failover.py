"""v0.8.0: the account failover engine (core/failover.mjs), run through node's own test runner.

core/tests/failover.test.mjs locks:
- LIMIT_RE recognises a usage-limit block (the live "rate limited ... resets
  4:30pm (Europe/Stockholm)" text, a weekly text) and not a login or a question;
- classifyBlock takes the reset instant from status.json rate_limits when a
  window is at 100 % (and after the block), else from the text's clock in the
  named zone, rolled forward from the block time, else since + 5 h;
- selectAccount: chain order, failover from a limited primary, failback after
  the reset plus the dwell, wait until the earliest reset when everything is
  limited, hold at the 4th switch in 6 h, failed accounts skipped, recover once
  the active account's reset has passed;
- decide: the active account from state, then the launch record, then the primary.
"""
from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

ASSEMBLY = Path(__file__).resolve().parents[2]
SUITE = ASSEMBLY / "core" / "tests" / "failover.test.mjs"


@pytest.mark.skipif(shutil.which("node") is None, reason="node not on PATH")
def test_core_failover_suite():
    r = subprocess.run(["node", "--test", "--test-reporter=tap", str(SUITE)],
                       capture_output=True, text=True, encoding="utf-8", timeout=120, cwd=str(ASSEMBLY))
    out = r.stdout + r.stderr
    assert r.returncode == 0, out
    passed = re.search(r"^# pass (\d+)$", out, re.M)
    failed = re.search(r"^# fail (\d+)$", out, re.M)
    # zero collected is a suite error, not a pass
    assert passed and int(passed.group(1)) >= 12, out
    assert failed and int(failed.group(1)) == 0, out
