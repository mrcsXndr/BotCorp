"""v0.7.6: cockpit attachments, run through node's own test runner.

cockpit/tests/attach.test.mjs locks:
- an upload is operator-gated, one allow-listed file (images, PDF, text, code)
  of at most 20 MB, kept as <bot>/.botcorp/uploads/<stamp>-<safe name> in a
  folder that ignores itself; a .exe is refused and a `../` name stays inside;
- a sent message is the text, then one `[attached: <path> (<type>, <size>)]`
  line per file; only an existing image inside the uploads folder is pasted;
- the composer mirrors the allow-list and cap, and its chips are text, never markup.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

from _node import needs_node_ts

ASSEMBLY = Path(__file__).resolve().parents[2]
SUITE = ASSEMBLY / "cockpit" / "tests" / "attach.test.mjs"


@pytest.mark.skipif(shutil.which("node") is None, reason="node not on PATH")
@needs_node_ts
def test_cockpit_attach_suite():
    env = {**os.environ, "BOT_TG_MUTE": "1"}
    r = subprocess.run(["node", "--test", "--test-reporter=tap", str(SUITE)],
                       capture_output=True, text=True, encoding="utf-8", timeout=180, cwd=str(ASSEMBLY), env=env)
    out = r.stdout + r.stderr
    assert r.returncode == 0, out
    passed = re.search(r"^# pass (\d+)$", out, re.M)
    failed = re.search(r"^# fail (\d+)$", out, re.M)
    # zero collected is a suite error, not a pass
    assert passed and int(passed.group(1)) >= 9, out
    assert failed and int(failed.group(1)) == 0, out
