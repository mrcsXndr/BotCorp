"""v0.7.7: the per-bot review board (harness.modules.review_board).

Locked behaviour:
- review_board.py refuses every write/read verb (exit 2, no file) while the
  module is off, and refuses any URL that is not a private claude.ai Artifact link.
- one board per bot: a second URL is refused unless --replace.
- status --from-page counts open/answered from the review-state block.
- session start injects the board line only with the module on AND a board recorded.
- turning the module on from a bot session applies at once (not widening);
  a widening change (role: admin) from the same session still queues (the positive control).
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from test_hooks_fake_stdin import base_env, bot_home, run_hook  # noqa: F401  (bot_home is a fixture)
from test_operator_only import cli, make_bot, needs_node, operator_env

TOOL = Path(__file__).resolve().parents[1] / "tools" / "v2" / "review_board.py"
URL = "https://claude.ai/code/artifact/0a1b2c3d-4e5f-6789-abcd-ef0123456789"
URL2 = "https://claude.ai/artifact/9f8e7d6c-5b4a-3210-fedc-ba9876543210"


def tool(tmp_path, bot_home, modules, *args):
    env = base_env(tmp_path, bot_home, {"BOT_MODULES": modules})
    return subprocess.run([sys.executable, str(TOOL), *args], capture_output=True, text=True, env=env, timeout=30)


def record(bot_home):
    return bot_home / ".botcorp" / "review-board.json"


def page(state: dict) -> str:
    return f'<html><body><script id="review-state" type="application/json">{json.dumps(state)}</script></body></html>'


# ---- module off: refuse, write nothing -------------------------------------------------------

@pytest.mark.parametrize("args", [("set-url", URL), ("status", "--open", "3"), ("show",)])
@pytest.mark.parametrize("modules", ["", "telegram,lessons"])
def test_refused_while_the_module_is_off(tmp_path, bot_home, modules, args):
    r = tool(tmp_path, bot_home, modules, *args)
    assert r.returncode == 2, r.stdout + r.stderr
    assert "review_board module is off" in r.stderr
    assert not (bot_home / ".botcorp").exists()


def test_positive_control_module_on_records(tmp_path, bot_home):
    r = tool(tmp_path, bot_home, "telegram,review_board", "set-url", URL)
    assert r.returncode == 0, r.stderr
    rec = json.loads(record(bot_home).read_text(encoding="utf-8"))
    assert rec["url"] == URL and rec["open"] is None and rec["updated"]


# ---- URL validation --------------------------------------------------------------------------

@pytest.mark.parametrize("bad", [
    "http://claude.ai/artifact/0a1b2c3d-4e5f",               # not https
    "https://example.com/artifact/0a1b2c3d-4e5f",            # another host
    "https://claude.ai.evil.example/artifact/0a1b2c3d-4e5f",  # lookalike host
    "https://claude.ai/public/artifacts/0a1b2c3d-4e5f",      # a public share link
    "https://claude.ai/artifact/short",                      # no real id
    "https://claude.ai/artifact/0a1b2c3d-4e5f?x=<script>",   # trailing junk
    "javascript:alert(1)",
])
def test_refuses_a_non_artifact_url(tmp_path, bot_home, bad):
    r = tool(tmp_path, bot_home, "review_board", "set-url", bad)
    assert r.returncode == 2
    assert "not a claude.ai artifact link" in r.stderr
    assert not record(bot_home).exists()


@pytest.mark.parametrize("good", [URL, URL2, URL2 + "/"])
def test_accepts_both_artifact_link_shapes(tmp_path, bot_home, good):
    assert tool(tmp_path, bot_home, "review_board", "set-url", good).returncode == 0


# ---- one board -------------------------------------------------------------------------------

def test_a_second_board_is_refused_unless_replace(tmp_path, bot_home):
    assert tool(tmp_path, bot_home, "review_board", "set-url", URL).returncode == 0
    assert tool(tmp_path, bot_home, "review_board", "status", "--open", "4").returncode == 0
    r = tool(tmp_path, bot_home, "review_board", "set-url", URL2)
    assert r.returncode == 2 and "already has a board" in r.stderr
    assert json.loads(record(bot_home).read_text(encoding="utf-8"))["url"] == URL
    # the same URL again keeps the counts
    assert tool(tmp_path, bot_home, "review_board", "set-url", URL).returncode == 0
    assert json.loads(record(bot_home).read_text(encoding="utf-8"))["open"] == 4
    r = tool(tmp_path, bot_home, "review_board", "set-url", URL2, "--replace")
    assert r.returncode == 0, r.stderr
    rec = json.loads(record(bot_home).read_text(encoding="utf-8"))
    assert rec["url"] == URL2 and rec["open"] is None


# ---- status ----------------------------------------------------------------------------------

def test_status_needs_a_board(tmp_path, bot_home):
    r = tool(tmp_path, bot_home, "review_board", "status", "--open", "1")
    assert r.returncode == 2 and "no board recorded" in r.stderr


def test_status_from_page_counts_listed_items(tmp_path, bot_home):
    tool(tmp_path, bot_home, "review_board", "set-url", URL)
    f = tmp_path / "board.html"
    f.write_text(page({
        "reviewId": "board", "items": ["item-1", "item-2", "item-3"], "sentAt": "2026-09-28T12:52:00Z",
        "answers": {"item-1": {"answer": "yes", "comment": ""}, "item-3": {"answer": "", "comment": "hm"},
                    "item-0": {"answer": "no"}},  # item-0 moved to Done: not counted
        "done": [{"id": "item-0", "did": "shipped", "at": "2026-09-27T10:00:00Z"}],
    }), encoding="utf-8")
    r = tool(tmp_path, bot_home, "review_board", "status", "--from-page", str(f))
    assert r.returncode == 0, r.stderr
    rec = json.loads(record(bot_home).read_text(encoding="utf-8"))
    assert (rec["open"], rec["answered"], rec["sent_at"]) == (2, 1, "2026-09-28T12:52:00Z")


def test_status_from_a_pre_board_page_has_no_open_count(tmp_path, bot_home):
    tool(tmp_path, bot_home, "review_board", "set-url", URL)
    f = tmp_path / "old.html"
    f.write_text(page({"reviewId": "x", "answers": {"item-7": {"answer": "yes", "comment": "", "ts": "t"}}}), encoding="utf-8")
    assert tool(tmp_path, bot_home, "review_board", "status", "--from-page", str(f)).returncode == 0
    rec = json.loads(record(bot_home).read_text(encoding="utf-8"))
    assert rec["open"] is None and rec["answered"] == 1


@pytest.mark.parametrize("args", [("--open", "-1"), ("--open", "3; rm"), ("--from-page", "missing.html")])
def test_status_refuses_bad_input(tmp_path, bot_home, args):
    tool(tmp_path, bot_home, "review_board", "set-url", URL)
    before = record(bot_home).read_text(encoding="utf-8")
    assert tool(tmp_path, bot_home, "review_board", "status", *args).returncode == 2
    assert record(bot_home).read_text(encoding="utf-8") == before


# ---- session start ---------------------------------------------------------------------------

def _context(tmp_path, bot_home, modules, sid):
    proc = run_hook("session-start.sh", base_env(tmp_path, bot_home, {"BOT_MODULES": modules}), json.dumps({"session_id": sid}))
    assert proc.returncode == 0, proc.stderr
    lines = [ln for ln in proc.stdout.splitlines() if ln.strip()]
    return json.loads(lines[-1])["hookSpecificOutput"]["additionalContext"]


def _seed(bot_home, rec):
    record(bot_home).parent.mkdir(parents=True, exist_ok=True)
    record(bot_home).write_text(json.dumps(rec), encoding="utf-8")


def test_session_start_injects_the_board_line_when_on(tmp_path, bot_home):
    _seed(bot_home, {"url": URL, "open": 5, "answered": 2})
    ctx = _context(tmp_path, bot_home, "review_board", "rb1")
    assert ctx.count("Review board:") == 1
    assert f"Review board: {URL} (5 open). Republish to this URL; never start a second board (skill review-artifact)." in ctx.splitlines()


def test_session_start_has_no_board_line_when_off(tmp_path, bot_home):
    _seed(bot_home, {"url": URL, "open": 5})
    assert "Review board:" not in _context(tmp_path, bot_home, "", "rb2")
    assert "Review board:" not in _context(tmp_path, bot_home, "telegram,lessons", "rb3")


def test_session_start_has_no_board_line_without_a_board(tmp_path, bot_home):
    assert "Review board:" not in _context(tmp_path, bot_home, "review_board", "rb4")
    _seed(bot_home, {"url": "https://example.com/x", "open": 1})   # a hand-edited bad record is ignored
    assert "Review board:" not in _context(tmp_path, bot_home, "review_board", "rb5")


# ---- the switch is not widening --------------------------------------------------------------

@pytest.fixture
def box(tmp_path):
    rt, bots = tmp_path / "rt", tmp_path / "bots"
    (rt / "state").mkdir(parents=True)
    make_bot(bots, "t")
    return rt, bots, operator_env(rt, bots)


@needs_node
def test_a_bot_turns_the_board_on_without_an_approval(box):
    rt, bots, env = box
    r = cli({**env, "BOT_NAME": "t"}, "config", "set", "t", "harness.modules.review_board", "true")
    assert r.returncode == 0, r.stdout + r.stderr
    assert not (rt / "state" / "t.approvals.json").exists()
    assert "review_board: true" in (bots / "t" / "bot.yaml").read_text(encoding="utf-8")


@needs_node
def test_positive_control_a_widening_change_still_queues(box):
    rt, bots, env = box
    r = cli({**env, "BOT_NAME": "t"}, "config", "set", "t", "role", "admin")
    assert r.returncode == 0, r.stdout + r.stderr
    assert json.loads((rt / "state" / "t.approvals.json").read_text(encoding="utf-8"))
    assert "role:" not in (bots / "t" / "bot.yaml").read_text(encoding="utf-8")
