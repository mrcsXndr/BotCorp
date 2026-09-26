"""v0.1.17: the cockpit chat view, run through node's own test runner.

cockpit/tests/chat-render.test.mjs locks:
- chat markdown (cockpit/public/md.js, evaluated verbatim) is XSS-safe: every
  payload renders to whitelisted tags only, hrefs are http(s)/mailto with
  rel="noopener noreferrer" target="_blank"; the same check FAILS on naive
  renderers, so it can fail;
- Telegram <channel> messages render as user turns with a source/user/time
  meta and media markers (never a path); a <task-notification> becomes a task
  card (summary, status, usage, result; never the output-file path or ids)
  whose result renders through md.js; system-reminder and isMeta wrappers do
  not render;
- the header chips (cockpit/chatstatus.mjs) read status.json, bot.yaml,
  session-env/launch-env and .claude.json, and say why when a value is missing;
- statusline.js records the session's effort in status.json;
- the composer's sent message and its inbox status line (cockpit/public/inbox.js)
  render every XSS payload as text, on a DOM that refuses innerHTML.
"""
from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

ASSEMBLY = Path(__file__).resolve().parents[2]
SUITE = ASSEMBLY / "cockpit" / "tests" / "chat-render.test.mjs"


@pytest.mark.skipif(shutil.which("node") is None, reason="node not on PATH")
def test_cockpit_chat_render_suite():
    r = subprocess.run(["node", "--test", "--test-reporter=tap", str(SUITE)],
                       capture_output=True, text=True, encoding="utf-8", timeout=120, cwd=str(ASSEMBLY))
    out = r.stdout + r.stderr
    assert r.returncode == 0, out
    passed = re.search(r"^# pass (\d+)$", out, re.M)
    failed = re.search(r"^# fail (\d+)$", out, re.M)
    # zero collected is a suite error, not a pass
    assert passed and int(passed.group(1)) >= 24, out
    assert failed and int(failed.group(1)) == 0, out
