"""Context is measured against the compaction ceiling, not the raw model window.

A bot launched with CLAUDE_CODE_AUTO_COMPACT_WINDOW=500000 on a 1M model used to
read "ctx 483K/1.0M (48%)" when it was at 97% of where it compacts. The footer
(status_footer.py) and the statusline (statusline.js) share one rule; both are
checked here.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from pathlib import Path

import pytest

import status_footer

STATUSLINE = Path(__file__).resolve().parents[1] / "tools" / "infra" / "statusline.js"


@pytest.fixture
def footer(tmp_path, monkeypatch):
    monkeypatch.delenv("CLAUDE_CODE_AUTO_COMPACT_WINDOW", raising=False)
    monkeypatch.delenv("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", raising=False)
    status = tmp_path / "status.json"
    monkeypatch.setattr(status_footer, "STATUS_JSON", status)

    def write(size: int, used: int) -> None:
        status.write_text(json.dumps({
            "ts": time.time(),
            "model": {"id": "claude-test-1"},
            "context_window": {
                "context_window_size": size,
                "current_usage": {"input_tokens": used - 3000, "cache_read_input_tokens": 2000,
                                  "cache_creation_input_tokens": 1000},
            },
        }), encoding="utf-8")
    return write


def ctx_segment(line: str) -> str:
    return next(p for p in line.split(" · ") if p.startswith("ctx "))


def test_env_window_is_the_ceiling(footer, monkeypatch):
    footer(1_000_000, 483_000)
    monkeypatch.setenv("CLAUDE_CODE_AUTO_COMPACT_WINDOW", "500000")
    assert status_footer._context_window()[:2] == (483_000, 500_000)
    assert ctx_segment(status_footer.build_footer(short=True)) == "ctx 483K/500K (97%)"


def test_settings_autocompactwindow_when_no_env(footer):
    footer(1_000_000, 157_000)
    settings = Path(os.environ["CLAUDE_CONFIG_DIR"]) / "settings.json"
    settings.parent.mkdir(parents=True, exist_ok=True)
    settings.write_text(json.dumps({"autoCompactWindow": 500_000}), encoding="utf-8")
    assert ctx_segment(status_footer.build_footer(short=True)) == "ctx 157K/500K (31%)"


def test_pct_override_scales_the_window(footer, monkeypatch):
    footer(1_000_000, 250_000)
    monkeypatch.setenv("CLAUDE_CODE_AUTO_COMPACT_WINDOW", "1000000")
    monkeypatch.setenv("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", "50")
    assert status_footer._compact_ceiling(1_000_000) == 500_000
    assert ctx_segment(status_footer.build_footer(short=True)) == "ctx 250K/500K (50%)"


def test_model_window_caps_and_backs_up_the_ceiling(footer, monkeypatch):
    # Nothing configured: the model window itself is the ceiling.
    footer(200_000, 100_000)
    assert ctx_segment(status_footer.build_footer(short=True)) == "ctx 100K/200K (50%)"
    # A configured window larger than the model's is capped at the model's.
    monkeypatch.setenv("CLAUDE_CODE_AUTO_COMPACT_WINDOW", "500000")
    assert status_footer._compact_ceiling(200_000) == 200_000
    # No size known (transcript fallback) and nothing configured: 500000.
    monkeypatch.delenv("CLAUDE_CODE_AUTO_COMPACT_WINDOW")
    assert status_footer._compact_ceiling() == 500_000


def run_statusline(tmp_path, payload: dict, **env) -> tuple[str, dict]:
    node = shutil.which("node")
    if not node:
        pytest.skip("node not on PATH")
    e = {k: v for k, v in os.environ.items()
         if k not in ("CLAUDE_CODE_AUTO_COMPACT_WINDOW", "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE")}
    e.update(env)
    e["BOT_HAS_TG"] = "0"
    r = subprocess.run([node, str(STATUSLINE)], input=json.dumps(payload), env=e,
                       capture_output=True, text=True, encoding="utf-8", timeout=30)
    assert r.returncode == 0, r.stderr
    status = json.loads((Path(e["CLAUDE_CONFIG_DIR"]) / "botcorp" / "status.json").read_text(encoding="utf-8"))
    return r.stdout.strip(), status


def test_statusline_shows_used_against_the_ceiling(tmp_path):
    cw = {"context_window_size": 1_000_000, "remaining_percentage": 51.7,
          "current_usage": {"input_tokens": 480_000, "cache_read_input_tokens": 2000,
                            "cache_creation_input_tokens": 1000}}
    payload = {"model": {"display_name": "Test"}, "workspace": {"current_dir": str(tmp_path)},
               "context_window": cw}
    line, status = run_statusline(tmp_path, payload, CLAUDE_CODE_AUTO_COMPACT_WINDOW="500000")
    assert "[██████████] ctx 483K/500K (97%)" in line, line
    assert "52%" not in line
    # status.json keeps its shape: CC's context_window copied verbatim.
    assert status["context_window"] == cw

    line, _ = run_statusline(tmp_path, payload, CLAUDE_CODE_AUTO_COMPACT_WINDOW="1000000",
                             CLAUDE_AUTOCOMPACT_PCT_OVERRIDE="50")
    assert "ctx 483K/500K (97%)" in line, line


def test_statusline_reads_settings_window(tmp_path):
    cfg = Path(os.environ["CLAUDE_CONFIG_DIR"])
    cfg.mkdir(parents=True, exist_ok=True)
    (cfg / "settings.json").write_text(json.dumps({"autoCompactWindow": 500_000}), encoding="utf-8")
    payload = {"model": {"display_name": "Test"}, "workspace": {"current_dir": str(tmp_path)},
               "context_window": {"context_window_size": 1_000_000,
                                  "current_usage": {"input_tokens": 157_000}}}
    line, _ = run_statusline(tmp_path, payload)
    assert "[███░░░░░░░] ctx 157K/500K (31%)" in line, line
