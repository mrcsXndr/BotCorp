"""v0.8.3: the cockpit's node suites, run through node's own test runner so CI runs them.

- cockpit/tests/inventory.test.mjs: `tools <bot> inventory --json` and
  GET /api/bots/:name/inventory (three groups, toggles, locked guards).
- cockpit/tests/operator-pair.test.mjs: browser pairing (a one-time code, the
  botcorp_operator cookie, the lock, revocation) and the X-Approve-Token still passing.
- cockpit/tests/updates.test.mjs: the release view the Updates modal renders.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

ASSEMBLY = Path(__file__).resolve().parents[2]


@pytest.mark.skipif(shutil.which("node") is None, reason="node not on PATH")
@pytest.mark.parametrize("suite,minimum", [
    ("inventory.test.mjs", 7),
    ("operator-pair.test.mjs", 8),
    ("updates.test.mjs", 4),
])
def test_cockpit_node_suite(suite, minimum):
    env = {**os.environ, "BOT_TG_MUTE": "1"}
    r = subprocess.run(["node", "--test", "--test-reporter=tap", str(ASSEMBLY / "cockpit" / "tests" / suite)],
                       capture_output=True, text=True, encoding="utf-8", timeout=300, cwd=str(ASSEMBLY), env=env)
    out = r.stdout + r.stderr
    assert r.returncode == 0, out
    passed = re.search(r"^# pass (\d+)$", out, re.M)
    failed = re.search(r"^# fail (\d+)$", out, re.M)
    # zero collected is a suite error, not a pass
    assert passed and int(passed.group(1)) >= minimum, out
    assert failed and int(failed.group(1)) == 0, out
